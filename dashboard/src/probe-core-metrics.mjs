/**
 * 把 core 在 last_7_days / last_30_days 下返回的**全部指标字段**倒出来。
 *   node src/probe-core-metrics.mjs [--account=quanyi]
 *
 * 目的：确认平台到底提供哪些窗口指标，特别是**取消单 / 退款**有没有聚合。
 *   multiAllRefundOrderQuantity 是「全退款订单量」，与美团 status==9 的取消单**不是一回事**，
 *   而「取消单数量与占比」是经营者点名的四项核心指标之一。
 *
 * 不打印 cookie / token / mtgsig。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;
const TARGET = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";

const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 2500));
await cdp.send("Page.navigate", { url: TARGET });
await new Promise((r) => setTimeout(r, 28_000));

const out = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const pad = (n) => String(n).padStart(2, '0');
     const d = (off) => { const t = new Date(Date.now() + off * 86400000); return t.getFullYear() + pad(t.getMonth()+1) + pad(t.getDate()); };
     const common = { ignoreSetRouterProxy: 'true', businessType: '1', storeType: '2', cityId: '', labelId: '' };
     const res = {};
     for (const [tag, dt, b, cb, ce] of [
       ['last_7_days',  'last_7_days',  d(-7),  d(-14), d(-8)],
       ['last_30_days', 'last_30_days', d(-30), d(-60), d(-31)],
     ]) {
       const url = '/api/page/bizdata/manageHome/multi/o/core?' + qs({
         ...common, dateType: dt, beginTime: b, endTime: d(-1),
         compareBeginTime: cb, compareEndTime: ce,
       });
       const r = await fetch(url, { credentials: 'include' });
       const j = await r.json().catch(() => null);
       res[tag] = j?.data ?? null;
     }
     return res;
   })()`,
  { timeoutMs: 180_000 },
);

/** 指标值藏在 amount / turnover / averagePrice 里 */
const unwrap = (v) => {
  if (v == null) return null;
  if (typeof v !== "object") return v;
  for (const k of ["amount", "turnover", "averagePrice", "value", "count", "num"]) {
    if (k in v) return v[k];
  }
  return JSON.stringify(v).slice(0, 70);
};

for (const [tag, data] of Object.entries(out)) {
  console.log(`\n════ ${tag} ════`);
  if (!data) { console.log("   （null —— 说明这个 dateType 不被接受）"); continue; }
  const keys = Object.keys(data).sort();
  console.log(`   共 ${keys.length} 个字段：\n`);
  for (const k of keys) {
    const v = data[k];
    const s = unwrap(v);
    const flag = /cancel|refund|projectedincome|dealamount|volume/i.test(k) ? "⭐" : "  ";
    console.log(`   ${flag} ${k.padEnd(38)} = ${String(s).slice(0, 60)}`);
  }
}

console.log("\n════════════════════════════════════════════════════════════");
console.log("找 cancel / refund 字样的字段 —— 有则取消单可能也能聚合，没有则仍需订单列表。");
await cdp.close();
