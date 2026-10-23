/**
 * 挖订单的 orderChargeBlockBO —— 找单笔「预计收入」
 *   node src/probe-mt-charge.mjs [--port=9222]
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;
const iso = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const cdp = await connectToPage(PORT);

const raw = await evaluate(
  cdp,
  `(async () => {
     const body = new URLSearchParams({
       tag:'history_all',
       pageParam: JSON.stringify({pageSize:3,pageNum:1,sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
       extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
       startDate:'${iso(0)}', endDate:'${iso(0)}',
     });
     const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
     return await r.text();
   })()`,
);

const j = JSON.parse(raw);
const list = j.data?.orderList ?? [];
console.log(`订单 ${list.length} 条\n`);

const oi = JSON.parse(list[0].orderInfo);
console.log("═══ orderChargeBlockBO（原样）═══");
console.log(JSON.stringify(oi.orderChargeBlockBO, null, 2).slice(0, 2200));

console.log("\n═══ 该块里所有含 income 的键（递归找）═══");
const walk = (o, path = "", out = []) => {
  if (o === null || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o)) {
    const p = path ? `${path}.${k}` : k;
    if (/income/i.test(k)) out.push([p, v]);
    walk(v, p, out);
  }
  return out;
};
const found = walk(oi);
if (found.length) for (const [p, v] of found) console.log(`   ${p} = ${JSON.stringify(v)}`);
else console.log("   （无含 income 的键）");

console.log("\n═══ 全响应里含 income 的片段 ═══");
for (const m of raw.matchAll(/.{80}[Ii]ncome.{120}/g)) {
  console.log("   …" + m[0].replace(/\s+/g, " "));
  if (--globalThis.__n < 0) break;
}
await cdp.close();
