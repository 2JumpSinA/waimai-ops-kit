/**
 * CDP 通路验证：确认「借页面签名」能拿下之前 403 的路由。
 *   node src/probe-cdp.mjs [--headed]
 *
 * 不写业务数据，只把原始响应落到 _recon/raw/ 便于定字段。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieHeader, cookieValue } from "./lib/cookie.mjs";
import { launchChrome, connectToPage, setCookies, evaluate, waitSignedReady, pageFetchAll } from "./lib/cdp.mjs";

const DOMAIN = "yiyao.meituan.com";
const FRAME = `https://${DOMAIN}/main/frame`;
const headed = process.argv.includes("--headed");
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) : null;

const COOKIE = loadCookieHeader("meituan");
const ACCT = cookieValue(COOKIE, "acctId");
const POI = cookieValue(COOKIE, "wmPoiId");

const t0 = Date.now();
const cdp = port ? await connectToPage(port) : await launchChrome({ headless: !headed });
console.log(`[1] ${port ? `已连接端口 ${port}` : "Chrome 已启动并连上 page target"}（${cdp.browser ?? "自启"}）  +${Date.now() - t0}ms`);

const n = await setCookies(cdp, COOKIE, DOMAIN);
console.log(`[2] 注入 cookie ${n} 项  +${Date.now() - t0}ms`);

await cdp.send("Page.navigate", { url: FRAME });
console.log(`[3] 导航到 ${FRAME}  +${Date.now() - t0}ms`);

const ready = await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 });
console.log(`[4] 签名链路就绪（等待 ${ready.waitedMs}ms）：${JSON.stringify(ready)}`);

const page = await evaluate(
  cdp,
  `JSON.stringify({ url: location.href, title: document.title, hasSdk: typeof window.H5guard, bodyLen: document.body ? document.body.innerText.length : 0 })`,
);
console.log(`[5] 页面状态：${page}`);

console.log("\n──── 在页内重试之前 403 的接口 ────");
const specs = [
  { key: "poiInfo", path: "/v2/sc/index/r/poiInfo/get" },
  { key: "poiListSearch", path: `/v2/shop/businessStatus/r/poiListSearch?acctId=${ACCT}&wmPoiId=${POI}&pageNum=1&pageSize=10` },
  { key: "manageHome_multi_o", path: "/api/page/bizdata/manageHome/multi/o/data?pageItemCode=PITEM101" },
  { key: "manageHome_single_o", path: "/api/page/bizdata/manageHome/single/o/data?pageItemCode=PITEM101" },
  { key: "latestTime", path: "/api/page/bizdata/manageHome/latestTime?dateType=realTime" },
  { key: "analysis_headPoi", path: "/v2/sc/index/r/analysis/headPoi?pageItemCode=PITEM102" },
  {
    key: "home_index",
    path: `/health/center/merchant/home/index?acctId=${ACCT}&businessType=1&poiId=${POI}&items=noReplyToBadComment,qualificationExpired,unsubsidizedGoods,pendingPriceAdjustmentGoods,unreadViolation`,
  },
  { key: "order", path: `/v2/sc/index/r/order?acctId=${ACCT}&businessType=1&poiId=${POI}` },
];

const res = await pageFetchAll(cdp, specs);

for (const [k, v] of Object.entries(res)) {
  const icon = v.status === 200 ? "✅" : v.status === 403 ? "⛔" : "⚠️ ";
  let shape = "";
  if (v.data !== undefined) {
    if (Array.isArray(v.data)) shape = `data[${v.data.length}]`;
    else if (v.data && typeof v.data === "object")
      shape = `data keys=${JSON.stringify(Object.keys(v.data).slice(0, 20))}`;
    else shape = `data=${JSON.stringify(v.data)}`;
  } else if (v.text) shape = v.text.slice(0, 100).replace(/\s+/g, " ");
  console.log(`${icon} [${v.status}] code=${v.code} ${k}\n      ${shape}`);
}

await mkdir("_recon/raw", { recursive: true });
await writeFile("_recon/raw/meituan-cdp-probe.json", JSON.stringify(res, null, 2));
console.log("\n原始响应已落盘：_recon/raw/meituan-cdp-probe.json");

await cdp.close();
console.log(`\n[6] 完成，总耗时 ${Date.now() - t0}ms`);
