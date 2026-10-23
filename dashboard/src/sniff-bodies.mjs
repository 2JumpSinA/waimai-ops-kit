/**
 * 定向嗅探 POST 请求体：抓出商品分析/服务分析的真实 body。
 *   node src/sniff-bodies.mjs [--port=9222]
 *
 * 背景：这些接口是 POST 且筛选条件在 body 里，静态分析看不出字段名，
 * 只能让页面自己走一遍，把它真正发出去的 body 录下来。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieHeader } from "./lib/cookie.mjs";
import { connectToPage, setCookies, waitSignedReady } from "./lib/cdp.mjs";

const DOMAIN = "yiyao.meituan.com";
const FRAME = `https://${DOMAIN}/main/frame`;
const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;

const COOKIE = loadCookieHeader("meituan");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只探差 body 的那几个页面 */
const PAGES = [
  ["商品分析", "/page/analysis/commodity"],
  ["服务分析", "/page/analysis/service/o2o"],
  ["低价活动", "/pages/health/marketing/low_price_campaign/list"],
];

const cdp = await connectToPage(PORT);
await setCookies(cdp, COOKIE, DOMAIN);
await cdp.send("Page.navigate", { url: FRAME });
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 });
console.log("🔏 就绪\n");

let bucket = null;
const captured = new Map();

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (!bucket) return;
  if (!url.startsWith(`https://${DOMAIN}`)) return;
  if (/\.(js|css|png|jpe?g|svg|woff2?|ico|xml)(\?|$)/.test(url)) return;
  const path = url.replace(`https://${DOMAIN}`, "").split("?")[0];
  if (!captured.has(path)) {
    captured.set(path, {
      method: p.request.method,
      path,
      query: url.includes("?") ? url.split("?")[1] : "",
      contentType: p.request.headers?.["Content-Type"] ?? p.request.headers?.["content-type"],
      postData: p.request.postData,
    });
  }
});

const out = {};
for (const [label, path] of PAGES) {
  bucket = new Map();
  captured.clear();
  await cdp.send("Page.navigate", { url: `https://${DOMAIN}${path}` });
  await sleep(9000);
  /** 部分接口是交互后才发的，点一下页面再等一轮 */
  await cdp
    .send("Runtime.evaluate", {
      expression: `(() => { const b=[...document.querySelectorAll('button,div[role=button],.roo-btn')].find(x=>/查询|搜索|筛选|确定/.test(x.innerText||'')); if(b){b.click(); return 'clicked:'+b.innerText.trim().slice(0,12);} return 'nobtn'; })()`,
      returnByValue: true,
    })
    .then((r) => console.log(`   [${label}] 交互: ${r.result?.value}`))
    .catch(() => {});
  await sleep(5000);

  out[label] = [...captured.values()];
  console.log(`\n════ ${label} ════`);
  for (const c of out[label]) {
    console.log(`  ${c.method} ${c.path}`);
    if (c.postData) console.log(`     ct=${c.contentType ?? "?"}\n     body=${c.postData.slice(0, 700)}`);
  }
  await cdp.send("Page.navigate", { url: FRAME });
  await sleep(2500);
}

await mkdir("_recon/raw", { recursive: true });
await writeFile("_recon/raw/bodies.json", JSON.stringify(out, null, 2));
console.log("\n落盘 _recon/raw/bodies.json");
await cdp.close();
