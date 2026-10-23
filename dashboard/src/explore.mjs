/**
 * 接口嗅探 + 补全：在真实页面里跑一遍，把隐藏的接口挖出来。
 *   node src/explore.mjs [--port=9222]
 *
 * 解决的问题：
 *   1. 商品排行 / 配送履约 两个板块，静态分析没找到接口 —— 靠嗅探页面真实请求
 *   2. manageHome/single/o 全 null —— 验证是不是 wmPoiId=-1 导致
 *   3. 微前端子应用的 JS 分包，抓下来再扫一遍接口
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieHeader, cookieValue } from "./lib/cookie.mjs";
import { connectToPage, setCookies, evaluate, waitSignedReady, pageFetchAll } from "./lib/cdp.mjs";

const DOMAIN = "yiyao.meituan.com";
const FRAME = `https://${DOMAIN}/main/frame`;
const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT = portArg ? Number(portArg.split("=")[1]) : 9222;

const COOKIE = loadCookieHeader("meituan");
const ACCT = cookieValue(COOKIE, "acctId");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
console.log(`✅ 已连接端口 ${PORT}（${cdp.browser}）`);

// ════════ 嗅探：先开监听，再导航，才能抓到完整请求 ════════
const apiCalls = new Map(); // url → {method, postData, status}
const jsAssets = new Set();

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (!url.includes(DOMAIN)) return;
  if (/\.js(\?|$)/.test(url)) jsAssets.add(url);
  if (/\.(js|css|png|jpe?g|svg|woff2?|ico)(\?|$)/.test(url)) return;
  if (p.request?.method === "OPTIONS") return;
  const key = `${p.request.method} ${url.replace(/\?.*$/, "")}`;
  if (!apiCalls.has(key)) apiCalls.set(key, { full: url, method: p.request.method, postData: p.request.postData });
});
cdp.on("Network.responseReceived", (p) => {
  const u = p.response?.url ?? "";
  const k = Object.keys(Object.fromEntries(apiCalls)).find((x) => apiCalls.get(x).full === u);
  if (k) apiCalls.get(k).status = p.response.status;
});

await setCookies(cdp, COOKIE, DOMAIN);
console.log("🍪 cookie 已注入");

await cdp.send("Page.navigate", { url: FRAME });
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 });
console.log("🔏 签名链路就绪，开始嗅探（重载页面让所有模块发请求）…");

await cdp.send("Page.reload", { ignoreCache: false });
await sleep(9000);

// 再访问几个可能的业务页，触发更多模块
for (const p of ["/page/home", "/page/bizdata/manageHome", "/page/goods", "/page/order"]) {
  try {
    await cdp.send("Page.navigate", { url: `https://${DOMAIN}${p}` });
    await sleep(4500);
  } catch { /* 忽略 */ }
}

console.log(`\n════ A. 嗅探到的接口调用（${apiCalls.size} 个）════`);
const rows = [...apiCalls.entries()].sort();
for (const [, v] of rows) {
  const q = v.full.includes("?") ? "?" + v.full.split("?")[1].slice(0, 90) : "";
  console.log(`  [${v.status ?? "?"}] ${v.method.padEnd(4)} ${v.full.split("?")[0]}`);
  if (q !== "?") console.log(`        ${q}`);
  if (v.postData) console.log(`        body: ${v.postData.slice(0, 120)}`);
}

console.log(`\n════ B. 嗅探到的 JS 分包（${jsAssets.size} 个，用于二次扫接口）════`);
for (const u of [...jsAssets].sort()) console.log("  " + u);

// ════════ 取真实门店 ID，验证 single/o 的 null 是否由 -1 导致 ════════
console.log("\n════ C. 取真实门店并复测单店数据 ════");
const poiRes = await pageFetchAll(cdp, [
  { key: "poiList", path: `/v2/shop/businessStatus/r/poiListSearch?acctId=${ACCT}&pageNum=1&pageSize=200` },
]);
const poiData = poiRes.poiList?.data;
const stores = poiData?.dataList ?? [];
console.log(`  门店总数 totalCount=${poiData?.totalCount}，本页取回 ${stores.length} 家`);
if (stores[0]) console.log(`  门店字段: ${JSON.stringify(Object.keys(stores[0]))}`);

// 营业状态取值分布（字段名会骗人，必须枚举）
const dist = {};
for (const s of stores) dist[s.businessDesc ?? "(空)"] = (dist[s.businessDesc ?? "(空)"] ?? 0) + 1;
console.log(`  businessDesc 分布: ${JSON.stringify(dist)}`);
const statusDist = {};
for (const s of stores) statusDist[s.status] = (statusDist[s.status] ?? 0) + 1;
console.log(`  status 分布:       ${JSON.stringify(statusDist)}`);

const realId = stores.find((s) => s.businessDesc === "营业中")?.id ?? stores[0]?.id;
console.log(`  选定真实门店 id=${realId}（${stores.find((s) => s.id === realId)?.poiName}）`);

if (realId) {
  const test = await pageFetchAll(cdp, [
    { key: "single_with_param", path: `/api/page/bizdata/manageHome/single/o/data?pageItemCode=PITEM101&wmPoiId=${realId}` },
    { key: "single_with_acct", path: `/api/page/bizdata/manageHome/single/o/data?pageItemCode=PITEM101&wmPoiId=${realId}&acctId=${ACCT}` },
    { key: "multi_full", path: `/api/page/bizdata/manageHome/multi/o/data?pageItemCode=PITEM101` },
    { key: "comment_realpoi", method: "POST", path: `/api/support/customer/comment/r/list`, form: { acctId: ACCT, wmPoiId: String(realId), appType: "3", token: cookieValue(COOKIE, "token") ?? "", pageNum: "1", rate: "0", reply: "0", context: "-1", startDate: "2026-08-17", endDate: "2026-09-16", timeType: "1", commentKeyWord: "" } },
  ]);
  for (const [k, v] of Object.entries(test)) {
    const d = v.data;
    const shape = Array.isArray(d)
      ? `[${d.length}]`
      : d && typeof d === "object"
        ? `keys=${JSON.stringify(Object.keys(d).slice(0, 16))}`
        : JSON.stringify(d);
    console.log(`  ${v.status === 200 ? "✅" : "⚠️ "} ${k}: ${shape}`);
    if (k === "single_with_param" && d) console.log(`       值: ${JSON.stringify(d).slice(0, 260)}`);
  }
  await mkdir("_recon/raw", { recursive: true });
  await writeFile("_recon/raw/explore.json", JSON.stringify({ stores, test, apiCalls: [...apiCalls.values()], jsAssets: [...jsAssets] }, null, 2));
  console.log("\n  落盘：_recon/raw/explore.json");
}

await cdp.close();
console.log("\n（连接已断开，浏览器窗口仍在运行）");
