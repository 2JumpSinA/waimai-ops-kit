/**
 * 两件事一起探：
 *   A. 「总曝光」平台接口 —— manageHome/multi/o/flow/module 的 exposureNumber
 *   B. 「取消单」平台现成的数据/曲线 —— 在订单页点「已取消」，抓它自己发的请求
 *   node src/probe-exposure-cancel.mjs [--account=quanyi]
 *
 * 背景（经营者两个要求）：
 *   1. 曝光不需要门店维度，只要整个平台的总曝光 —— 别再用逐店 flowPoiExposureRankingV2 求和
 *      （那个要 136 次调用、207 秒）。flow/module 一早就见过 exposureNumber，这里确认口径。
 *   2. 取消单平台有现成数据和曲线 —— 别翻今日订单（243 秒）。
 *      这里让订单页自己发一遍，把真实请求抄下来。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = acct.port;

const ANALYSIS = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";
const ORDER = "https://yiyao.meituan.com/main/frame#/page/orderbusiness#/order/history";

const compact = (v, n = 220) => (v == null ? "(无)" : String(v).replace(/\s+/g, " ").slice(0, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (!/yiyao\.meituan\.com\/(api|gw|v2)/.test(u)) return;
  if (/catfront|msp|dreport|logan/.test(u)) return;
  seen.push({ method: p.request.method, url: u, postData: p.request.postData ?? null });
});
const mark = () => seen.length;
const dump = (from, label, filter) => {
  const uniq = new Map();
  for (const h of seen.slice(from)) {
    const path = h.url.replace("https://yiyao.meituan.com", "").split("?")[0];
    if (filter && !filter.test(path)) continue;
    const q = new URLSearchParams(h.url.split("?")[1] ?? "");
    for (const k of ["mtgsig", "yodaReady", "csecplatform", "csecversion", "ignoreSetRouterProxy"]) q.delete(k);
    const key = h.method + " " + path + " " + (h.postData ?? "") + " " + q.toString();
    if (!uniq.has(key)) uniq.set(key, { method: h.method, path, q: q.toString(), postData: h.postData });
  }
  console.log(`\n   ── ${label}（${uniq.size} 条）──`);
  for (const h of uniq.values()) {
    console.log(`      ${h.method} ${h.path}`);
    if (h.q) console.log(`         q: ${compact(h.q, 200)}`);
    if (h.postData) console.log(`         b: ${compact(h.postData, 200)}`);
  }
};

/* ══════════ A. 总曝光 ══════════ */
console.log(`══ A. 总曝光（flow/module） 账号 ${acct.label} ══`);
await cdp.send("Page.navigate", { url: "about:blank" });
await sleep(1200);
await cdp.send("Page.navigate", { url: ANALYSIS });
await sleep(18_000);
await waitSignedReady(cdp, "/api/page/bizdata/manageHome/latestTime?dateType=realTime", { timeoutMs: 90_000 }).catch(() => ({ waitedMs: -1 }));

const pad = (n) => String(n).padStart(2, "0");
const ymd = (o) => { const t = new Date(Date.now() + o * 86400_000); return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`; };

const flow = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const common = { ignoreSetRouterProxy: 'true', businessType: '1', storeType: '2', cityId: '', labelId: '' };
     const out = {};
     for (const [tag, dt, b, cb, ce] of [
       ['近7天',  'last_7_days',  '${ymd(-7)}',  '${ymd(-14)}', '${ymd(-8)}'],
       ['近30天', 'last_30_days', '${ymd(-30)}', '${ymd(-60)}', '${ymd(-31)}'],
     ]) {
       const url = '/api/page/bizdata/manageHome/multi/o/flow/module?' + qs({
         ...common, dateType: dt, beginTime: b, endTime: '${ymd(-1)}',
         compareBeginTime: cb, compareEndTime: ce,
       });
       const r = await fetch(url, { credentials: 'include' });
       const j = await r.json().catch(() => null);
       out[tag] = { code: j?.code, msg: j?.msg, data: j?.data ?? null };
     }
     return out;
   })()`,
  { timeoutMs: 120_000 },
);
for (const [tag, o] of Object.entries(flow)) {
  console.log(`\n  ▸ ${tag}  code=${o.code} msg=${o.msg}`);
  const d = o.data ?? {};
  if (o.code !== 0) continue;
  const keys = Object.keys(d);
  console.log(`     字段: ${keys.join(", ")}`);
  for (const k of keys) {
    const v = d[k];
    console.log(`       ${k} = ${compact(v && typeof v === "object" ? JSON.stringify(v) : v, 160)}`);
  }
}

/* ══════════ B. 取消单曲线 ══════════ */
console.log(`\n\n══ B. 订单页「已取消」相关的数据/曲线请求 ══`);
const m0 = mark();
await cdp.send("Page.navigate", { url: "about:blank" });
await sleep(1200);
await cdp.send("Page.navigate", { url: ORDER });
await sleep(20_000);
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 }).catch(() => ({ waitedMs: -1 }));
dump(m0, "订单页加载（关注取消/趋势/统计）", /order\/list|trend|chart|count|statistics|interval|summary/i);

// 点「已取消」
const m1 = mark();
const clicked = await evaluate(
  cdp,
  `(() => {
     const want = ["已取消","取消单","取消"];
     const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
     for (const d of docs) {
       const cands = [...d.querySelectorAll('button,a,span,li,label,div')]
         .filter(e => e.offsetParent && want.includes((e.textContent||'').trim()) && (e.textContent||'').trim().length <= 6);
       if (cands.length) { cands[0].click(); return { ok:true, text: (cands[0].textContent||'').trim() }; }
     }
     return { ok:false };
   })()`,
);
console.log(`\n   点「已取消」→ ${JSON.stringify(clicked)}`);
await sleep(12_000);
dump(m1, "点完「已取消」之后", /order\/list|trend|chart|count|statistics|interval|summary/i);

await cdp.close();
