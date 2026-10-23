/**
 * 校验 dashboard.html 是否真的"能双击打开"。
 *   node src/check-dashboard-selfcontained.mjs
 *
 * 单文件看板只有一个硬要求：不加载任何外部资源、不发任何网络请求。
 * 只要有一条外链，断网或换台机器打开就是白屏。
 *
 * ⚠️ 判据要分区扫描。整文件正则会把内联的 ECharts/zrender 压缩代码当成外链
 *    （那里的 `toDataURL`、`url(`、Apache 许可证注释里的 `http://` 全是源码文本，
 *    不是加载动作），报一堆假警——假警比不报更坏，会让人以后直接无视这个检查。
 *    所以：
 *      · HTML 标签类（script/link/img/iframe）只扫 <script>/<style> 之外的片段
 *      · CSS 的 url() 只扫 <style> 内部
 *      · 网络调用类（fetch/XHR/动态 import）才需要扫全文——那是真信号
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "dashboard.html");
const raw = readFileSync(FILE, "utf8");

// 切出三个区域
const scripts = [...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
const styles = [...raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
const markup = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

const CHECKS = [
  // [标签, 正则, 扫哪个区域, 是否致命]
  ["<script src=>", /<script[^>]*\ssrc=/gi, markup, true],
  ["<link href=>", /<link[^>]*\shref=/gi, markup, true],
  ["<img src=> 非 data:", /<img[^>]*\ssrc=["'](?!data:)/gi, markup, true],
  ["<iframe>", /<iframe/gi, markup, true],
  ["@import", /@import/gi, styles, true],
  ["CSS url() 非 data:", /url\(\s*["']?(?!data:|#)/gi, styles, true],
  ["裸 fetch(", /(?:^|[^.\w$])fetch\s*\(/g, raw, true],
  ["new XMLHttpRequest", /new\s+XMLHttpRequest/g, raw, true],
  ["动态 import(", /(?:^|[^.\w$])import\s*\(/g, scripts, true],
  ["importScripts", /importScripts/g, raw, true],
  ["运行时插 <script>", /createElement\(\s*["']script["']/gi, raw, true],
];

console.log(`文件   ${FILE}`);
console.log(`大小   ${(statSync(FILE).size / 1024 / 1024).toFixed(2)} MB，${raw.length} 字符`);
console.log(`区域   markup ${markup.length} / styles ${styles.length} / scripts ${scripts.length}`);
console.log("");

let bad = 0;
for (const [label, re, where] of CHECKS) {
  const hits = where.match(re) || [];
  if (hits.length) bad += hits.length;
  console.log(`  ${hits.length ? "⚠️" : "✅"} ${label.padEnd(20)} ${hits.length}`);
  for (const h of hits.slice(0, 3)) {
    const pos = where.indexOf(h);
    console.log(`        … ${JSON.stringify(where.slice(Math.max(0, pos - 40), pos + 70))}`);
  }
}

// 除自身以外的本地文件引用
const localRefs = [...raw.matchAll(/(?:src|href)\s*=\s*["'](?!data:|#|https?:)([^"']+)["']/gi)]
  .map((m) => m[1])
  .filter((v) => !v.startsWith("javascript:"));
console.log("");
console.log(`  ${localRefs.length ? "⚠️" : "✅"} 本地文件引用           ${localRefs.length}${localRefs.length ? " -> " + localRefs.slice(0, 5).join(", ") : ""}`);
bad += localRefs.length;

console.log("");
console.log("数据完整性（中文必须用 Node 读，PowerShell 读 UTF-8 会损坏）：");
for (const w of ["品牌A", "品牌B", "预计收入", "推广占比", "取消单"]) {
  console.log(`  · 「${w}」 ${raw.split(w).length - 1} 次`);
}

const at = raw.indexOf("const VM =");
console.log("");
if (at < 0) {
  console.log("  ❌ 找不到内嵌数据载体 `const VM =`");
  bad++;
} else {
  const head = raw.slice(at, at + 260);
  console.log(`  ✅ 内嵌数据载体 ${JSON.stringify(head.slice(0, 240))}`);
  const projects = raw.match(/"projectOrder":\[([^\]]*)\]/);
  console.log(`     项目顺序 = ${projects ? projects[1] : "?"}`);
}

console.log("");
if (bad === 0) console.log("✅ 完全自包含，可离线双击打开。");
else console.log(`❌ 发现 ${bad} 处可疑外部依赖，双击可能白屏。`);
process.exit(bad === 0 ? 0 : 1);
