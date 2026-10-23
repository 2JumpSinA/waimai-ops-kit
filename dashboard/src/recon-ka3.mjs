/**
 * 美团营销平台 · 精确定位「推广消耗 / 推广占比 / ROI」相关接口与字段
 *   node src/recon-ka3.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const F = "_recon/ka/js/js__index.b08b25826e9dad12f860.js";
const js = readFileSync(F, "utf8");
console.log(`主包 ${(js.length / 1024).toFixed(0)} KB\n`);

const uniq = (a) => [...new Set(a)];

// ════════ 1. 中文标签 —— 直接反映 UI 上的指标名 ════════
console.log("═".repeat(72));
console.log("  中文标签命中（UI 指标名）");
console.log("═".repeat(72));
const CN = ["推广消耗", "推广占比", "投产比", "推广花费", "消耗", "占比", "ROI", "投入产出", "广告消耗", "推广", "花费", "预算", "余额", "点击量", "曝光量", "转化"];
for (const k of CN) {
  const idxs = [...js.matchAll(new RegExp(k, "g"))].map((m) => m.index);
  if (!idxs.length) { console.log(`  ${k.padEnd(10)} —`); continue; }
  console.log(`  ${k.padEnd(10)} ${idxs.length} 次`);
  // 打印前 3 处的上下文，看旁边的英文字段名
  for (const i of idxs.slice(0, 3)) {
    console.log(`      …${js.slice(Math.max(0, i - 130), i + 90).replace(/\s+/g, " ")}`);
  }
}

// ════════ 2. 英文字段名 ════════
console.log("\n" + "═".repeat(72));
console.log("  英文字段名（cost / roi / ratio 系）");
console.log("═".repeat(72));
const FIELDS = uniq([
  ...js.matchAll(/["']([a-zA-Z][\w]*(?:[Cc]ost|[Rr]oi|[Ss]pend|[Cc]onsume|[Rr]atio|[Bb]udget|[Bb]alance)[\w]*)["']/g),
].map((m) => m[1]));
console.log(`  共 ${FIELDS.length} 个：`);
for (const f of FIELDS.sort()) console.log("    " + f);

// ════════ 3. 全部 /bff /ad /account 接口 ════════
console.log("\n" + "═".repeat(72));
console.log("  全部候选接口（按前缀分组）");
console.log("═".repeat(72));
const paths = uniq([...js.matchAll(/"(\/[\w\-/]{6,140})"/g)].map((m) => m[1]))
  .filter((p) => /^\/(bff|ad|account|acct|api|ka|promo|report)/i.test(p));
const groups = {};
for (const p of paths) {
  const g = p.split("/")[1] || "other";
  (groups[g] ??= []).push(p);
}
for (const [g, list] of Object.entries(groups).sort()) {
  console.log(`\n  ── ${g}（${list.length}）──`);
  for (const p of list.sort()) console.log("    " + p);
}

// ════════ 4. 找请求封装（baseURL / 域名表）════════
console.log("\n" + "═".repeat(72));
console.log("  请求封装与域名表");
console.log("═".repeat(72));
for (const kw of ["baseURL", "ka.waimai.meituan.com", "ad-dmp.waimai", "reportapi", "hsfAppName"]) {
  const idxs = [...js.matchAll(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((m) => m.index);
  if (!idxs.length) continue;
  console.log(`\n  [${kw}] ${idxs.length} 次`);
  for (const i of idxs.slice(0, 2)) console.log("      …" + js.slice(Math.max(0, i - 200), i + 300).replace(/\s+/g, " "));
}

writeFileSync("_recon/ka/paths.txt", paths.sort().join("\n"), "utf8");
writeFileSync("_recon/ka/fields.txt", FIELDS.sort().join("\n"), "utf8");
console.log(`\n落盘 _recon/ka/paths.txt（${paths.length} 条）、fields.txt（${FIELDS.length} 条）`);
