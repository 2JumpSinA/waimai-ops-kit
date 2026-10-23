/**
 * 导出淘宝闪购的完整权限菜单树 —— 它决定了这个账号到底能用哪些模块。
 *   node src/dump-menu.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const header = loadCookieHeader("taobao");
const { cookies } = parseCookieString(header);

const r = await mtopCall({ api: "mtop.ele.newretail.ebai.RoleService.getPcPrivilegeMenu", data: {}, cookies });
if (!r.ok) {
  console.error("取菜单失败：", r.ret);
  process.exit(1);
}
const root = r.data?.data ?? r.data;

await mkdir("_recon/raw", { recursive: true });
await writeFile("_recon/raw/eleme-menu.json", JSON.stringify(root, null, 2), "utf8");

let total = 0;
const walk = (node, depth = 0) => {
  const pad = "  ".repeat(depth);
  const name = node.name ?? "(无名)";
  const url = node.url ? ` → ${node.url}` : "";
  const code = node.nodeCode || node.menuCode || node.code || "";
  console.log(`${pad}${depth === 0 ? "▸" : "·"} ${name}${url}${code ? `  [${code}]` : ""}`);
  total++;
  for (const c of node.list ?? []) {
    // 打印该层级所有可用字段名（第一次遇到时）
    walk(c, depth + 1);
  }
};

console.log("可用字段：", JSON.stringify(Object.keys(root)));
console.log("");
for (const m of root.list ?? []) walk(m, 0);
console.log(`\n合计 ${total} 个菜单节点`);

// 顺便把这些菜单节点的**非 name/list 字段**汇总，看有没有 URL / 权限码可用
const fields = new Set();
const collect = (n) => { for (const k of Object.keys(n)) fields.add(k); for (const c of n.list ?? []) collect(c); };
collect(root);
console.log("菜单节点出现过的字段：", [...fields].join(", "));

// 找任何像 URL / 路径的东西
const urls = new Set();
const collectUrls = (n) => {
  for (const [k, v] of Object.entries(n)) {
    if (typeof v === "string" && /^(\/|https?:)/.test(v)) urls.add(`${k}=${v}`);
  }
  for (const c of n.list ?? []) collectUrls(c);
};
collectUrls(root);
if (urls.size) {
  console.log("\n菜单里的 URL / 路径：");
  for (const u of urls) console.log("  " + u);
} else {
  console.log("\n⚠️ 菜单节点里没有任何 URL —— 只有名称与层级");
}
