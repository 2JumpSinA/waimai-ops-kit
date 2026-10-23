/**
 * 美团营销平台 · 解码 Unicode 后搜中文指标名 + 拉微前端子应用注册表
 *   node src/recon-ka4.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const F = "_recon/ka/js/js__index.b08b25826e9dad12f860.js";
const raw = readFileSync(F, "utf8");

/** 把 \uXXXX 还原成真字符，便于中文搜索 */
const decode = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const js = decode(raw);
writeFileSync("_recon/ka/js/decoded.js", js, "utf8");
console.log(`解码后 ${(js.length / 1024).toFixed(0)} KB（原 ${(raw.length / 1024).toFixed(0)} KB）\n`);

// ════════ 1. 中文指标名 ════════
console.log("═".repeat(72));
console.log("  中文指标名命中（解码后）");
console.log("═".repeat(72));
const KW = ["推广消耗", "推广占比", "投产比", "推广花费", "广告消耗", "消耗", "占比", "花费", "推广", "预算", "余额", "点击量", "曝光量", "转化率", "订单量", "成交额", "投入产出比"];
for (const k of KW) {
  const idxs = [...js.matchAll(new RegExp(k, "g"))].map((m) => m.index);
  if (!idxs.length) { console.log(`  ${k.padEnd(10)} —`); continue; }
  console.log(`\n  ${k}  ${idxs.length} 次`);
  for (const i of idxs.slice(0, 4)) {
    console.log(`      …${js.slice(Math.max(0, i - 150), i + 110).replace(/\s+/g, " ")}`);
  }
}

// ════════ 2. 找指标定义表（label + fieldName 配对）════════
console.log("\n" + "═".repeat(72));
console.log("  指标定义表线索（label 与字段名配对）");
console.log("═".repeat(72));
const pairs = [...js.matchAll(/\{([^{}]{0,200}?(?:field|key|value|name)\s*:\s*["'][\w.]+["'][^{}]{0,200}?)\}/g)]
  .map((m) => m[1])
  .filter((s) => /(耗|占比|投产|花费|ROI|roi|cost|Consume|ratio)/.test(s));
console.log(`  命中 ${pairs.length} 条：`);
for (const p of [...new Set(pairs)].slice(0, 40)) console.log("    {" + p.replace(/\s+/g, " ") + "}");

// ════════ 3. 拉微前端子应用注册表 ════════
console.log("\n" + "═".repeat(72));
console.log("  微前端子应用注册表");
console.log("═".repeat(72));
const m = js.match(/__WAIMAI_AD_HORN_STORE[^;]{0,400}/);
if (m) console.log("  本地线索：" + m[0].replace(/\s+/g, " ").slice(0, 400));

const HORN = [
  "https://portal-portm.meituan.com/horn/v1/modules/micro-subapp-reconsitution/prod",
  "https://portal-portm.meituan.com/horn/v1/modules/micro-subapp-reconsitution",
  "https://portal-portm.meituan.com/horn/v1/modules/waimai_ad_fe_micro/prod",
];
await mkdir("_recon/ka", { recursive: true });
for (const u of HORN) {
  try {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://ka.waimai.meituan.com/new" } });
    const t = await r.text();
    console.log(`\n  [${r.status}] ${u}  ${t.length} 字节`);
    console.log("    " + t.replace(/\s+/g, " ").slice(0, 700));
    if (r.ok && t.length > 50) {
      writeFileSync(`_recon/ka/horn_${u.split("/").slice(-2).join("_").replace(/[^\w]/g, "")}.json`, t, "utf8");
    }
  } catch (e) {
    console.log(`\n  💥 ${u} → ${e.message}`);
  }
}

// ════════ 4. 从页面内联脚本取 microAppKey 全表 ════════
console.log("\n" + "═".repeat(72));
console.log("  microAppKey 全表（页面内联）");
console.log("═".repeat(72));
const html = readFileSync("_recon/ka/index.html", "utf8");
const mk = html.match(/microAppKey\s*=\s*\{[\s\S]{0,1200}?\}/);
if (mk) {
  console.log(mk[0].replace(/\s+/g, " "));
} else {
  console.log("  未匹配到完整对象，打印相关片段：");
  const i = html.indexOf("microAppKey");
  console.log("  " + html.slice(Math.max(0, i - 200), i + 1400).replace(/\s+/g, " "));
}
