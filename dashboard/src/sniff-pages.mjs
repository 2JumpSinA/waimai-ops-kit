/**
 * 逐页嗅探：访问业务页面，记录它们真实调用的接口。
 *   node src/sniff-pages.mjs [--port=9222]
 *
 * 这是补齐接口地图最省事的办法 —— 静态分析找不到的接口（商品、配送），
 * 让页面自己走一遍就全暴露了。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieHeader } from "./lib/cookie.mjs";
import { connectToPage, setCookies, waitSignedReady } from "./lib/cdp.mjs";

const DOMAIN = "yiyao.meituan.com";
const FRAME = `https://${DOMAIN}/main/frame`;
const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT = portArg ? Number(portArg.split("=")[1]) : 9222;

const COOKIE = loadCookieHeader("meituan");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 要探的页面（来自 /queryMenu 的真实菜单） */
const PAGES = [
  ["商品分析", "/page/analysis/commodity"],
  ["商品列表-多店", "/page/product/list/multi-store"],
  ["服务分析(配送履约)", "/page/analysis/service/o2o"],
  ["顾客分析", "/page/analysis/customer"],
  ["经营首页o2o", "/page/analysis/home/o2o"],
  ["报表", "/page/analysis/report"],
  ["搜索洞察", "/page/analysis/search-insight"],
  ["营销-活动管理", "/pages/health/marketing/activity-manage/manage"],
  ["营销-低价活动", "/pages/health/marketing/low_price_campaign/list"],
  ["营销-会员数据", "/pages/health/marketing/member-data"],
];

const cdp = await connectToPage(PORT);
await setCookies(cdp, COOKIE, DOMAIN);
await cdp.send("Page.navigate", { url: FRAME });
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 });
console.log("🔏 签名就绪，开始逐页嗅探\n");

/** 当前正在采集的桶 */
let bucket = null;
const perPage = new Map();
const jsAssets = new Set();

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (/\.js(\?|$)/.test(url)) jsAssets.add(url.split("?")[0]);
  if (!bucket) return;
  if (!url.startsWith(`https://${DOMAIN}`)) return;
  if (/\.(js|css|png|jpe?g|svg|woff2?|ico|xml)(\?|$)/.test(url)) return;
  if (p.request?.method === "OPTIONS") return;
  const path = url.replace(`https://${DOMAIN}`, "").split("?")[0];
  if (!path.startsWith("/") || path === "/main/frame") return;
  if (!bucket.has(path)) bucket.set(path, { method: p.request.method, full: url });
});

for (const [label, path] of PAGES) {
  bucket = new Map();
  try {
    await cdp.send("Page.navigate", { url: `https://${DOMAIN}${path}` });
  } catch (e) {
    console.log(`⛔ ${label}  ${path}  导航失败：${e.message}\n`);
    continue;
  }
  await sleep(8000);
  const title = await cdp
    .send("Runtime.evaluate", { expression: "document.title + ' | ' + location.pathname", returnByValue: true })
    .then((r) => r.result?.value)
    .catch(() => "?");
  perPage.set(label, { path, title, api: [...bucket.entries()].map(([p, v]) => ({ p, ...v })) });

  console.log(`──── ${label}  ${path}`);
  console.log(`     实际页面: ${title}`);
  if (bucket.size === 0) console.log("     （未捕获到接口调用）");
  for (const [p, v] of bucket) {
    const q = v.full.includes("?") ? "?" + v.full.split("?")[1].replace(/&?(yodaReady|csecplatform|csecversion|mtgsig)=[^&]*/g, "").replace(/^&|&$/g, "").slice(0, 110) : "";
    console.log(`     ${v.method.padEnd(4)} ${p}${q}`);
  }
  console.log();

  // 回到 frame，保证下一个页面从干净状态开始
  await cdp.send("Page.navigate", { url: FRAME });
  await sleep(2500);
}

await mkdir("_recon/raw", { recursive: true });
await writeFile(
  "_recon/raw/sniff-pages.json",
  JSON.stringify({ pages: Object.fromEntries(perPage), jsAssets: [...jsAssets].sort() }, null, 2),
);

console.log(`\n════ 累计 JS 资源 ${jsAssets.size} 个 ════`);
for (const u of [...jsAssets].sort()) {
  if (/yiyao|awp|health|retail|product|analysis|marketing/i.test(u)) console.log("  " + u);
}
console.log("\n落盘：_recon/raw/sniff-pages.json");
await cdp.close();
