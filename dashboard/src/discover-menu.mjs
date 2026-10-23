/**
 * 菜单 / 应用注册表勘探：找出商品·配送等模块的页面入口。
 *   node src/discover-menu.mjs [--port=9222]
 *
 * 动机：经营总览、评价、多店对比、营销都已有接口；但商品排行与配送履约
 * 在首页包里没有接口 —— 它们在**其它微前端子应用**里。
 * 与其猜 URL，不如直接问后台要菜单和应用注册表。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieHeader, cookieValue } from "./lib/cookie.mjs";
import { connectToPage, setCookies, waitSignedReady, pageFetchAll } from "./lib/cdp.mjs";

const DOMAIN = "yiyao.meituan.com";
const FRAME = `https://${DOMAIN}/main/frame`;
const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT = portArg ? Number(portArg.split("=")[1]) : 9222;

const COOKIE = loadCookieHeader("meituan");
const ACCT = cookieValue(COOKIE, "acctId");

const cdp = await connectToPage(PORT);
console.log(`✅ 已连接 ${PORT}（${cdp.browser}）`);
await setCookies(cdp, COOKIE, DOMAIN);
await cdp.send("Page.navigate", { url: FRAME });
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 });
console.log("🔏 签名就绪\n");

const res = await pageFetchAll(cdp, [
  { key: "queryMenu", path: "/queryMenu" },
  { key: "appsJson", path: "/tiny_project_config/yiyao-shangjia/prod/apps.json" },
  { key: "permissions", path: `/sc/retail/account/r/permissions?wmPoiId=-1&poiId=-1&acctId=${ACCT}` },
  { key: "freqMenu", path: "/api/health/center/menu/getPoiFrequentlyUsedMenu" },
  { key: "taskMenuConfig", path: "/api/health/center/task/menuConfig" },
]);

await mkdir("_recon/raw", { recursive: true });
await writeFile("_recon/raw/menu.json", JSON.stringify(res, null, 2));

/** 从任意嵌套结构里捞出所有像“页面路径”的字符串 */
function collectPaths(node, out = new Set(), depth = 0) {
  if (depth > 12 || node == null) return out;
  if (typeof node === "string") {
    if (/^\/[\w\-/]{3,120}$/.test(node) && /\//.test(node.slice(1))) out.add(node);
    if (/^https?:\/\/[\w.\-]+\/[\w\-/.]*\.js/.test(node)) out.add(node);
    return out;
  }
  if (Array.isArray(node)) { for (const x of node) collectPaths(x, out, depth + 1); return out; }
  if (typeof node === "object") { for (const v of Object.values(node)) collectPaths(v, out, depth + 1); }
  return out;
}

for (const [k, v] of Object.entries(res)) {
  const d = v.data;
  console.log(`──── ${k}  status=${v.status} code=${v.code}`);
  if (d === undefined || d === null) { console.log("   (空)\n"); continue; }
  const paths = collectPaths(d);
  console.log(`   顶层: ${Array.isArray(d) ? `[${d.length}]` : typeof d === "object" ? JSON.stringify(Object.keys(d).slice(0, 25)) : JSON.stringify(d).slice(0, 200)}`);
  if (paths.size) {
    console.log(`   路径/资源 ${paths.size} 条:`);
    for (const p of [...paths].sort().slice(0, 120)) console.log("      " + p);
  }
  console.log();
}

await cdp.close();
