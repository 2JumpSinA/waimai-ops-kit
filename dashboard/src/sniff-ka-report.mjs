/**
 * 美团营销平台 · 嗅探「数据报表」页（7天/30天 口径）
 *   node src/sniff-ka-report.mjs [--port=9222]
 *
 * 先读页面菜单拿到报表页路由，再导航过去嗅探。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
console.log("✅ 已连接");

// ── 1. 读菜单，拿报表页路由 ──
const menu = await evaluate(
  cdp,
  `JSON.stringify([...document.querySelectorAll('a')].map(a=>({t:(a.innerText||'').trim().slice(0,20),h:a.getAttribute('href')})).filter(x=>x.t&&x.h).slice(0,60))`,
);
console.log("\n页面菜单链接：");
for (const m of JSON.parse(menu)) console.log(`   ${m.t.padEnd(14)} ${m.h}`);

// 也读一下 hash 路由表（React Router 的 path 常在脚本里，这里退化为看 DOM）
const hashLinks = JSON.parse(
  await evaluate(cdp, `JSON.stringify([...new Set([...document.querySelectorAll('*')].map(e=>e.getAttribute&&e.getAttribute('href')).filter(h=>h&&h.startsWith('#')))])`),
);
if (hashLinks.length) {
  console.log("\nhash 链接：");
  for (const h of hashLinks.slice(0, 40)) console.log("   " + h);
}

// ── 2. 嗅探（强制 reload 不回放：直接换路由）──
const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|webp|map|ttf)(\?|$)/i;
const SKIP = /(msp\.meituan\.com|analytics\.meituan\.net|report\.meituan\.com|dpfile\.com|mmstat\.com|s0\.meituan\.net|lx\d?\.meituan\.net|dreport)/i;
const pending = new Map();
const captured = new Map();

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (STATIC.test(url) || SKIP.test(url) || !/^https?:/i.test(url)) return;
  if (!/(kepler|bff\/ad|ka\/data|report|effect|datacenter)/i.test(url)) return;
  const base = url.split("?")[0];
  if (captured.has(base)) { pending.set(p.requestId, captured.get(base)); return; }
  let qs = {};
  try { qs = Object.fromEntries(new URL(url).searchParams); } catch {}
  const rec = { method: p.request.method, path: new URL(url).pathname, query: qs, postData: p.request.postData, fullUrl: url };
  captured.set(base, rec);
  pending.set(p.requestId, rec);
});
cdp.on("Network.responseReceived", (p) => {
  const rec = pending.get(p.requestId);
  if (rec && !rec.status) rec.status = p.response.status;
});
cdp.on("Network.loadingFinished", async (p) => {
  const rec = pending.get(p.requestId);
  if (!rec || rec.body !== undefined) return;
  try {
    const { body } = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
    rec.body = body.length > 4000 ? body.slice(0, 4000) + "…" : body;
  } catch { /* ignore */ }
});

// ── 3. 逐个候选报表路由试 ──
const CANDIDATES = [
  "https://ka.waimai.meituan.com/new#/dataReport",
  "https://ka.waimai.meituan.com/new#/report/data",
  "https://ka.waimai.meituan.com/new#/effectData",
  "https://ka.waimai.meituan.com/new#/dataCenter",
  "https://ka.waimai.meituan.com/new#/myPromotion/report",
];
for (const url of CANDIDATES) {
  const before = captured.size;
  await cdp.send("Page.navigate", { url });
  await sleep(9000);
  const t = await evaluate(cdp, `JSON.stringify({u:location.href,t:document.title,n:(document.body?document.body.innerText:"").length})`).catch(() => "?");
  console.log(`\n  ${url}\n     → ${t}   新增接口 ${captured.size - before}`);
  const obj = JSON.parse(t);
  if (obj.n > 1500) console.log("     ✅ 页面有内容，可能就是报表页");
}

console.log("\n" + "═".repeat(74));
console.log(`  捕获 ${captured.size} 个报表类接口`);
console.log("═".repeat(74));
for (const r of [...captured.values()].sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`\n[${r.status ?? "?"}] ${r.method} ${r.path}`);
  const q = { ...r.query };
  for (const k of ["yodaReady", "csecplatform", "csecversion", "mtgsig"]) delete q[k];
  if (Object.keys(q).length) console.log("    query: " + JSON.stringify(q).slice(0, 320));
  if (r.postData) console.log("    body : " + String(r.postData).replace(/\s+/g, " ").slice(0, 320));
  if (r.body) console.log("    响应 : " + String(r.body).replace(/\s+/g, " ").slice(0, 600));
}

await mkdir("_recon/ka", { recursive: true });
await writeFile("_recon/ka/sniff-report.json", JSON.stringify([...captured.values()], null, 2), "utf8");
console.log(`\n落盘 _recon/ka/sniff-report.json`);
await cdp.close();
