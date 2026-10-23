/**
 * 两条并行的确认：
 *   A. orderDeal/trendChart 换 moduleType 能不能给出「退款/取消」曲线（含逐小时粒度）
 *   B. flow/module 的 exposureNumber 到底是什么量纲（是不是平台总曝光）
 *   node src/probe-trendchart.mjs [--account=quanyi]
 *
 * 依据：
 *   · 平台经营首页自己会发 orderDeal/trendChart?moduleType=multiDealAmount 等，
 *     说明它是**按 moduleType 选指标**的通用趋势接口（不是猜，是抓包看到的）
 *   · core 里有 multiRefundOrderQuantity / multiAllRefundOrderQuantity / multiRefundAmount
 *   · 经营者的截图：经营报告页有「退款订单量-趋势图」，横轴 00:00~23:00（逐小时）
 *
 * 判据：谁返回了非空的逐点序列、粒度是小时还是天、数值是否与 core 的窗口值对得上。
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
const compat = (v, n = 150) => (v == null ? "null" : String(v).replace(/\s+/g, " ").slice(0, n));

const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 1200));
await cdp.send("Page.navigate", { url: ANALYSIS });
await new Promise((r) => setTimeout(r, 20_000));
await waitSignedReady(cdp, "/api/page/bizdata/manageHome/latestTime?dateType=realTime", { timeoutMs: 90_000 }).catch(() => ({}));

const pad = (n) => String(n).padStart(2, "0");
const ymd = (o) => { const t = new Date(Date.now() + o * 86400_000); return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`; };

const out = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const common = { ignoreSetRouterProxy: 'true', businessType: '1', storeType: '2', cityId: '', labelId: '' };
     const res = { trend: [], flow: null };
     const MODS = ['multiDealAmount','multiRefundOrderQuantity','multiAllRefundOrderQuantity','multiRefundAmount','multiProjectedIncome','multiTransactionVolume'];
     for (const dt of [
       ['realTime','${ymd(0)}','${ymd(0)}','${ymd(-1)}','${ymd(-1)}'],
       ['last_7_days','${ymd(-7)}','${ymd(-1)}','${ymd(-14)}','${ymd(-8)}'],
     ]) {
       const [dateType, b, e, cb, ce] = dt;
       for (const m of MODS) {
         const url = '/api/page/bizdata/manageHome/orderDeal/trendChart?' + qs({
           ...common, dateType, beginTime: b, endTime: e, compareBeginTime: cb, compareEndTime: ce, moduleType: m,
         });
         try {
           const r = await fetch(url, { credentials: 'include' });
           const j = await r.json().catch(() => null);
           res.trend.push({ dateType, m, code: j?.code, msg: String(j?.msg ?? '').slice(0, 60), data: j?.data ?? null });
         } catch (e2) { res.trend.push({ dateType, m, err: String(e2).slice(0, 80) }); }
         await new Promise(r => setTimeout(r, 250));
       }
     }
     // B. flow/module
     const flowUrl = '/api/page/bizdata/manageHome/multi/o/flow/module?' + qs({
       ...common, dateType: 'last_7_days', beginTime: '${ymd(-7)}', endTime: '${ymd(-1)}',
       compareBeginTime: '${ymd(-14)}', compareEndTime: '${ymd(-8)}',
     });
     const fr = await fetch(flowUrl, { credentials: 'include' });
     res.flow = await fr.json().catch(() => null);
     return res;
   })()`,
  { timeoutMs: 240_000 },
);

console.log("══ A. orderDeal/trendChart × moduleType ══");
for (const t of out.trend) {
  const d = t.data;
  // 探测返回形状：常见是 { trend: [...] } 或 { dataKey, dataName, trend }
  let pts = null, keys = null;
  if (d && typeof d === "object") {
    keys = Object.keys(d);
    const cand = d.trend ?? d.list ?? d.data ?? d.points;
    if (Array.isArray(cand)) pts = cand;
  }
  console.log(`\n  ▸ ${t.dateType}  moduleType=${t.m}  code=${t.code ?? "?"} ${t.err ? "ERR " + t.err : ""}`);
  if (t.msg && t.msg.length > 3) console.log(`     msg: ${t.msg}`);
  if (!d) { console.log(`     data=null`); continue; }
  console.log(`     顶层键: ${keys.join(", ")}`);
  if (pts) {
    console.log(`     ★ 点数 ${pts.length}  前2: ${compat(JSON.stringify(pts.slice(0, 2)), 240)}`);
    console.log(`              末1: ${compat(JSON.stringify(pts.slice(-1)), 160)}`);
  } else {
    console.log(`     值: ${compat(JSON.stringify(d), 300)}`);
  }
}

console.log("\n\n══ B. flow/module（近7天）══");
const f = out.flow;
console.log(`  code=${f?.code} msg=${compat(f?.msg, 60)}`);
if (f?.data) {
  for (const [k, v] of Object.entries(f.data)) {
    console.log(`     ${k} = ${compat(v && typeof v === "object" ? JSON.stringify(v) : v, 180)}`);
  }
}

await cdp.close();
