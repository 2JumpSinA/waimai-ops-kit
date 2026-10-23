/**
 * 嗅探 v2：直接导航到独立微应用 URL（绕开 hash 路由不加载的问题）。
 *   node src/sniff-eleme2.mjs [--port=9222]
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
console.log("✅ 已连接");

/** 先看全部 target —— 微应用可能是独立的 OOPIF/OOP target */
const { targetInfos } = await cdp.send("Target.getTargets");
console.log("\n=== 全部 target ===");
for (const t of targetInfos) {
  if (!/page|iframe|webview/.test(t.type)) continue;
  console.log(`  [${t.type}] ${t.title?.slice(0, 30)} ${t.url.slice(0, 110)}`);
}

const INTERESTING = /^https?:\/\/(nrshop\.ele\.me|mtop\.ele\.me|ebai\.ele\.me|agw\.ele\.me|pre-agw\.ele\.me|nr\.ele\.me|h5\.ele\.me)/i;
const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|webp|map)(\?|$)/i;

const captured = new Map();
cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (!INTERESTING.test(url) || STATIC.test(url)) return;
  const base = url.split("?")[0];
  if (captured.has(base)) return;
  let qs = {};
  try { qs = Object.fromEntries(new URL(url).searchParams); } catch {}
  captured.set(base, {
    method: p.request.method,
    host: (() => { try { return new URL(url).host; } catch { return "?"; } })(),
    path: (() => { try { return new URL(url).pathname; } catch { return "?"; } })(),
    queryKeys: Object.keys(qs),
    query: qs,
    headers: p.request.headers,
    postData: p.request.postData,
    frameUrl: p.frameId,
  });
});
cdp.on("Network.responseReceived", (p) => {
  const rec = captured.get((p.response?.url ?? "").split("?")[0]);
  if (rec) rec.status = p.response.status;
});

async function cap(label, url, wait = 14000) {
  const before = captured.size;
  try {
    await cdp.send("Page.navigate", { url });
  } catch (e) {
    console.log(`  ⛔ ${label} 导航失败：${e.message}`);
    return;
  }
  await sleep(wait);
  const st = await evaluate(cdp, `JSON.stringify({url:location.href,title:document.title,bodyLen:document.body?document.body.innerText.length:0})`).catch(() => "?");
  console.log(`\n──── ${label}：新增 ${captured.size - before} 条 ────`);
  console.log(`     ${st}`);
}

console.log("\n开始逐个导航独立微应用 URL…");
await cap("营业统计(独立)", "https://nr.ele.me/eleme_nr_bfe_retail/eb_data_analysis/businessAnalysis?nav=zoneMiddlemen");
await cap("曝光数据(独立)", "https://nr.ele.me/eleme_nr_bfe_retail/eb_data_analysis/exposureAnalysis?nav=zoneMiddlemen");
await cap("商品分析(独立)", "https://nr.ele.me/eleme_nr_bfe_retail/eb_data_analysis/commodityAnalysis?nav=zone");

console.log(`\n${"═".repeat(72)}\n  捕获 ${captured.size} 个接口\n${"═".repeat(72)}`);
for (const r of [...captured.values()].sort((a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path))) {
  console.log(`\n[${r.status ?? "?"}] ${r.method} https://${r.host}${r.path}`);
  if (r.queryKeys.length) console.log(`    参数键: ${JSON.stringify(r.queryKeys)}`);
  const h = r.headers ?? {};
  const std = new Set(["accept","accept-encoding","accept-language","content-length","content-type","origin","referer","user-agent","connection","host","sec-fetch-dest","sec-fetch-mode","sec-fetch-site","sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform","cookie","priority","pragma","cache-control","dnt","upgrade-insecure-requests","access-control-request-headers","access-control-request-method"]);
  const custom = Object.keys(h).filter((k) => !std.has(k.toLowerCase()));
  if (custom.length) {
    console.log(`    ⭐ 非标准请求头：`);
    for (const k of custom) console.log(`        ${k}: ${String(h[k]).slice(0, 160)}`);
  }
  if (r.postData) console.log(`    请求体: ${String(r.postData).slice(0, 500)}`);
  if (r.query?.sign) console.log(`    mtop: jsv=${r.query.jsv} appKey=${r.query.appKey} H5Request=${r.query.H5Request ?? "-"}`);
}

await mkdir(join(ROOT, "_recon", "raw"), { recursive: true });
await writeFile(join(ROOT, "_recon", "raw", "eleme-sniff2.json"), JSON.stringify([...captured.values()], null, 2));
console.log(`\n落盘 _recon/raw/eleme-sniff2.json`);
await cdp.close();
