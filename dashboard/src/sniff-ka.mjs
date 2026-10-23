/**
 * 美团营销平台 · 嗅探 #/newhome（v2：强制重载 + 录响应体）
 *   node src/sniff-ka.mjs [--port=9222]
 *
 * v1 的教训：页面已在目标 URL 上时，Page.navigate 到相同地址**不会重新加载**，
 * 数据接口在开监听之前就发完了 → 必须显式 Page.reload。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
console.log("✅ 已连接调试浏览器");

const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|webp|map|ttf)(\?|$)/i;
const SKIP_HOST = /(msp\.meituan\.com|analytics\.meituan\.net|report\.meituan\.com|dpfile\.com|mmstat\.com|s0\.meituan\.net)/i;

const pending = new Map(); // requestId -> record
const captured = new Map(); // path -> record

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (STATIC.test(url) || SKIP_HOST.test(url)) return;
  if (!/^https?:/i.test(url)) return;
  const base = url.split("?")[0];
  if (captured.has(base)) { pending.set(p.requestId, captured.get(base)); return; }
  let qs = {};
  try { qs = Object.fromEntries(new URL(url).searchParams); } catch {}
  const rec = {
    method: p.request.method,
    host: (() => { try { return new URL(url).host; } catch { return "?"; } })(),
    path: (() => { try { return new URL(url).pathname; } catch { return "?"; } })(),
    fullUrl: url,
    query: qs,
    postData: p.request.postData,
    headers: p.request.headers,
  };
  captured.set(base, rec);
  pending.set(p.requestId, rec);
});

cdp.on("Network.responseReceived", (p) => {
  const rec = pending.get(p.requestId);
  if (rec && !rec.status) { rec.status = p.response.status; rec.mime = p.response.mimeType; }
});

cdp.on("Network.loadingFinished", async (p) => {
  const rec = pending.get(p.requestId);
  if (!rec || rec.body !== undefined) return;
  try {
    const { body } = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
    rec.body = body.length > 3000 ? body.slice(0, 3000) + "…[截断]" : body;
  } catch { /* 响应体可能已被回收 */ }
});

// ── 强制重载，让页面把所有数据请求重发一遍 ──
console.log("强制重载 #/newhome …");
await cdp.send("Page.reload", { ignoreCache: false });
await sleep(18000);

const state = await evaluate(
  cdp,
  `JSON.stringify({url:location.href,title:document.title,
     text:(document.body?document.body.innerText:"").replace(/\\n{2,}/g,"\\n").slice(0,1500)})`,
);
const st = JSON.parse(state);
console.log(`\n页面 ${st.title}  ${st.url}`);

console.log("\n" + "═".repeat(74));
console.log(`  捕获接口 ${captured.size} 个（业务请求）`);
console.log("═".repeat(74));
const list = [...captured.values()].sort((a, b) => (b.body ? 1 : 0) - (a.body ? 1 : 0) || a.path.localeCompare(b.path));
for (const r of list) {
  console.log(`\n[${r.status ?? "?"}] ${r.method} ${r.host}${r.path}`);
  if (Object.keys(r.query).length) {
    console.log("    query: " + JSON.stringify(r.query).slice(0, 320));
  }
  if (r.postData) console.log("    body : " + String(r.postData).replace(/\s+/g, " ").slice(0, 400));
  if (r.body) {
    let pretty = r.body;
    try {
      const j = JSON.parse(r.body.replace(/…\[截断\]$/, ""));
      pretty = JSON.stringify(j).slice(0, 700);
    } catch { /* 非 JSON 就原样 */ }
    console.log("    响应 : " + pretty.replace(/\s+/g, " ").slice(0, 700));
  }
}

await mkdir("_recon/ka", { recursive: true });
await writeFile(
  "_recon/ka/sniff-home.json",
  JSON.stringify({ state: st, api: [...captured.values()] }, null, 2),
  "utf8",
);
console.log(`\n落盘 _recon/ka/sniff-home.json`);
await cdp.close();
