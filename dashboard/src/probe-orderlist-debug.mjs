/**
 * 排查：profile 读到了 token，但订单接口返回 0 单。
 *   node src/probe-orderlist-debug.mjs [--port=9222] [--account=quanyi]
 *
 * 现象：`fetch-meituan-today` 报 `取回 0 单（totalCount=null）`，
 * 而同一个 profile 在浏览器多开一会儿之后再跑就有 88 单。需要看清接口到底回了什么。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = Number(arg("port", String(acct.port)));
const iso = () => {
  const t = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });

const ready = await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 60_000 });
console.log("waitSignedReady:", JSON.stringify(ready).slice(0, 240));

// 多等一会儿，模拟「浏览器开着更久」的情况
await new Promise((r) => setTimeout(r, 6000));

const out = await evaluate(
  cdp,
  `(async () => {
     const p = (n) => String(n).padStart(2, '0');
     const t = new Date();
     const day = t.getFullYear() + '-' + p(t.getMonth()+1) + '-' + p(t.getDate());
     const body = new URLSearchParams({
       tag: 'history_all',
       pageParam: JSON.stringify({pageSize:5,pageNum:1,sort:0,nextLabel:'',lastLabel:'',direction:0,sortField:1}),
       extParam: JSON.stringify({phfRollback:0,requestWmPoiId:'-1',searchTag:'14'}),
       startDate: day, endDate: day,
     });
     const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
     return JSON.stringify({
       day,
       status: r.status,
       pageUrl: location.href,
       pageTitle: document.title,
       text: (await r.text()).slice(0, 600),
     });
   })()`,
);
console.log("订单接口 ->", out);

// 再看一眼门店接口是否正常（它更容易成功，可作为登录态是否有效的旁证）
const poi = await evaluate(
  cdp,
  `(async () => {
     const r = await fetch('/v2/shop/businessStatus/r/poiListSearch?pageNum=1&pageSize=3', { credentials:'include' });
     const t = await r.text();
     return JSON.stringify({ status: r.status, text: t.slice(0, 300) });
   })()`,
);
console.log("门店接口 ->", poi);

await cdp.close();
