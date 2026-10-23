/**
 * 定位美团订单级「预计收入」字段
 *   node src/probe-mt-inc3.mjs [--port=9222]
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const iso = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const cdp = await connectToPage(9222);
const raw = await evaluate(
  cdp,
  `(async () => {
     const body = new URLSearchParams({ tag:'history_all',
       pageParam: JSON.stringify({pageSize:3,pageNum:1,sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
       extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
       startDate:'${iso(0)}', endDate:'${iso(0)}' });
     const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true',
       {method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
     return await r.text(); })()`,
);

const d = JSON.parse(raw).data;
const oi = JSON.parse(d.orderList[0].orderInfo);

console.log("═══ settlementItems 全部条目 ═══");
for (const it of oi.orderChargeBlockBO?.settlementItems ?? []) {
  console.log(`  type=${String(it.type).padEnd(3)} ${String(it.name).padEnd(14)} ${it.priceText}`);
}

console.log("\n═══ orderChargeBlockBO 其它顶层键 ═══");
for (const [k, v] of Object.entries(oi.orderChargeBlockBO ?? {})) {
  if (k === "settlementItems") continue;
  console.log(`  ${k} = ${JSON.stringify(v).slice(0, 220)}`);
}

console.log("\n═══ orderInfo 递归找 income/收入/预计 ═══");
const walk = (o, p = "") => {
  if (o === null || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    const q = p ? `${p}.${k}` : k;
    if (/income|收入|预计/i.test(k)) console.log(`  ${q} = ${JSON.stringify(v).slice(0, 180)}`);
    walk(v, q);
  }
};
walk(oi);

console.log("\n═══ orderIndex / extData ═══");
console.log("  orderIndex:", JSON.stringify(d.orderIndex).slice(0, 400));
console.log("  extData   :", JSON.stringify(d.extData).slice(0, 500));

console.log("\n═══ 原响应里所有含 income 的片段 ═══");
let n = 0;
for (const m of raw.matchAll(/.{60}income.{100}/gi)) {
  console.log("   …" + m[0].replace(/\s+/g, " "));
  if (++n >= 8) break;
}
if (!n) console.log("   （无）");
await cdp.close();
