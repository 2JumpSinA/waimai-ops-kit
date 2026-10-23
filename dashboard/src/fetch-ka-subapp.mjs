/**
 * 拿到全部子应用入口 → 下载 datareport 子应用 → 静态挖报表接口
 *   node src/fetch-ka-subapp.mjs [--port=9222]
 */
import { writeFile, mkdir } from "node:fs/promises";
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;

await mkdir("_recon/ka/subapp", { recursive: true });

// ── 1. 页内调 getpubinfo 拿完整子应用清单 ──
const cdp = await connectToPage(PORT);
const raw = await evaluate(
  cdp,
  `(async () => {
     const r = await fetch('/ad/node/v1/micro/entrancefile/getpubinfo', {
       method: 'POST',
       credentials: 'include',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ environment: 'production', platform: 'ka', swimlane: null }),
     });
     return await r.text();
   })()`,
);
await cdp.close();

let apps = {};
try {
  const j = JSON.parse(raw);
  apps = j.data ?? {};
} catch (e) {
  console.log("解析失败：", e.message);
  console.log(raw.slice(0, 500));
  process.exit(1);
}

console.log(`子应用清单（${Object.keys(apps).length} 个）：`);
for (const [k, v] of Object.entries(apps)) {
  console.log(`  ${k.padEnd(22)} ${(v.js ?? "").split("/").pop()}`);
}
await writeFile("_recon/ka/subapps.json", JSON.stringify(apps, null, 2), "utf8");

// ── 2. 收集所有子应用 js，全部下载（用于挖接口）──
const files = Object.entries(apps)
  .map(([k, v]) => [k, String(v.js ?? "").replace(/^\/\//, "https://")])
  .filter(([, u]) => u.endsWith(".js"));

console.log(`\n下载 ${files.length} 个子应用包…`);
let okN = 0;
for (const [name, url] of files) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://ka.waimai.meituan.com/new" } });
    if (!r.ok) { console.log(`  [${r.status}] ${name}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    await writeFile(`_recon/ka/subapp/${name}.js`, buf);
    okN++;
    if (buf.length > 100_000) console.log(`  ✅ ${name.padEnd(22)} ${(buf.length / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.log(`  💥 ${name} → ${e.message}`);
  }
}
console.log(`下载成功 ${okN} 个`);

// ── 3. 重点扫 datareport ──
const { readFileSync, readdirSync } = await import("node:fs");
const TARGET = ["datareport", "jjg_data"];
for (const t of TARGET) {
  const p = `_recon/ka/subapp/${t}.js`;
  let js;
  try { js = readFileSync(p, "utf8"); } catch { console.log(`\n${t}: 未下载到`); continue; }
  console.log(`\n${"═".repeat(72)}\n  ${t}.js  ${(js.length / 1024).toFixed(0)} KB\n${"═".repeat(72)}`);
  const paths = [...new Set([...js.matchAll(/"(\/[\w\-/{}.:@]{6,140})"/g)].map((m) => m[1]))]
    .filter((x) => !/\.(js|css|png|jpe?g|svg|woff2?|gif)$/i.test(x));
  console.log(`接口路径（${paths.length}）：`);
  for (const x of paths.slice(0, 70)) console.log("  " + x);

  const dateKw = [...new Set([...js.matchAll(/["'](startDate|endDate|beginDate|endDate|dateRange|dateType|timeType|day|ds|beginDay|endDay|startTime|endTime)["']/g)].map((m) => m[1]))];
  if (dateKw.length) console.log(`\n日期参数名：${dateKw.join(", ")}`);

  const cn = [...new Set([...js.matchAll(/"([^"]{0,10}(?:消耗|占比|投产|ROI|花费|曝光|点击)[^"]{0,10})"/g)].map((m) => m[1]))];
  if (cn.length) { console.log(`\n中文指标（${cn.length}）：`); for (const c of cn.slice(0, 40)) console.log("  " + c); }
}
