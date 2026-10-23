/**
 * 定位「列表标签错误」到底是哪个变量引起的。
 *   node src/probe-orderlist-matrix.mjs [--account=quanyi]
 *
 * 从嗅探得知真实请求是：
 *   POST /gw/api/unified/r/order/list/page/history
 *        ?ignoreSetRouterProxy=true&yodaReady=h5&csecplatform=4
 *   Referer: https://yiyao.meituan.com/page/orderbusiness
 * 而我们只带了 `?ignoreSetRouterProxy=true`，且停在 /main/frame。
 *
 * 矩阵：{ 页面上下文 } × { 是否补 URL 参数 }，各打一次，看哪个组合能返回 code=0。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;

const PAGES = {
  frame: "https://yiyao.meituan.com/main/frame",
  orderPage: "https://yiyao.meituan.com/main/frame#/page/orderbusiness#/order/history",
};
const URLS = {
  bare: "/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true",
  full: "/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true&yodaReady=h5&csecplatform=4",
};

const cdp = await connectToPage(PORT);

const attempt = async (pageKey, urlKey) => {
  await cdp.send("Page.navigate", { url: PAGES[pageKey] });
  await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 45_000 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 3500));
  return JSON.parse(
    await evaluate(
      cdp,
      `(async () => {
         const p = (n) => String(n).padStart(2,'0');
         const t = new Date();
         const day = t.getFullYear() + '-' + p(t.getMonth()+1) + '-' + p(t.getDate());
         const body = new URLSearchParams({
           tag: 'history_all',
           pageParam: JSON.stringify({pageSize:5,pageNum:1,sort:0,nextLabel:'',lastLabel:'',direction:0,sortField:1}),
           extParam: JSON.stringify({phfRollback:0,requestWmPoiId:'-1',searchTag:'14'}),
           startDate: day, endDate: day,
         });
         const r = await fetch(${JSON.stringify(URLS[urlKey])}, {
           method:'POST', credentials:'include',
           headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
         const j = await r.json();
         return JSON.stringify({
           status: r.status,
           code: j.code, msg: j.msg,
           orders: j.data?.orderList?.length ?? null,
           total: j.data?.pageInfo?.totalCount ?? null,
           pageUrl: location.href,
         });
       })()`,
    ),
  );
};

console.log("矩阵测试：页面上下文 × URL 参数\n");
const results = [];
for (const pk of Object.keys(PAGES)) {
  for (const uk of Object.keys(URLS)) {
    const r = await attempt(pk, uk);
    const ok = r.code === 0 && r.orders !== null;
    results.push({ pk, uk, ...r, ok });
    console.log(
      `  ${ok ? "✅" : "❌"} 页面=${pk.padEnd(10)} url=${uk.padEnd(5)} ` +
        `-> code=${r.code} msg=${JSON.stringify(r.msg)} orders=${r.orders} total=${r.total}`,
    );
  }
}

const good = results.filter((r) => r.ok);
console.log(`\n可用组合 ${good.length}/${results.length}`);
if (good.length) {
  console.log("建议采用：" + good.map((g) => `页面=${g.pk} + url=${g.uk}`).join("；"));
} else {
  console.log("四种组合都失败 —— 问题不在页面上下文或 URL 参数，需要继续查（body / Referer / 签名）");
}

await cdp.close();
