/**
 * ⚠️ 这是**旧实现**的固化副本：订单列表逐单翻页求和。
 *   已被 src/fetch-meituan-income.mjs（平台聚合）取代。
 *   保留原因：它是**逐单基准**，用于口径对账（src/compare-income.mjs）。
 *   输出：data/raw/income-orderlist-<account>.json（不覆盖新实现的结果）
 *
 * 由 src/legacy/_make-orderlist-version.mjs 生成，请勿手改。
 */
/**
 * 美团「预计收入」取数（口径唯一来源）
 *   node src/fetch-meituan-income.mjs [--account=quanyi|yifeng] [--days=30]
 *
 * ⭐ 为什么必须有这个脚本：
 *   用户口径 —— 看板所有收入一律用**预计收入**（不是成交额）。
 *   而 manageHome/core 的 `multiProjectedIncome` 实测**两个账号都是 null**，
 *   预计收入只能从「全部订单」页拿（与用户说的「美团今日预计收入在全部订单订单页」一致）。
 *
 * 数据来源：
 *   ① 今日汇总  POST /api/retail/v3/order/todayOrderSummary/query  → settleIncome
 *   ② 区间逐单  POST /gw/api/unified/r/order/list/page/history
 *       每单 orderInfo.orderChargeBlockBO.finalSettlementAmount = 单笔预计收入
 *
 * ✅ 已标定（两账号 diff 均为 0.00）：
 *   预计收入 = Σ finalSettlementAmount over orderStatus ≠ 9
 *   status: 8=已完成  4=处理中  9=已取消
 *   validOrderCount = count(8) + count(4) = 官方口径
 *
 * 落盘 data/raw/income-<account>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectToPage, evaluate, waitSignedReady } from "../lib/cdp.mjs";
import { loadCookieSmart } from "../lib/cookie.mjs";
import { resolveAccount, dataPath } from "../lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = acct.port;
const DAYS = Number(arg("days", "30"));
const PAGE_SIZE = Number(arg("pageSize", "100"));
const ONLY = arg("only", ""); // 逗号分隔的窗口 key（today,yesterday,d7,d30）；空=全跑
/**
 * 逐店聚合开关。
 *   `--byPoi=近7天,近30天`  → 只在这些**汇总窗口**输出 byPoi
 *   `--byPoiAll=1`          → 每个窗口、每一天都输出 byPoi
 *
 * 为什么要 byPoiAll：看板要「任意窗口的高取消门店」。
 * 逐日都带 byPoi，看板就能自己把日粒度合并成 7天/30天，
 * 不用为每个窗口再单独翻一遍订单（30 天单店聚合 ≈ 400 KB，可以接受）。
 */
const byPoiWindows = (arg("byPoi", `近7天`) || "").split(",").map((s) => s.trim()).filter(Boolean);
const byPoiAll = arg("byPoiAll", "") === "1";

/** ISO 日期（东八区；绝不用 toISOString，晚 8 点后会跳天） */
const iso = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const OUT = dataPath(acct, "income-orderlist");

const cdp = await connectToPage(PORT);
console.log(`账号 ${acct.label}（${acct.key}）  端口 ${PORT}`);

/** ⭐ 优先读浏览器 profile 里的活 cookie（会自动续期），回退静态文件 */
const { cookies: CK } = await loadCookieSmart({
  stem: STEM,
  port: PORT,
  host: "yiyao.meituan.com",
  required: ["token", "acctId"],
});
const ACCT_ID = CK.acctId;
console.log(`acctId = ${ACCT_ID}`);

/**
 * ⚠️ 显式导航 + 等签名就绪。
 * 不导航时页内 fetch 会打到当前 origin 上，返回 HTML 登录页，
 * 报 `Unexpected token '<'` —— 看起来像 cookie 过期，其实是域不对。
 */
/**
 * ⚠️⚠️ **必须停在订单页**，不能停在 `/main/frame`。
 *
 * 实测（2×2 矩阵，同一浏览器同一时刻）：
 *   POST order/list/page/history  从 `/main/frame` 发起  → {"code":1,"msg":"列表标签错误"}
 *                                 从订单页  发起         → {"code":0,"msg":"success"} 92 单
 * 订单列表的 `history_all` 标签**只有在订单页的微应用加载后才会注册**。
 *
 * 之前它「有时候能跑」是因为那个浏览器实例早先逛过订单页、标签已注册；
 * 浏览器一重启就必然失败。我一度误判成「取数太早的竞态」并加了重试，
 * 那只是掩盖症状（重试还会把 CDP 45s 超时撞破）。
 * URL 上的 `yodaReady=h5&csecplatform=4` **无关紧要**，矩阵里四种组合证明了这点。
 */
const ORDER_PAGE = "https://yiyao.meituan.com/main/frame#/page/orderbusiness#/order/history";
await cdp.send("Page.navigate", { url: ORDER_PAGE });
const ready = await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 });
console.log(`🔏 签名链路就绪（${ready.waitedMs}ms，已停在订单页）`);

/** 订单状态码 → 语义（由官方 todayOrderSummary 反推，勿改） */
const STATUS = { 8: "已完成", 4: "处理中", 9: "已取消" };
const CANCELLED = new Set([9]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(start, end, pageNum) {
  const raw = await evaluate(
    cdp,
    `(async () => {
       const sleep = (ms) => new Promise(r => setTimeout(r, ms));
       const body = new URLSearchParams({
         tag:'history_all',
         pageParam: JSON.stringify({pageSize:${PAGE_SIZE},pageNum:${pageNum},sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
         extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
         startDate:'${start}', endDate:'${end}',
       });
       /**
        * ⚠️ 必须重试。实测：页面刚导航完、签名接口已经 200，订单列表仍会返回
        *    {"code":1,"msg":"列表标签错误","data":null}
        *    —— 「签名链路就绪」≠「订单列表的 tag 注册表就绪」，页面还要再初始化一会儿。
        *    不重试的表现是「今日取回 0 单 / totalCount=null」，极易误判成 cookie 失效或没订单。
        *    同一个请求过几秒再打就正常（已用 2×2 矩阵验证：页面上下文与 URL 参数都不是原因）。
        */
       let last = null;
       for (let attempt = 1; attempt <= 10; attempt++) {
         const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
           method:'POST', credentials:'include',
           headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
         const txt = await r.text();
         let j = null;
         try { j = JSON.parse(txt); } catch (e) {}
         if (j && j.code === 0) return txt;
         last = txt.slice(0, 200);
         await sleep(1200 * attempt);
       }
       throw new Error('订单列表连续 10 次未就绪，最后响应：' + last);
     })()`,
    // 页内 10 次退避重试（光 sleep 最多 66s）会撞破默认 45s CDP 超时
    { timeoutMs: 240_000 },
  );
  const j = JSON.parse(raw);
  const list = j.data?.orderList ?? [];
  const page = j.data?.pageInfo ?? {};
  const rows = list.map((x) => {
    let ci = {}, oi = {};
    try { ci = JSON.parse(x.commonInfo); } catch { /* ignore */ }
    try { oi = JSON.parse(x.orderInfo); } catch { /* ignore */ }
    const ch = oi.orderChargeBlockBO ?? {};
    /**
     * ⚠️ 门店信息**不在 commonInfo**（41 个键里一个 poi 字段都没有），
     *    在 `orderInfo.unifiedBasicInfo`。早期版本取 commonInfo.wmPoiId 恒为空，
     *    门店维度全部落到 "?" 上（表现为「今日取消门店只有 1 家」这种假结论）。
     */
    const ub = oi.unifiedBasicInfo ?? {};
    return {
      orderTime: ci.order_time ?? null, // epoch 秒
      status: ci.orderStatus,
      income: Number(ch.finalSettlementAmount ?? 0),
      userPay: Number(ch.userPayTotalAmount ?? 0),
      poiId: ub.wmPoiId ?? null,
      poiName: ub.wmPoiName ?? ub.poiName ?? null,
      poiCity: ub.wmPoiCityName ?? null,
    };
  });
  return { rows, total: page.total ?? page.totalCount ?? null, pageCount: page.pageCount ?? null };
}

/** 取某个日期区间的全部订单并聚合 */
async function sumRange(start, end, label) {
  let pageNum = 1;
  const all = [];
  /** 循环外声明：循环结束后还要用它判断「是否取全了」 */
  let total = null;
  for (;;) {
    const { rows, total: t, pageCount } = await fetchPage(start, end, pageNum);
    if (t != null) total = t;
    /**
     * ⚠️ **不要**用 `rows.length < PAGE_SIZE` 作为唯一终止条件。
     * 实测该接口偶发「少返回若干条」（例：totalCount=227，page1 给 100、page2 只给 86），
     * 用短页判断就会**静默少取 41 单**，还不报错 —— 看板上表现为某天收入莫名偏低。
     * 终止以 totalCount / pageCount 为准；短页只在两者都不知道时才认。
     */
    if (rows.length) all.push(...rows);
    process.stdout.write(`\r  ${label} 已取 ${all.length}${total ? "/" + total : ""} 单…   `);
    if (total != null && all.length >= total) break;
    if (pageCount && pageNum >= pageCount) break;
    if (!rows.length) break;
    if (!total && !pageCount && rows.length < PAGE_SIZE) break;
    if (pageNum > 400) break; // 安全阀
    pageNum++;
    await sleep(220);
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  if (total != null && all.length < total) {
    console.log(`  ⚠️ ${label} 只取到 ${all.length}/${total} 单（接口短页），该窗口数字可能偏低`);
  }

  const add = (a, b) => a + (isFinite(b) ? b : 0);
  const income = all.reduce((s, x) => s + add(0, x.income), 0);
  const userPay = all.reduce((s, x) => s + add(0, x.userPay), 0);
  const valid = all.filter((x) => !CANCELLED.has(x.status));
  const incomeExCancelled = valid.reduce((s, x) => s + add(0, x.income), 0);
  const userPayExCancelled = valid.reduce((s, x) => s + add(0, x.userPay), 0);

  const byStatus = {};
  for (const x of all) {
    const a = (byStatus[x.status] ??= { count: 0, income: 0, label: STATUS[x.status] ?? `status${x.status}` });
    a.count++;
    a.income += add(0, x.income);
  }

  const cancelCount = all.filter((x) => CANCELLED.has(x.status)).length;

  /**
   * 按门店聚合 —— 供「近 7 天高取消单占比门店」用。
   * 只对指定窗口算（`byPoiWindows`），否则 30 天 × 上百家店会把 JSON 撑得很大。
   */
  let byPoi = null;
  if (byPoiAll || byPoiWindows.includes(label)) {
    const m = new Map();
    for (const x of all) {
      const k = String(x.poiId ?? "?");
      const a = m.get(k) ?? { poiId: k, poiName: x.poiName ?? "", orders: 0, cancel: 0, income: 0 };
      a.orders++;
      if (CANCELLED.has(x.status)) a.cancel++;
      else a.income += add(0, x.income);
      m.set(k, a);
    }
    byPoi = [...m.values()]
      .map((a) => ({
        ...a,
        rate: a.orders ? Number((a.cancel / a.orders).toFixed(4)) : 0,
        income: Number(a.income.toFixed(2)),
      }))
      .sort((a, b) => b.cancel - a.cancel || b.rate - a.rate);
  }

  return {
    label, start, end,
    orderCount: all.length,
    validOrderCount: valid.length,
    cancelCount,
    cancelRate: all.length ? cancelCount / all.length : 0,
    /** ⭐ 口径：预计收入 = 剔除已取消后求和 */
    projectedIncome: Number(incomeExCancelled.toFixed(2)),
    projectedIncomeAll: Number(income.toFixed(2)),
    cancelIncome: Number((income - incomeExCancelled).toFixed(2)),
    userPay: Number(userPayExCancelled.toFixed(2)),
    avgOrderValue: valid.length ? Number((incomeExCancelled / valid.length).toFixed(2)) : 0,
    byStatus,
    byPoi,
  };
}

// ════════ 窗口定义 ════════
/**
 * 固定四个窗口 —— 看板的切换器就是这四个，标签必须一一对应。
 * 早期版本用 `d${DAYS}` 生成 key，`--days=30` 时压根没有「近7天」这个窗口，
 * 结果 `--byPoi=近7天` 匹配不上、静默拿到 null（看板高取消门店直接空白）。
 * 别再用参数拼窗口 key。
 */
const WINDOWS = [
  { key: "today", label: "今日", start: iso(0), end: iso(0) },
  { key: "yesterday", label: "昨日", start: iso(-1), end: iso(-1) },
  { key: "d7", label: "近7天", start: iso(-7), end: iso(-1) },
  { key: "d30", label: "近30天", start: iso(-30), end: iso(-1) },
];

console.log(`\n──── 汇总窗口 ────`);
const windows = {};
const onlySet = ONLY ? new Set(ONLY.split(",").map((s) => s.trim())) : null;
for (const w of WINDOWS) {
  if (onlySet && !onlySet.has(w.key)) { console.log(`  ${w.label}（--only 跳过）`); continue; }
  const r = await sumRange(w.start, w.end, w.label);
  windows[w.key] = r;
  console.log(
    `  ${w.label.padEnd(7)} ${String(r.orderCount).padStart(5)} 单  预计收入 ${String(r.projectedIncome).padStart(10)} 元  ` +
      `取消 ${String(r.cancelCount).padStart(3)} 单 (${(r.cancelRate * 100).toFixed(2)}%)  客单 ${r.avgOrderValue} 元`,
  );
}

// ════════ 逐日（近 DAYS 天）════════
const daily = [];
if (!onlySet || onlySet.has("daily")) {
  console.log(`\n──── 逐日明细（近 ${DAYS} 天）────`);
  for (let i = DAYS; i >= 1; i--) {
    const day = iso(-i);
    const r = await sumRange(day, day, day);
    daily.push({
      date: day,
      orderCount: r.orderCount,
      validOrderCount: r.validOrderCount,
      cancelCount: r.cancelCount,
      cancelRate: Number(r.cancelRate.toFixed(4)),
      projectedIncome: r.projectedIncome,
      cancelIncome: r.cancelIncome,
      avgOrderValue: r.avgOrderValue,
      byPoi: r.byPoi,
    });
  }
  console.log(`  共 ${daily.length} 天`);
  for (const d of daily) {
    console.log(
      `  ${d.date}  ${String(d.orderCount).padStart(4)} 单  预计收入 ${String(d.projectedIncome).padStart(9)} 元  ` +
        `取消 ${String(d.cancelCount).padStart(3)} 单 (${(d.cancelRate * 100).toFixed(2)}%)`,
    );
  }
}

// ════════ 官方对照（今日）════════
const official = JSON.parse(
  await evaluate(
    cdp,
    `(async () => { const r = await fetch('/api/retail/v3/order/todayOrderSummary/query?ignoreSetRouterProxy=true', {
        method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'poiId=-1&acctId=${ACCT_ID}' }); return await r.text(); })()`,
  ),
).data ?? {};

const t = windows.today ?? windows[Object.keys(windows)[0]];
const diff = t ? Number((t.projectedIncome - Number(official.settleIncome ?? 0)).toFixed(2)) : null;
console.log(`\n──── 官方对照（今日实时，与本次窗口无关，仅作接口健康检查）────`);
console.log(`  官方 settleIncome ${official.settleIncome}   validOrderCount ${official.validOrderCount}   cancelOrderCount ${official.cancelOrderCount}`);
if (diff !== null) {
  console.log(`  本脚本今日 Σ预计收入(剔取消) ${t.projectedIncome}   差 ${diff}`);
  if (diff !== 0) console.log(`  ⚠️ 差额非 0 —— 要么订单在取数期间变动了，要么口径有问题，需复查`);
}

const result = {
  fetchedAt: new Date().toISOString(),
  account: { key: acct.key, label: acct.label },
  acctId: ACCT_ID,
  statusCodes: STATUS,
  caliber: "预计收入 = Σ orderInfo.orderChargeBlockBO.finalSettlementAmount where orderStatus != 9",
  byPoiWindows,
  windows,
  daily,
  officialToday: official,
  selfCheck: { projectedIncomeDiff: diff, validOrderDiff: t ? t.validOrderCount - Number(official.validOrderCount ?? 0) : null },
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(result, null, 2), "utf8");
console.log(`\n落盘 ${OUT}`);

await cdp.close();
