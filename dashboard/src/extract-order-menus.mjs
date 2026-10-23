/**
 * 从订单页抓包存档里抽出**完整菜单树**：tag + filterMenus[].code。
 *   node src/extract-order-menus.mjs
 *
 * 为什么要这个：
 *   取消单的计数迟迟找不到聚合接口。而抓包 `_recon/sniff-meituan-order.json` 里
 *   有一份菜单配置响应，形如：
 *     {"name":"全部","tag":"order_all","filterMenus":[{"name":"全部","code":14}, ...]}
 *   `extParam.searchTag` 就是这里的 **code**（14 = 全部）。
 *   把全部 code 列出来，「已取消」对应的 code 自然就有了 —— 不用登录、不用点 UI。
 *
 * 只读本地存档，不联网、不需要登录。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "_recon", "sniff-meituan-order.json");

if (!existsSync(FILE)) { console.error(`缺 ${FILE}`); process.exit(1); }
const raw = readFileSync(FILE, "utf8");
console.log(`读 ${FILE}  (${(raw.length / 1024).toFixed(0)} KB)`);

/** 存档是若干条目组成的数组，每条带 body 字段 */
let entries;
try {
  entries = JSON.parse(raw);
} catch (e) {
  console.error(`不是合法 JSON：${e.message}`);
  process.exit(1);
}
const list = Array.isArray(entries) ? entries : [entries];
console.log(`条目数: ${list.length}\n`);

/** 找出含菜单树的响应体 */
const found = [];
const walk = (node, path = "") => {
  if (node == null) return;
  if (typeof node === "string") {
    if (node.includes("filterMenus") && node.includes("retail_order")) {
      found.push({ path, text: node });
    }
    return;
  }
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
};
walk(list);

console.log(`含菜单树的字符串: ${found.length} 处`);
if (!found.length) {
  console.log("没找到 —— 存档结构可能变了，把顶层键打出来看看：");
  console.log(JSON.stringify(list[0], null, 2).slice(0, 800));
  process.exit(1);
}

let printed = 0;
for (const f of found) {
  let obj;
  try { obj = JSON.parse(f.text); } catch { continue; }
  const menus = obj?.data;
  if (!Array.isArray(menus)) continue;
  printed++;
  console.log(`\n════════ 菜单树 #${printed}  (${f.path}) ════════`);

  for (const group of menus) {
    console.log(`\n■ ${group.name}   tag=${group.tag}`);
    if (group.subMenus) {
      for (const sub of group.subMenus) {
        console.log(`   └ ${sub.name}   tag=${sub.tag}   searchTag(默认)=${sub.filterMenus?.find((x) => x.name === "全部")?.code ?? "?"}`);
        const filters = sub.filterMenus ?? [];
        if (filters.length) {
          console.log(`        筛选: ${filters.map((x) => `${x.name}=${x.code}`).join("  ")}`);
        }
        // 递归更深一层
        for (const deeper of sub.subMenus ?? []) {
          console.log(`        └ ${deeper.name}  tag=${deeper.tag}`);
        }
      }
    }
    const own = group.filterMenus ?? [];
    if (own.length) console.log(`   筛选: ${own.map((x) => `${x.name}=${x.code}`).join("  ")}`);
  }

  // 专门把「取消」相关的挑出来
  const all = [];
  const collect = (n, chain) => {
    if (!n) return;
    for (const m of n) {
      const c = [...chain, m.name];
      if (m.tag) all.push({ chain: c.join(" > "), tag: m.tag });
      for (const f of m.filterMenus ?? []) all.push({ chain: c.join(" > "), filter: f.name, code: f.code });
      collect(m.subMenus, c);
    }
  };
  collect(menus, []);

  const cancel = all.filter((x) => /取消|退|售后|关闭/.test(x.filter ?? "") || /取消|退|售后|关闭/.test(x.chain));
  console.log(`\n   ⭐ 命中「取消/退/售后」的条目（${cancel.length}）:`);
  for (const c of cancel) {
    console.log(`      ${c.chain}${c.filter ? " > " + c.filter : ""}${c.code != null ? `   code=${c.code}` : ""}${c.tag ? `   tag=${c.tag}` : ""}`);
  }

  console.log(`\n   全部 tag（${all.filter((x) => x.tag).length}）:`);
  console.log("      " + all.filter((x) => x.tag).map((x) => x.tag).join(", "));
  console.log(`\n   全部 filterMenus code（${all.filter((x) => x.code != null).length}）:`);
  console.log("      " + all.filter((x) => x.code != null).map((x) => `${x.filter}=${x.code}`).join("  "));
}
