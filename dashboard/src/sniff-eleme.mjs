/**
 * 嗅探淘宝闪购「数据分析」微应用的真实请求（解 MDA 应用级鉴权之谜）。
 *   node src/sniff-eleme.mjs [--port=9222]
 *
 * 目标：拿到 nrshop.ele.me / mtop.ele.me 上 MDA 接口的
 *   —— 完整 URL（含 jsv / appKey / 是否有额外查询参数）
 *   —— **完整请求头**（应用级鉴权大概率藏在这里）
 *   —— 请求体
 *
 * 做法：先开 Network 监听，再重载页面，让页面自己把请求重发一遍。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
console.log(`✅ 已连接（渲染器可用）`);

const cur = await evaluate(cdp, `JSON.stringify({ url: location.href, title: document.title })`);
console.log(`当前页面：${cur}\n`);

/** 只关心这些主机上的非静态请求 */
const INTERESTING = /^https?:\/\/(nrshop\.ele\.me|mtop\.ele\.me|ebai\.ele\.me|pre-agw\.ele\.me|agw\.ele\.me|nr\.ele\.me|h5\.ele\.me)/i;
const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|webp|map)(\?|$)/i;

const captured = new Map(); // key -> record
cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (!INTERESTING.test(url)) return;
  if (STATIC.test(url)) return;
  const base = url.split("?")[0];
  if (captured.has(base)) return; // 同名接口只留第一条
  let qs = {};
  try { qs = Object.fromEntries(new URL(url).searchParams); } catch {}
  captured.set(base, {
    method: p.request.method,
    url,
    host: (() => { try { return new URL(url).host; } catch { return "?"; } })(),
    path: (() => { try { return new URL(url).pathname; } catch { return "?"; } })(),
    queryKeys: Object.keys(qs),
    query: qs,
    headers: p.request.headers,
    postData: p.request.postData,
  });
});
cdp.on("Network.responseReceived", (p) => {
  const b = (p.response?.url ?? "").split("?")[0];
  const rec = captured.get(b);
  if (rec) { rec.status = p.response.status; rec.mimeType = p.response.mimeType; }
});

/** 让页面重发一遍请求 */
async function capture(label, url) {
  const before = captured.size;
  await cdp.send("Page.navigate", { url });
  await sleep(11000);
  console.log(`──── ${label}：新增 ${captured.size - before} 条 ────`);
}

// 先重载当前（曝光数据），再去营业统计
await capture("曝光数据", "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next#/pc/exposureDataPc/");
await capture("营业统计", "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next#/pc/businessAnalysisPc/");
await capture("商品分析", "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next#/pc/commodityAnalysisPc/");

console.log(`\n${"═".repeat(72)}\n  捕获到的接口（${captured.size} 个）\n${"═".repeat(72)}`);
for (const r of [...captured.values()].sort((a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path))) {
  console.log(`\n[${r.status ?? "?"}] ${r.method} https://${r.host}${r.path}`);
  console.log(`    查询参数键: ${JSON.stringify(r.queryKeys)}`);
  const h = r.headers ?? {};
  // 只看非标准的请求头 —— 应用级鉴权大概率在这里
  const std = new Set(["accept","accept-encoding","accept-language","content-length","content-type","origin","referer","user-agent","connection","host","sec-fetch-dest","sec-fetch-mode","sec-fetch-site","sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform","cookie","priority","pragma","cache-control","dnt","upgrade-insecure-requests"]);
  const custom = Object.keys(h).filter((k) => !std.has(k.toLowerCase()));
  if (custom.length) {
    console.log(`    ⭐ 非标准请求头：`);
    for (const k of custom) console.log(`        ${k}: ${String(h[k]).slice(0, 150)}`);
  } else {
    console.log(`    （无非标准请求头）`);
  }
  if (r.postData) console.log(`    请求体: ${String(r.postData).slice(0, 400)}`);
  // mtop 的关键查询参数
  if (r.query?.sign) {
    console.log(`    mtop: jsv=${r.query.jsv} appKey=${r.query.appKey} v=${r.query.v} type=${r.query.type}`);
  }
}

await mkdir(join(ROOT, "_recon", "raw"), { recursive: true });
await writeFile(join(ROOT, "_recon", "raw", "eleme-sniff.json"), JSON.stringify([...captured.values()], null, 2));
console.log(`\n落盘 _recon/raw/eleme-sniff.json`);
await cdp.close();
