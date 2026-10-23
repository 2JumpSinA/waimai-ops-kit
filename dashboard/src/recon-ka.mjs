/**
 * 美团营销平台（ka.waimai.meituan.com）· 完整静态侦察
 *   node src/recon-ka.mjs
 *
 * 一次跑完，减少提权次数：
 *   1. 抓入口 HTML，dump 内联脚本 / 资源清单
 *   2. 找出应用主包（可能在 webpack chunk map 或内联 manifest 里）
 *   3. 下载候选包，扫接口路径 / mtop 名 / H5guard 用法
 */
import { writeFile, mkdir } from "node:fs/promises";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const ORIGIN = "https://ka.waimai.meituan.com";
const OUT = "_recon/ka";

const get = async (url, asJson = false) => {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: `${ORIGIN}/new` }, redirect: "manual" });
  const text = await r.text();
  return { status: r.status, text, json: asJson ? JSON.parse(text) : null, headers: r.headers };
};

await mkdir(OUT, { recursive: true });

// ════════ 1. 入口 HTML ════════
const home = await get(`${ORIGIN}/new`);
console.log(`入口 /new  status=${home.status}  ${Buffer.byteLength(home.text)} 字节`);
await writeFile(`${OUT}/index.html`, home.text, "utf8");

// 内联脚本
const inline = [...home.text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
console.log(`\n内联脚本 ${inline.length} 段：`);
for (const [i, s] of inline.entries()) {
  const t = s.replace(/\s+/g, " ").trim();
  console.log(`  [${i}] ${t.length} 字符  ${t.slice(0, 220)}`);
}

// 所有静态资源引用
const refs = [
  ...home.text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi),
].map((m) => m[1]);
const jsRefs = [...new Set(refs.filter((u) => /\.js(\?|$)/.test(u)))];
console.log(`\n外链 JS（${jsRefs.length}）：`);
for (const u of jsRefs) console.log("  " + u);

// 找 chunk map / manifest 线索
console.log("\n=== HTML 里疑似 chunk/入口 的字符串 ===");
const hints = [...new Set([...home.text.matchAll(/["']([\w./-]*(?:chunk|manifest|runtime|app|index|main|entry)[\w./-]*\.js)["']/gi)].map((m) => m[1]))];
console.log(hints.length ? hints.map((h) => "  " + h).join("\n") : "  （无）");

// ════════ 2. 猜并下载主包 ════════
const CANDIDATES = [
  "/new/static/js/app.js",
  "/new/static/js/main.js",
  "/new/static/js/index.js",
  "/new/static/js/runtime.js",
  "/new/app.js",
  "/new/main.js",
  "/static/js/app.js",
  "/new/asset-manifest.json",
  "/new/manifest.json",
];
console.log("\n=== 主包探测 ===");
const found = [];
for (const p of CANDIDATES) {
  try {
    const r = await fetch(ORIGIN + p, { headers: { "User-Agent": UA }, redirect: "manual" });
    const len = Number(r.headers.get("content-length") ?? 0);
    console.log(`  [${r.status}] ${p}  ${len || "?"} 字节  ${r.headers.get("content-type") ?? ""}`);
    if (r.status === 200 && len > 1000) {
      const buf = Buffer.from(await r.arrayBuffer());
      const name = p.replace(/[^\w.]/g, "_");
      await writeFile(`${OUT}/${name}`, buf);
      found.push({ path: p, file: name, size: buf.length });
    }
  } catch (e) {
    console.log(`  💥 ${p} → ${e.message}`);
  }
}

// ════════ 3. 客户端路由抓包（hash 路由，主包可能由 JS 动态加载）════════
// 从 HTML 里把所有 meituan 域名的资源都记下来
const hosts = [...new Set(refs.map((u) => { try { return new URL(u.startsWith("//") ? "https:" + u : u, ORIGIN).host; } catch { return null; } }).filter(Boolean))];
console.log(`\n引用到的域名：${hosts.join(", ")}`);

// ════════ 4. 扫已下载的包 ════════
for (const f of found) {
  const js = (await import("node:fs")).readFileSync(`${OUT}/${f.file}`, "utf8");
  console.log(`\n${"=".repeat(70)}\n扫描 ${f.path}（${(f.size / 1024).toFixed(0)} KB）\n${"=".repeat(70)}`);
  const apiPaths = [...new Set([...js.matchAll(/"(\/[\w\-/{}.:]{6,120})"/g)].map((m) => m[1]))];
  const apiLike = apiPaths.filter((p) => /\/(api|r|v\d|gw|promo|ad|ka|report|data|query|list|statistics|cost|roi)\b/i.test(p));
  console.log(`疑似接口路径（${apiLike.length}）：`);
  for (const p of apiLike.slice(0, 80)) console.log("  " + p);
  const mtop = [...new Set([...js.matchAll(/["'](mtop\.[\w.]+)["']/g)].map((m) => m[1]))];
  if (mtop.length) { console.log(`\nmtop 接口（${mtop.length}）：`); for (const m of mtop.slice(0, 40)) console.log("  " + m); }
  for (const kw of ["H5guard", "mtgsig", "appKey", "baseURL", "axios.create"]) {
    const n = (js.match(new RegExp(kw.replace(".", "\\."), "g")) ?? []).length;
    if (n) console.log(`  ${kw}: ${n} 次`);
  }
}

console.log(`\n落盘 ${OUT}/`);
