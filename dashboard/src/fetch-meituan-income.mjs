/**
 * 美团「预计收入 / 取消单」取数 —— **平台聚合版**（薄取数层）
 *   node src/fetch-meituan-income.mjs [--account=quanyi|yifeng] [--days=30]
 *                                     [--only=today,yesterday,d7,d30,daily,byPoi]
 *
 * ⭐ 为什么重写：
 *   旧实现（已固化到 src/legacy/fetch-meituan-income-orderlist.mjs）是**订单列表逐单翻页求和**，
 *   品牌A近 30 天 6885 单要翻 69 页，还踩「偶发短页静默丢单」的坑。
 *   2026-09-21 标定后发现**经营首页本来就有窗口聚合**（经营者指出的）。我一开始没找到，
 *   因为控件在**同源 iframe** 里、且 dateType 真值是 `last_7_days`/`last_30_days`（不是猜的那些）。
 *   完整标定记录见 .dsh/skills/waimai-dashboard/reference/meituan-yiyao-api.md §3.11。
 *
 * 本文件只管「取」，拼装全在 src/lib/mt-income-assemble.mjs（那边有离线单测）。
 *
 * 数据来源（约 10 次调用，替代原来的 70+ 次翻页）：
 *   ① POST order/list/page/history  tag=order_cancel   只翻已取消的单（≈2 页）→ 逐日+逐店取消数
 *   ② POST todayOrderSummary                            今日（平台窗口**不含今天**）
 *   ③ GET  manageHome/multi/o/core                      窗口汇总
 *   ④ GET  manageHome/multi/o/fixTimeChart              整个窗口的逐日值
 *   ⑤ POST manageHome/multi/store/poi/detail            逐店窗口值
 *
 * ⛔ 关键边界（都踩过）：
 *   · 平台 `last_N_days` = **截止昨天，不含今天**
 *   · `compareBeginTime`/`compareEndTime` **必填**，留空报「参数错误：对比时间错误」
 *   · `dateType=realTime` 会**忽略** beginTime/endTime
 *   · `core` **没有** cancel 字段（只有 refund），取消单必须走 ①
 *   · 请求故意串行且带间隔 —— 密集并发会让站点把我们重定向到登录页
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectToPage, evaluate, waitSignedReady, assertNotLoginRedirect } from "./lib/cdp.mjs";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";
import { lastNDays, dayWindows } from "./lib/mt-window.mjs";
import { assembleIncome } from "./lib/mt-income-assemble.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = acct.port;
const DAYS = Math.min(Number(arg("days", "30")), 30);
const PAGE_SIZE = Number(arg("pageSize", "100"));
const ONLY = arg("only", "");
const onlySet = ONLY ? new Set(ONLY.split(",").map((s) => s.trim())) : null;
const want = (k) => !onlySet || onlySet.has(k);

/**
 * 逐店开关 —— **独立于 `--only`**，因为 `refresh-all.ps1` 传的是
 * `--only=today,yesterday,d7,d30,daily --byPoiAll=1`（`byPoi` 不在 `--only` 里）。
 * 旧脚本的逐店由 `--byPoiAll=1` / `--byPoi=<窗口>` 控制，这里保持同样的语义，
 * 否则刷新流水线跑完「高取消单占比门店」会静默变空。
 */
const BYPOI_ALL = arg("byPoiAll", "") === "1";
const BYPOI_ARG = arg("byPoi", "");
const byPoiOn = BYPOI_ALL || !!BYPOI_ARG || !onlySet || onlySet.has("byPoi") || onlySet.has("d7") || onlySet.has("d30");

const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const OUT = dataPath(acct, "income");
const LEGACY = dataPath(acct, "income-orderlist");

const ORDER_PAGE = "https://yiyao.meituan.com/main/frame#/page/orderbusiness#/order/history";
const ANALYSIS_PAGE = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";
const ANALYSIS_COMMON = { ignoreSetRouterProxy: "true", businessType: "1", storeType: "2", cityId: "", labelId: "" };

/**
 * `order_cancel` 在菜单配置里**没有** filterMenus，所以 `searchTag` 对它是否有意义未知。
 * 依次尝试，哪个能拿到数据用哪个，并记录下来 —— 不猜。
 */
const CANCEL_TAG_CANDIDATES = [
  { tag: "order_cancel", extParam: { phfRollback: 0, requestWmPoiId: "-1", searchTag: "14" }, note: "order_cancel + searchTag=14" },
  { tag: "order_cancel", extParam: { phfRollback: 0, requestWmPoiId: "-1" }, note: "order_cancel 不带 searchTag" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════ 页内请求 ═══════════ */

/** 在页面上下文里串行发一批 GET（平台接口要页面签名 mtgsig，Node 直连会 403） */
async function pageGets(specs, { timeoutMs = 180_000, gap = 400 } = {}) {
  if (!specs.length) return {};
  return evaluate(
    cdp,
    `(async () => {
       const specs = ${JSON.stringify(specs)};
       const sleep = (ms) => new Promise(r => setTimeout(r, ms));
       const out = {};
       for (const s of specs) {
         try {
           const r = await fetch(s.url, { credentials: 'include' });
           const txt = await r.text();
           let j = null; try { j = JSON.parse(txt); } catch {}
           out[s.key] = { status: r.status, json: j, raw: j ? null : txt.slice(0, 300) };
         } catch (e) { out[s.key] = { status: -1, error: String(e).slice(0, 200) }; }
         await sleep(${gap});
       }
       return out;
     })()`,
    { timeoutMs },
  );
}

/* ═══════════ 取消单 ═══════════ */

/**
 * 翻 `tag=order_cancel`。**只翻已取消的单** —— 品牌A近30天取消率 2.93%，
 * 约 200 单 = 2 页（原来翻全部订单要 69 页）。
 */
async function fetchCancelOrders(startIso, endIso, label) {
  const rows = [];
  let pageNum = 1;
  let total = null;
  let candIdx = 0;
  let announced = false;

  for (;;) {
    const body = await evaluate(
      cdp,
      `(async () => {
         const sleep = (ms) => new Promise(r => setTimeout(r, ms));
         const cands = ${JSON.stringify(CANCEL_TAG_CANDIDATES)};
         let lastErr = null;
         for (let ci = ${candIdx}; ci < cands.length; ci++) {
           const c = cands[ci];
           for (let attempt = 1; attempt <= 6; attempt++) {
             const body = new URLSearchParams({
               tag: c.tag,
               pageParam: JSON.stringify({pageSize:${PAGE_SIZE},pageNum:${pageNum},sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
               extParam: JSON.stringify(c.extParam),
               startDate: '${startIso}', endDate: '${endIso}',
             });
             const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
               method:'POST', credentials:'include',
               headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
             const txt = await r.text();
             let j = null; try { j = JSON.parse(txt); } catch {}
             if (j && j.code === 0) return JSON.stringify({ idx: ci, note: c.note, json: j });
             lastErr = txt.slice(0, 200);
             await sleep(1200 * attempt);
           }
         }
         throw new Error('取消单列表连续尝试均未就绪，最后响应：' + lastErr);
       })()`,
      { timeoutMs: 240_000 },
    );

    const { idx, note, json } = JSON.parse(body);
    candIdx = idx;
    if (!announced) {
      announced = true;
      console.log(`  🔖 取消单标签：${note}`);
    }
    const list = json.data?.orderList ?? [];
    const page = json.data?.pageInfo ?? {};
    if (total == null) total = page.total ?? page.totalCount ?? null;

    for (const x of list) {
      let ci = {};
      let oi = {};
      try { ci = JSON.parse(x.commonInfo); } catch { /* ignore */ }
      try { oi = JSON.parse(x.orderInfo); } catch { /* ignore */ }
      // ⚠️ 门店在 orderInfo.unifiedBasicInfo，**不在** commonInfo（§3.10.3）
      const ub = oi.unifiedBasicInfo ?? {};
      rows.push({
        orderTime: ci.order_time ?? null, // epoch **秒**
        status: ci.orderStatus,
        poiId: ub.wmPoiId ?? null,
        poiName: ub.wmPoiName ?? ub.poiName ?? null,
        income: Number(oi.orderChargeBlockBO?.finalSettlementAmount ?? 0),
      });
    }

    process.stdout.write(`\r  ${label} 已取 ${rows.length}${total ? "/" + total : ""} 单取消单…   `);
    if (total != null && rows.length >= total) break;
    if (!list.length) break;
    if (total == null && list.length < PAGE_SIZE) break;
    if (pageNum > 200) break;
    pageNum++;
    await sleep(320);
  }
  process.stdout.write("\r" + " ".repeat(66) + "\r");
  return { rows, total };
}

/* ═══════════ 主流程 ═══════════ */

const cdp = await connectToPage(PORT);
console.log(`账号 ${acct.label}（${acct.key}）  端口 ${PORT}`);

const { cookies: CK } = await loadCookieSmart({
  stem: STEM, port: PORT, host: "yiyao.meituan.com", required: ["token", "acctId"],
});
const ACCT_ID = CK.acctId;
console.log(`acctId = ${ACCT_ID}`);

const dw = dayWindows();
const w7 = lastNDays(7);
const w30 = lastNDays(30);

console.log(`\n窗口定义（平台 last_N_days **截止昨天，不含今天**）：`);
console.log(`  今日      ${dw.today.iso}`);
console.log(`  近7天     ${w7.isoBegin} ~ ${w7.isoEnd}`);
console.log(`  近30天    ${w30.isoBegin} ~ ${w30.isoEnd}`);

/* ── 阶段一：订单页 ── */
console.log(`\n──── 阶段一：订单页（取消单 + 今日官方汇总）────`);
await cdp.send("Page.navigate", { url: ORDER_PAGE });
await assertNotLoginRedirect(cdp, { label: `美团医药商家端（${acct.label}）` });
const ready1 = await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", {
  timeoutMs: 90_000,
  label: `美团医药商家端（${acct.label}）`,
});
console.log(`🔏 签名链路就绪（${ready1.waitedMs}ms）`);

let cancelWindow = { rows: [], total: null };
let cancelToday = { rows: [], total: null };
const needWindowCancels = want("d7") || want("d30") || want("yesterday") || want("daily") || byPoiOn;
if (needWindowCancels) {
  // 一次翻满 30 天：d30 / d7 / 昨日都在这个区间内，不必重复翻
  cancelWindow = await fetchCancelOrders(w30.isoBegin, w30.isoEnd, `近${w30.n}天`);
  console.log(`  近${w30.n}天取消单 ${cancelWindow.rows.length} 单（totalCount=${cancelWindow.total}）`);
}
if (want("today")) {
  cancelToday = await fetchCancelOrders(dw.today.iso, dw.today.iso, "今日");
  console.log(`  今日取消单 ${cancelToday.rows.length} 单（totalCount=${cancelToday.total}）`);
}

let officialToday = null;
if (want("today")) {
  // 这个接口是 POST，所以不走 pageGets
  const raw = await evaluate(
    cdp,
    `(async () => {
       const r = await fetch('/api/retail/v3/order/todayOrderSummary/query?ignoreSetRouterProxy=true', {
         method:'POST', credentials:'include',
         headers:{'Content-Type':'application/x-www-form-urlencoded'},
         body:'poiId=-1&acctId=${ACCT_ID}' });
       return await r.text();
     })()`,
    { timeoutMs: 60_000 },
  );
  try { officialToday = JSON.parse(raw).data ?? null; } catch { officialToday = null; }
  console.log(`  官方今日汇总：settleIncome=${officialToday?.settleIncome} 已接=${officialToday?.validOrderCount} 取消=${officialToday?.cancelOrderCount}`);
}

/* ── 阶段二：经营首页 ── */
console.log(`\n──── 阶段二：经营首页（平台聚合）────`);
await cdp.send("Page.navigate", { url: ANALYSIS_PAGE });
await assertNotLoginRedirect(cdp, { label: `美团医药商家端（${acct.label}）` });
// 直接自测一个真实业务 GET，比探 latestTime 更能说明签名链路可用
const ready2 = await waitSignedReady(
  cdp,
  `/api/page/bizdata/manageHome/multi/o/core?${new URLSearchParams({ ...ANALYSIS_COMMON, ...w7 }).toString()}`,
  { timeoutMs: 90_000, label: `美团医药商家端（${acct.label}）` },
);
console.log(`🔏 经营首页签名就绪（${ready2.waitedMs}ms）`);

const CORE = "/api/page/bizdata/manageHome/multi/o/core";
const FIXCHART = "/api/page/bizdata/manageHome/multi/o/fixTimeChart";
const POIDETAIL = "/api/page/bizdata/manageHome/multi/store/poi/detail";

const specs = [];
if (want("d7")) specs.push({ key: "core7", url: `${CORE}?${new URLSearchParams({ ...ANALYSIS_COMMON, ...w7 })}` });
if (want("d30")) specs.push({ key: "core30", url: `${CORE}?${new URLSearchParams({ ...ANALYSIS_COMMON, ...w30 })}` });
if (want("daily")) specs.push({ key: "chart30", url: `${FIXCHART}?${new URLSearchParams({ ...ANALYSIS_COMMON, ...w30 })}` });

const agg = await pageGets(specs);
for (const k of ["core7", "core30", "chart30"]) {
  const r = agg[k];
  if (!r) continue;
  if (r.error || r.status !== 200) console.log(`  ⚠️ ${k} 请求异常：${r.error ?? "HTTP " + r.status}`);
  else if (r.json?.code !== 0) console.log(`  ⚠️ ${k} code=${r.json?.code} msg=${String(r.json?.msg ?? "").slice(0, 70)}`);
}

/* ── 逐店 ── */
const poiDetail = { d7: null, d30: null };
if (byPoiOn) {
  for (const [key, w, label] of [["d7", w7, "近7天"], ["d30", w30, "近30天"]]) {
    const rows = [];
    for (let pageNum = 1; pageNum <= 20; pageNum++) {
      const body = {
        pageNum, pageSize: 100,
        moduleTypes: "multiProjectedIncome,multiDealAmount,multiTransactionVolume",
        businessType: 1, storeType: 2, cityId: "", labelId: "",
        dateType: w.dateType, beginTime: w.beginTime, endTime: w.endTime,
        compareBeginTime: w.compareBeginTime, compareEndTime: w.compareEndTime,
      };
      const raw = await evaluate(
        cdp,
        `(async () => {
           const r = await fetch('${POIDETAIL}?ignoreSetRouterProxy=true', {
             method:'POST', credentials:'include',
             headers:{'Content-Type':'application/json'},
             body: ${JSON.stringify(JSON.stringify(body))} });
           return await r.text();
         })()`,
        { timeoutMs: 120_000 },
      );
      let j = null;
      try { j = JSON.parse(raw); } catch { /* ignore */ }
      // 实测形状是 json.data.data.dataList（两层 data），兼容一层
      const list = j?.data?.data?.dataList ?? j?.data?.dataList ?? j?.data?.list ?? [];
      if (!list.length) {
        if (pageNum === 1) console.log(`  ⚠️ ${label} 逐店明细为空（msg=${String(j?.msg ?? "").slice(0, 50)}）`);
        break;
      }
      for (const x of list) {
        rows.push({
          poiId: String(x.wmPoiId ?? x.poiId ?? "?"),
          poiName: x.wmPoiName ?? x.poiName ?? "",
          income: Number(x.multiProjectedIncome ?? 0),
          orders: Number(x.multiTransactionVolume ?? 0),
        });
      }
      if (list.length < 100) break;
      await sleep(350);
    }
    poiDetail[key] = rows.length ? rows : null;
    console.log(`  ${label} 逐店明细 ${rows.length} 家`);
  }
}

/* ── 旧逐单基准（有就带上，供对账）── */
let legacyRef = null;
try { legacyRef = JSON.parse(await readFile(LEGACY, "utf8")); } catch { /* 没有就算了 */ }

/* ── 装配 ── */
const { result, log } = assembleIncome({
  acct, acctId: ACCT_ID, days: DAYS,
  cancelWindowRows: cancelWindow.rows, cancelWindowTotal: cancelWindow.total,
  cancelTodayRows: cancelToday.rows, cancelTodayTotal: cancelToday.total,
  // 「取过今日取消单」≠「今日有取消单」：真实为 0 时自检也该判定通过，而不是显示成不确定
  cancelTodayFetched: want("today"),
  officialToday, agg, poiDetail, legacyRef, only: onlySet, byPoiOn,
});

/* ── 落盘 ── */
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(result, null, 2), "utf8");

/* ── 汇报 ── */
for (const l of log) console.log(`  ${l}`);
console.log(`\n──── 结果 ────`);
/** ⚠️ `cancelRate` 是**小数**（消费方 build-dashboard 会乘 100），打印时要自己转百分比 */
const pct = (r) => (r == null ? "—" : `${(r * 100).toFixed(2)}%`);
for (const [k, w] of Object.entries(result.windows)) {
  if (!w) { console.log(`  ${k.padEnd(10)} (缺失)`); continue; }
  console.log(
    `  ${(w.label ?? k).padEnd(7)} 订单 ${String(w.orderCount).padStart(5)}  预计收入 ${String(w.projectedIncome).padStart(10)}  ` +
      `取消 ${String(w.cancelCount).padStart(4)} (${pct(w.cancelRate)})  客单 ${w.avgOrderValue}`,
  );
}
if (result.selfCheck.checks.length) {
  console.log(`\n  自检：`);
  for (const c of result.selfCheck.checks) {
    const mark = c.ok === null ? "◻️" : c.ok ? "✅" : "⚠️";
    console.log(`    ${mark} ${c.name}  ${c.a} vs ${c.b}  diff=${c.diff}`);
  }
}
const pv = result.selfCheck.platformVsOrderlist;
if (pv) {
  console.log(`\n  与旧逐单基准对照（重叠 ${pv.overlapDays} 天）：完全一致 ${pv.exactDays} 天 · 有差异 ${pv.diffDays} 天 · 最大单日差 ${pv.maxAbsDiff} 元`);
}
if (result.warnings.length) {
  console.log(`\n  ⚠️ 提醒：`);
  for (const w of result.warnings) console.log(`     · ${w}`);
}
console.log(`\n落盘 ${OUT}`);

await cdp.close();
