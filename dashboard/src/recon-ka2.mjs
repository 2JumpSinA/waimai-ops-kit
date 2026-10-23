/**
 * 美团营销平台 · 下载主包与全部分包，扫接口。
 *   node src/recon-ka2.mjs
 *
 * 依据第一步侦察：主包在
 *   //w.meituan.net/v1/mss_4067b040e3364072a20737a5254654ea/ka-react/production/js/index.<hash>.js
 * chunk 清单在页面内联的 window._nine_assets_info
 */
import { readFileSync } from "node:fs";
import { writeFile, mkdir, readdir } from "node:fs/promises";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const OUT = "_recon/ka";
const BASE = "https://w.meituan.net/v1/mss_4067b040e3364072a20737a5254654ea/ka-react/production/";

await mkdir(`${OUT}/js`, { recursive: true });

const html = readFileSync(`${OUT}/index.html`, "utf8");

// ── 1. 取出 _nine_assets_info 的完整 JSON ──
const m = html.match(/window\._nine_assets_info\s*=\s*(\[[\s\S]*?\])\s*;/);
let assets = [];
if (m) {
  try {
    assets = JSON.parse(m[1]);
    console.log(`_nine_assets_info 解析成功：${assets.length} 个 chunk`);
  } catch (e) {
    console.log("JSON 解析失败：", e.message);
  }
} else {
  console.log("未找到 _nine_assets_info");
}

// ── 2. 收集要下载的 js 资源 ──
const files = new Set();
for (const a of assets) {
  for (const r of a.resource ?? []) {
    if (/\.js$/.test(r) && !r.startsWith("sourcemap")) files.add(r);
  }
}
const entryMatch = html.match(/["'](js\/index\.[\w]+\.js)["']/);
if (entryMatch) files.add(entryMatch[1]);

console.log(`\n待下载 ${files.size} 个 js：`);
for (const f of files) console.log("  " + f);

// ── 3. 下载 ──
let ok = 0, fail = 0;
for (const f of files) {
  const name = f.replace(/\//g, "__");
  try {
    const r = await fetch(BASE + f, { headers: { "User-Agent": UA, Referer: "https://ka.waimai.meituan.com/new" } });
    if (!r.ok) { console.log(`  [${r.status}] ${f}`); fail++; continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    await writeFile(`${OUT}/js/${name}`, buf);
    ok++;
    if (buf.length > 200_000) console.log(`  ✅ ${f}  ${(buf.length / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.log(`  💥 ${f} → ${e.message}`);
    fail++;
  }
}
console.log(`\n下载完成：成功 ${ok}，失败 ${fail}`);

// ── 4. 扫描全部包 ──
const apiAll = new Map();
const mtopAll = new Set();
const srcOf = new Map();
for (const f of await readdir(`${OUT}/js`)) {
  const js = readFileSync(`${OUT}/js/${f}`, "utf8");
  for (const mm of js.matchAll(/"(\/[\w\-/{}.:]{8,140})"/g)) {
    const p = mm[1];
    if (!/\/(api|gw|r|v\d|promo|ad|ka|report|reportapi|data|query|list|statistics|cost|roi|effect|fund|budget|plan|unit|creative|account)\b/i.test(p)) continue;
    if (!apiAll.has(p)) { apiAll.set(p, new Set()); }
    apiAll.get(p).add(f.replace("__", "/").replace(/\.js$/, ""));
  }
  for (const mm of js.matchAll(/["'](mtop\.[\w.]+)["']/g)) mtopAll.add(mm[1]);
}

console.log(`\n${"=".repeat(72)}\n疑似接口路径（${apiAll.size} 个）\n${"=".repeat(72)}`);
for (const p of [...apiAll.keys()].sort()) {
  console.log(`  ${p}\n      ← ${[...apiAll.get(p)].slice(0, 2).join(", ")}`);
}

if (mtopAll.size) {
  console.log(`\n${"=".repeat(72)}\nMTOP 接口（${mtopAll.size}）\n${"=".repeat(72)}`);
  for (const m2 of [...mtopAll].sort()) console.log("  " + m2);
}

// ── 5. 与推广指标强相关的关键词统计 ──
console.log(`\n${"=".repeat(72)}\n推广指标相关关键词命中\n${"=".repeat(72)}`);
const KW = ["cost", "roi", "click", "impression", "expose", "budget", "balance", "effect", "convert", "cpc", "cpm", "gmv", "order", "consume"];
for (const f of await readdir(`${OUT}/js`)) {
  const js = readFileSync(`${OUT}/js/${f}`, "utf8");
  if (js.length < 50_000) continue;
  const hits = KW.map((k) => [k, (js.match(new RegExp(k, "gi")) ?? []).length]).filter(([, n]) => n > 30);
  if (hits.length) {
    console.log(`\n  ${f}（${(js.length / 1024).toFixed(0)} KB）`);
    console.log("    " + hits.map(([k, n]) => `${k}:${n}`).join("  "));
  }
}
