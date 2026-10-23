import { connectToPage, evaluate } from "./src/lib/cdp.mjs";
import { loadCookieHeader, parseCookieString } from "./src/lib/cookie.mjs";
const COOKIE = loadCookieHeader("meituan");
const ACCT_ID = parseCookieString(COOKIE).cookies.acctId;
const iso = () => { const t=new Date(); const p=n=>String(n).padStart(2,"0"); return `${t.getFullYear()}-${p(t.getMonth()+1)}-${p(t.getDate())}`; };
const cdp = await connectToPage(9222);
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await new Promise(r=>setTimeout(r,9000));
const raw = await evaluate(cdp, `(async () => {
  const body = new URLSearchParams({ tag:'history_all',
    pageParam: JSON.stringify({pageSize:2,pageNum:1,sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
    extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
    startDate:'${iso()}', endDate:'${iso()}' });
  const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
    method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
  return await r.text();
})()`);
const j = JSON.parse(raw);
const item = j.data.orderList[0];
console.log("orderList[0] 顶层键:", Object.keys(item));
console.log("\n非 JSON 字符串的字段:");
for (const [k,v] of Object.entries(item)) {
  if (typeof v !== "string" || (v.length < 200 && !v.trim().startsWith("{"))) console.log("  ", k, "=", JSON.stringify(v));
}
const oi = JSON.parse(item.orderInfo ?? "{}");
console.log("\norderInfo 键:", Object.keys(oi));
for (const [k,v] of Object.entries(oi)) {
  const s = JSON.stringify(v);
  if (/poi|shop|store|name|Name|id|Id/i.test(k)) console.log("  ", k, "=", s && s.length>120 ? s.slice(0,120)+"…" : s);
}
await cdp.close();
