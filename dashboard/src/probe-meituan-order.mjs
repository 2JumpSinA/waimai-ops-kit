/**
 * 直接调美团医药订单汇总接口，与页面显示值对齐。
 *   node src/probe-meituan-order.mjs [--port=9222]
 *
 * 目标接口（来自嗅探）：
 *   POST /api/retail/v3/order/todayOrderSummary/query   poiId=-1&acctId=<id>
 *   POST /gw/api/unified/r/order/list/interval          isCountReq=true...
 *   GET  /v2/order/receive/r/countAndSumOfToday
 *   POST /gw/api/unified/r/order/list/count             menuTags=[...]&requestWmPoiId=-1
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;

const cdp = await connectToPage(PORT);
const st = JSON.parse(await evaluate(cdp, `JSON.stringify({u:location.href,t:document.title,now:new Date().toString()})`));
console.log(`页面：${st.t}\n      ${st.u}`);
console.log(`浏览器本地时间：${st.now}\n`);

const ACCT = "236679097";

const res = await evaluate(
  cdp,
  `(async () => {
     const out = {};
     const post = async (url, body, json) => {
       const init = { method:'POST', credentials:'include' };
       if (json) { init.headers={'Content-Type':'application/json'}; init.body = JSON.stringify(body); }
       else { init.headers={'Content-Type':'application/x-www-form-urlencoded'}; init.body = new URLSearchParams(body).toString(); }
       const r = await fetch(url, init);
       const t = await r.text();
       return { status: r.status, text: t.slice(0, 1200) };
     };
     const get = async (url) => {
       const r = await fetch(url, { credentials:'include' });
       return { status: r.status, text: (await r.text()).slice(0, 1200) };
     };
     out.todayOrderSummary = await post('/api/retail/v3/order/todayOrderSummary/query', { poiId:'-1', acctId:'${ACCT}' });
     out.countAndSumOfToday = await get('/v2/order/receive/r/countAndSumOfToday');
     out.orderInterval = await post('/gw/api/unified/r/order/list/interval', { isAutoAccept:'0', dateAndSeq:'', countDateAndSeq:'', isCountReq:'true', scIndex:'2' });
     out.orderCount = await post('/gw/api/unified/r/order/list/count', { menuTags:'["order_logisticsAbnormal"]', requestWmPoiId:'-1' });
     out.serverTime = Date.now();
     return JSON.stringify(out);
   })()`,
);

const o = JSON.parse(res);
for (const [k, v] of Object.entries(o)) {
  if (k === "serverTime") { console.log(`\n浏览器 Date.now() = ${v}  (${new Date(v).toString()})`); continue; }
  console.log(`\n──── ${k}  [${v.status}]`);
  console.log("     " + String(v.text).replace(/\s+/g, " ").slice(0, 900));
}
await cdp.close();
