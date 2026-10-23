/**
 * 美团「今日实时」取数 —— 补上「近 1 小时」这个时间维度。
 *   node src/fetch-meituan-today.mjs [--account=quanyi|yifeng]
 *
 * 为什么单独一个脚本：
 *   income-*.json 只到「天」粒度，而经营者的焦点指标要「今天 / 近1小时 / 近1周」三个尺度。
 *   「近1小时」必须靠逐单时间戳，所以这里把今天的订单全量拉下来（含 order_time），
 *   在本地按小时聚合。
 *
 * ⚠️ order_time 是 **epoch 秒**（不是毫秒）。
 *    曾把它当毫秒传给 new Date() → 显示成 1970-01-21，差点误判成「字段不可用」。
 *
 * ⚠️ 口径声明：「近1小时取消」= 下单时间落在近1小时内的订单中状态为已取消的。
 *    平台的报表没有「取消时刻」字段，所以这不是「近1小时内发生的取消」，
 *    而是「近1小时内下的单里已经取消的」。两者在取消有延迟时会不同，看板须标注。
 *
 * 落盘 data/raw/today-<account>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = acct.port;
const PAGE_SIZE = Number(arg("pageSize", "100"));

const iso = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const OUT = dataPath(acct, "today");

/**
 * 阶段计时。
 * ⚠️ 加它是因为：这个脚本实测要 **242.8 秒**，而打印出来的每一步看着都只有秒级
 *    （签名就绪 2183ms、108 单 2 页）。时间藏在哪必须**量出来**，不能猜。
 */
const T0 = Date.now();
const lap = (label) => console.log(`   ⏱ ${label.padEnd(16)} 累计 ${((Date.now() - T0) / 1000).toFixed(1)}s`);

const cdp = await connectToPage(PORT);
lap("connectToPage");
console.log(`账号 ${acct.label}  端口 ${PORT}`);
/** ⭐ 优先读浏览器 profile 里的活 cookie（会自动续期），回退静态文件 */
const { cookies: CK } = await loadCookieSmart({
  stem: STEM,
  port: PORT,
  host: "yiyao.meituan.com",
  required: ["token", "acctId"],
});
const ACCT_ID = CK.acctId;
lap("loadCookieSmart");

/**
 * ⚠️⚠️ **必须停在订单页**（详见 fetch-meituan-income.mjs 里同段注释）：
 *   从 `/main/frame` 发起订单列表请求恒返回 `{"code":1,"msg":"列表标签错误"}`，
 *   因为 `history_all` 标签要等订单页微应用加载后才注册。
 */
const ORDER_PAGE = "https://yiyao.meituan.com/main/frame#/page/orderbusiness#/order/history";
await cdp.send("Page.navigate", { url: ORDER_PAGE });
lap("navigate");
const ready = await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", {
  timeoutMs: 90_000,
  label: `美团医药商家端（${acct.label}）`,
});
lap("waitSignedReady");
console.log(`🔏 签名链路就绪（${ready.waitedMs}ms，已停在订单页）`);

const CANCELLED = new Set([9]);
const STATUS = { 8: "已完成", 4: "处理中", 9: "已取消" };

/**
 * 页内翻页拉**指定日期**的全部订单（含 order_time / orderStatus / 门店）。
 * ⚠️ 2026-09-22：原来写死「今天」。现在参数化，同一个函数既取今日、也取昨日 ——
 *    看板的「昨日」窗口要显示小时维度，而平台没有「昨日逐小时」报表，
 *    但逐小时本来就是本脚本按 order_time 自己分桶算的（见文件头），所以拉昨日订单即可。
 */
async function fetchOrders(dateIso) {
  const raw = await evaluate(
    cdp,
    `(async () => {
       const all = [];
       let pageNum = 1, total = null, pageCount = null;
       const sleep = (ms) => new Promise(r => setTimeout(r, ms));
       for (;;) {
         const body = new URLSearchParams({
           tag:'history_all',
           pageParam: JSON.stringify({pageSize:${PAGE_SIZE},pageNum:pageNum,sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
           extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
           startDate:'${dateIso}', endDate:'${dateIso}',
         });
         /**
          * ⚠️ 必须重试 —— 页面刚导航完时订单列表会返回
          *    {"code":1,"msg":"列表标签错误","data":null}
          *    签名就绪 ≠ tag 注册表就绪。详见 fetch-meituan-income.mjs 里同段注释。
          */
         let j = null, last = null;
         for (let attempt = 1; attempt <= 10; attempt++) {
           const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
             method:'POST', credentials:'include',
             headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
           const txt = await r.text();
           try { j = JSON.parse(txt); } catch (e) { j = null; }
           if (j && j.code === 0) break;
           last = txt.slice(0, 200); j = null;
           await sleep(1200 * attempt);
         }
         if (!j) throw new Error('订单列表连续 10 次未就绪，最后响应：' + last);
         const list = j.data?.orderList ?? [];
         const pi = j.data?.pageInfo ?? {};
         total = pi.totalCount ?? total; pageCount = pi.pageCount ?? pageCount;
         for (const x of list) {
           let ci = {}, oi = {};
           try { ci = JSON.parse(x.commonInfo); } catch (e) {}
           try { oi = JSON.parse(x.orderInfo); } catch (e) {}
           const ch = oi.orderChargeBlockBO ?? {};
           // ⚠️ 门店在 orderInfo.unifiedBasicInfo，不在 commonInfo
           const ub = oi.unifiedBasicInfo ?? {};
           all.push({
             orderTime: ci.order_time ?? null,
             status: ci.orderStatus ?? null,
             income: Number(ch.finalSettlementAmount ?? 0),
             poiId: ub.wmPoiId ?? null,
             poiName: ub.wmPoiName ?? ub.poiName ?? null,
             poiCity: ub.wmPoiCityName ?? null,
           });
         }
         // ⚠️ 终止条件以 totalCount/pageCount 为准，别只看短页 ——
         //    该接口偶发少返回若干条，用短页判断会静默丢单（详见 fetch-meituan-income.mjs 注释）
         if (total != null && all.length >= total) break;
         if (pageCount && pageNum >= pageCount) break;
         if (!list.length) break;
         if (!total && !pageCount && list.length < ${PAGE_SIZE}) break;
         if (pageNum > 400) break;
         pageNum++;
       }
       return JSON.stringify({ all, total, pageCount });
     })()`,
    // 页内带翻页 + 重试退避，很容易超 45s —— 必须显式放宽，否则报 CDP 超时
    { timeoutMs: 240_000 },
  );
  return JSON.parse(raw);
}

const { all, total, pageCount } = await fetchOrders(iso(0));
lap("fetchToday");
console.log(`今日订单：取回 ${all.length} 单（totalCount=${total}, pageCount=${pageCount}）`);

/**
 * ⭐ 2026-09-22 新增：**昨日**订单也拉一遍，用于看板「昨日」窗口的逐小时曲线。
 *    来源与今日完全相同（都是逐单 order_time 分桶），不是新接口。
 */
const yestIso = iso(-1);
const yest = await fetchOrders(yestIso);
lap("fetchYesterday");
console.log(`昨日订单（${yestIso}）：取回 ${yest.all.length} 单（totalCount=${yest.total}, pageCount=${yest.pageCount}）`);

/**
 * ⭐ 官方今日汇总 —— 今日口径的**唯一权威来源**（1 次调用，不翻订单）。
 *
 * 经营者 2026-09-21 的要求：今日取消数改用 `todayOrderSummary.cancelOrderCount`。
 * 它比「翻今日订单再数 status==9」权威。
 * 本地仍按订单算一遍，只为**自校**（实测两账号 diff 均为 0）。
 *
 * ⚠️ 它硬编码「今日」，传区间参数会被忽略（已实测）。
 */
const official = await evaluate(
  cdp,
  `(async () => {
     const r = await fetch('/api/retail/v3/order/todayOrderSummary/query?ignoreSetRouterProxy=true', {
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/x-www-form-urlencoded'},
       body:'poiId=-1&acctId=${ACCT_ID}' });
     return await r.text();
   })()`,
  { timeoutMs: 60_000 },
).then((t) => { try { return JSON.parse(t).data ?? null; } catch { return null; } });
lap("todayOrderSummary");
console.log(
  `官方今日汇总：settleIncome=${official?.settleIncome} 已接=${official?.validOrderCount} 取消=${official?.cancelOrderCount}`,
);

const nowSec = Math.floor(Date.now() / 1000);
const p = (n) => String(n).padStart(2, "0");
const hourKey = (sec) => {
  const d = new Date(sec * 1000);
  return `${p(d.getHours())}:00`;
};

// ── 今日整体 ──
const todayCancelled = all.filter((x) => CANCELLED.has(x.status));
const todayValid = all.filter((x) => !CANCELLED.has(x.status));
const todayIncome = todayValid.reduce((s, x) => s + (x.income || 0), 0);

// ── 近 1 小时 ──
const h1 = all.filter((x) => x.orderTime && x.orderTime >= nowSec - 3600);
const h1Cancelled = h1.filter((x) => CANCELLED.has(x.status));
const h1Rate = h1.length ? h1Cancelled.length / h1.length : 0;

// ── 近 3 小时（做趋势对照）──
const h3 = all.filter((x) => x.orderTime && x.orderTime >= nowSec - 3 * 3600);
const h3Cancelled = h3.filter((x) => CANCELLED.has(x.status));

// ── 逐小时聚合（今日 / 昨日共用同一套分桶规则）──
function bucketByHour(orders) {
  const byHour = new Map();
  for (const x of orders) {
    if (!x.orderTime) continue;
    const k = hourKey(x.orderTime);
    const a = byHour.get(k) ?? { hour: k, orders: 0, cancel: 0, income: 0 };
    a.orders++;
    if (CANCELLED.has(x.status)) a.cancel++;
    else a.income += x.income || 0;
    byHour.set(k, a);
  }
  return [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour))
    .map((a) => ({ ...a, rate: a.orders ? Number((a.cancel / a.orders).toFixed(4)) : 0, income: Number(a.income.toFixed(2)) }));
}
const hourly = bucketByHour(all);
const hourlyYesterday = bucketByHour(yest.all);

// ── 门店取消排行 ──
const byPoi = new Map();
for (const x of all) {
  const k = String(x.poiId ?? x.poiName ?? "?");
  const a = byPoi.get(k) ?? { poiId: k, poiName: x.poiName ?? "", orders: 0, cancel: 0 };
  a.orders++;
  if (CANCELLED.has(x.status)) a.cancel++;
  byPoi.set(k, a);
}
const poiRank = [...byPoi.values()]
  .map((a) => ({ ...a, rate: a.orders ? Number((a.cancel / a.orders).toFixed(4)) : 0 }))
  .sort((a, b) => b.cancel - a.cancel || b.rate - a.rate);

console.log(`\n════ 今日实时 ════`);
console.log(`  订单 ${all.length}   取消 ${todayCancelled.length} (${((todayCancelled.length / (all.length || 1)) * 100).toFixed(2)}%)   预计收入(剔取消) ${todayIncome.toFixed(2)} 元`);
console.log(`  近1小时：下单 ${h1.length}   其中已取消 ${h1Cancelled.length} (${(h1Rate * 100).toFixed(2)}%)`);
console.log(`  近3小时：下单 ${h3.length}   其中已取消 ${h3Cancelled.length} (${h3.length ? ((h3Cancelled.length / h3.length) * 100).toFixed(2) : "0.00"}%)`);
console.log(`\n  逐小时：`);
for (const a of hourly) {
  console.log(`     ${a.hour}  ${String(a.orders).padStart(4)} 单   取消 ${String(a.cancel).padStart(3)} (${(a.rate * 100).toFixed(1).padStart(5)}%)   预计收入 ${String(a.income).padStart(9)} 元`);
}
const withCancel = poiRank.filter((x) => x.cancel > 0);
console.log(`\n  今日有取消的门店 ${withCancel.length} 家，前 10：`);
for (const a of withCancel.slice(0, 10)) {
  console.log(`     ${String(a.cancel).padStart(3)}/${String(a.orders).padStart(3)}  ${(a.rate * 100).toFixed(1).padStart(5)}%   ${a.poiName || a.poiId}`);
}

// ── 昨日逐小时（给看板「昨日」窗口用）──
const yestOrders = yest.all.length;
const yestCancel = yest.all.filter((x) => CANCELLED.has(x.status)).length;
const yestIncome = yest.all.filter((x) => !CANCELLED.has(x.status)).reduce((s, x) => s + (x.income || 0), 0);
console.log(`\n  昨日逐小时（${yestIso}）  合计 ${yestOrders} 单 / 取消 ${yestCancel} / 预计收入 ${yestIncome.toFixed(2)} 元：`);
for (const a of hourlyYesterday) {
  console.log(`     ${a.hour}  ${String(a.orders).padStart(4)} 单   取消 ${String(a.cancel).padStart(3)} (${(a.rate * 100).toFixed(1).padStart(5)}%)   预计收入 ${String(a.income).padStart(9)} 元`);
}

/**
 * 今日口径以**官方汇总为准**，本地逐单统计只作自校。
 *
 * 经营者 2026-09-21 的要求：今日取消数改用 `todayOrderSummary.cancelOrderCount`。
 * 本地值一并保留（`totals.local`），差异进 `selfCheck` —— 差得多要看，不能默默替换。
 */
const locOrders = all.length;
const locValid = todayValid.length;
const locCancel = todayCancelled.length;
const offValid = official?.validOrderCount != null ? Number(official.validOrderCount) : null;
const offCancel = official?.cancelOrderCount != null ? Number(official.cancelOrderCount) : null;
const offIncome = official?.settleIncome != null ? Number(official.settleIncome) : null;
const useOfficial = offCancel != null && offValid != null;
const totOrders = useOfficial ? offValid + offCancel : locOrders;
const totCancel = useOfficial ? offCancel : locCancel;
const totValid = useOfficial ? offValid : locValid;
const totIncome = offIncome != null ? offIncome : Number(todayIncome.toFixed(2));

console.log(
  `\n口径：${useOfficial ? "官方 todayOrderSummary" : "本地逐单（官方汇总取不到）"}` +
    `   取消 ${totCancel}（本地 ${locCancel}，差 ${locCancel - (offCancel ?? locCancel)}）`,
);

const payload = {
  fetchedAt: new Date().toISOString(),
  account: { key: acct.key, label: acct.label },
  date: iso(0),
  nowSec,
  caliber: {
    totals:
      "今日总量（订单/取消/预计收入）以 **todayOrderSummary（官方今日汇总）** 为准；" +
      "本地逐单统计保留在 totals.local 并对差，差异记入 selfCheck。",
    recentHour:
      "近1小时取消 = 下单时间落在近1小时内的订单中状态为已取消的。平台无「取消时刻」字段，故非「近1小时内发生的取消」。",
    yesterdayHourly:
      "昨日逐小时 = 昨日的订单按 order_time 分桶（与今日同一套规则，来源都是逐单）。" +
      "⚠️ 昨日**没有**官方汇总可对差（todayOrderSummary 只能查今天），故为本地逐单值，" +
      "与 income 的「昨日」窗口（平台 fixTimeChart）可能差几单，属正常。",
  },
  official,
  totals: {
    orders: totOrders,
    cancel: totCancel,
    cancelRate: Number((totCancel / (totOrders || 1)).toFixed(4)),
    validOrders: totValid,
    projectedIncome: Number(totIncome.toFixed(2)),
    source: useOfficial ? "todayOrderSummary" : "order-list-local",
    local: {
      orders: locOrders,
      validOrders: locValid,
      cancel: locCancel,
      cancelRate: Number((locCancel / (locOrders || 1)).toFixed(4)),
      projectedIncome: Number(todayIncome.toFixed(2)),
    },
  },
  selfCheck: {
    cancelDiff: offCancel != null ? locCancel - offCancel : null,
    validDiff: offValid != null ? locValid - offValid : null,
    incomeDiff: offIncome != null ? Number((Number(todayIncome.toFixed(2)) - offIncome).toFixed(2)) : null,
  },
  recentHour: { orders: h1.length, cancel: h1Cancelled.length, rate: Number(h1Rate.toFixed(4)) },
  recent3Hour: { orders: h3.length, cancel: h3Cancelled.length, rate: h3.length ? Number((h3Cancelled.length / h3.length).toFixed(4)) : 0 },
  hourly,
  /**
   * ⭐ 昨日逐小时（2026-09-22 新增）。与 `hourly` **同一套分桶规则**，来源都是逐单 order_time。
   *    用途：看板窗口切到「昨日」时画小时曲线。
   *    ⚠️ 昨日**没有**官方汇总可对差（todayOrderSummary 只能查今天），所以这里只有本地逐单值，
   *       与 income-*.json 的「昨日」窗口（平台 fixTimeChart）可能差几单 —— 属正常，见 caliber.yesterdayHourly。
   */
  hourlyYesterday,
  dateYesterday: yestIso,
  yesterdayTotals: {
    orders: yestOrders,
    cancel: yestCancel,
    cancelRate: Number((yestCancel / (yestOrders || 1)).toFixed(4)),
    projectedIncome: Number(yestIncome.toFixed(2)),
    source: "order-list-local",
  },
  yesterdayPoiRank: (() => {
    const m = new Map();
    for (const x of yest.all) {
      const k = String(x.poiId ?? x.poiName ?? "?");
      const a = m.get(k) ?? { poiId: k, poiName: x.poiName ?? "", orders: 0, cancel: 0 };
      a.orders++;
      if (CANCELLED.has(x.status)) a.cancel++;
      m.set(k, a);
    }
    return [...m.values()]
      .map((a) => ({ ...a, rate: a.orders ? Number((a.cancel / a.orders).toFixed(4)) : 0 }))
      .sort((a, b) => b.cancel - a.cancel || b.rate - a.rate)
      .slice(0, 50);
  })(),
  poiRank: poiRank.slice(0, 50),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
console.log(`\n落盘 ${OUT}`);

await cdp.close();
