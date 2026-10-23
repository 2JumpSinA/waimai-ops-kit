/**
 * 探测：订单里哪一层带门店 id。
 *   node probe-orderitem2.mjs [--account=quanyi|yifeng]
 *
 * 动机：fetch-meituan-today 想按门店聚合「取消单排行」，但 commonInfo 41 个键里
 * **没有 poi 字段**（实测），所以门店一定在 orderInfo 的某个 *BasicInfo 子块里。
 */
import { connectToPage, evaluate } from "./src/lib/cdp.mjs";
import { loadCookieHeader, parseCookieString } from "./src/lib/cookie.mjs";
import { resolveAccount } from "./src/lib/account.mjs";

const acct = resolveAccount(process.argv);
const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const COOKIE = loadCookieHeader(STEM);
const iso = () => {
  const t = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const cdp = await connectToPage(acct.port);
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await new Promise((r) => setTimeout(r, 9000));

const raw = await evaluate(
  cdp,
  `(async () => {
     const body = new URLSearchParams({ tag:'history_all',
       pageParam: JSON.stringify({pageSize:2,pageNum:1,sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
       extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
       startDate:'${iso()}', endDate:'${iso()}' });
     const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
     return await r.text();
   })()`,
);
const j = JSON.parse(raw);
const item = j.data?.orderList?.[0];
if (!item) {
  console.log("没有订单（今天可能还没单）");
  process.exit(0);
}
const oi = JSON.parse(item.orderInfo ?? "{}");

for (const [block, val] of Object.entries(oi)) {
  console.log(`\n═══ ${block} ═══`);
  if (val && typeof val === "object" && !Array.isArray(val)) {
    for (const [k, v] of Object.entries(val)) {
      const s = JSON.stringify(v);
      const mark = /poi|shop|store|Poi|Shop|Store/.test(k) ? " ★" : "";
      console.log(`   ${k.padEnd(36)}${mark} ${s && s.length > 90 ? s.slice(0, 90) + "…" : s}`);
    }
  } else {
    console.log(`   ${JSON.stringify(val)}`);
  }
}

// 只在带 poi/shop/store 的字段上做总结
console.log(`\n═══ 命中门店语义的字段 ═══`);
const hits = [];
const walk = (o, p) => {
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if (/poi|shop|store/i.test(k) && (typeof v === "string" || typeof v === "number")) hits.push([`${p}.${k}`, v]);
      walk(v, `${p}.${k}`);
    }
  }
};
walk(oi, "orderInfo");
walk(JSON.parse(item.commonInfo ?? "{}"), "commonInfo");
for (const [k, v] of hits) console.log(`   ${k} = ${JSON.stringify(v)}`);

await cdp.close();
