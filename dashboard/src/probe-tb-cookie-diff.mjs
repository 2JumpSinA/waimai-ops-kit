/**
 * 对比品牌A / 品牌B两套闪购 cookie 的**名字集合**，找出品牌B缺了什么。
 *   node src/probe-tb-cookie-diff.mjs
 *
 * 背景：品牌B闪购页面在浏览器里**是登录着的**（显示「品牌B大药房（上海眼镜）」），
 * 但 Node 侧 MTOP 调用报 `FAIL_SYS_TOKEN_EMPTY`。品牌A同一套代码却正常。
 * => 差异在 cookie 集合，不在代码或登录。
 *
 * 🔒 只比较**名字**，不打印任何值。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCookieString } from "./lib/cookie.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const read = (stem) => {
  const p = join(ROOT, ".secrets", `${stem}.cookie.txt`);
  if (!existsSync(p)) return null;
  return parseCookieString(readFileSync(p, "utf8")).cookies;
};

const a = read("taobao");
const b = read("taobao-yifeng");

console.log(`品牌A taobao        : ${a ? Object.keys(a).length : 0} 项`);
console.log(`品牌B taobao-yifeng : ${b ? Object.keys(b).length : 0} 项\n`);

if (!a || !b) { console.error("缺文件"); process.exit(1); }

const ka = Object.keys(a).sort();
const kb = Object.keys(b).sort();

console.log("── 品牌A有、品牌B没有（这些就是嫌疑）──");
const onlyA = ka.filter((k) => !(k in b));
if (onlyA.length) for (const k of onlyA) console.log(`   ✂️  ${k}`);
else console.log("   (无)");

console.log("\n── 品牌B有、品牌A没有 ──");
const onlyB = kb.filter((k) => !(k in a));
if (onlyB.length) for (const k of onlyB) console.log(`   +  ${k}`);
else console.log("   (无)");

console.log("\n── 两边都有 ──");
console.log("   " + ka.filter((k) => k in b).join(", "));

// 阿里 MTOP 常见的关键项
const KEY = ["_m_h5_tk", "_m_h5_tk_enc", "cookie2", "_l_g_", "sgcookie", "cna",
             "WMSTOKEN", "WMUSS", "_tb_token_", "t", "unb", "lgc", "tracknick", "cookie17"];
console.log("\n── 关键项对照 ──");
console.log(`   ${"name".padEnd(16)} 品牌A   品牌B`);
for (const k of KEY) {
  const inA = k in a ? "有" : "—";
  const inB = k in b ? "有" : "—";
  const mark = inA !== inB ? "  ← 差异" : "";
  console.log(`   ${k.padEnd(16)} ${inA.padEnd(5)} ${inB.padEnd(5)}${mark}`);
}
