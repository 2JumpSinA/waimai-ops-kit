/**
 * 通用嗅探器：重载当前页，录下全部业务请求 + 响应体。
 *   node src/sniff-current.mjs [--port=9222] [--label=xxx]
 *
 * 用途：把调试浏览器手动导航到目标页面，然后跑这个，不用任何参数适配。
 * 与 sniff-ka*.mjs 的区别：**不限域名、不限接口前缀**，只过滤静态资源与埋点。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9222"));
const LABEL = arg("label", "current");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
const before = JSON.parse(await evaluate(cdp, `JSON.stringify({u:location.href,t:document.title,n:(document.body?document.body.innerText:"").length})`));
console.log(`当前页：${before.t}`);
console.log(`        ${before.u}`);
console.log(`        正文 ${before.n} 字\n`);

const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|webp|map|ttf|mp4)(\?|$)/i;
const SKIP = /(msp\.meituan\.com|analytics\.meituan\.net|dreport|lx\d?\.meituan\.net|mmstat\.com|dpfile\.com|catfront|51ping|s0\.meituan\.net|portal-portm|owl)/i;
const pending = new Map();
const captured = new Map();

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (STATIC.test(url) || SKIP.test(url) || !/^https?:/i.test(url)) return;
  const key = p.request.method + " " + url.split("?")[0];
  if (captured.has(key)) { pending.set(p.requestId, captured.get(key)); return; }
  let qs = {};
  try { qs = Object.fromEntries(new URL(url).searchParams); } catch {}
  const rec = {
    method: p.request.method,
    host: (() => { try { return new URL(url).host; } catch { return "?"; } })(),
    path: (() => { try { return new URL(url).pathname; } catch { return "?"; } })(),
    query: qs,
    postData: p.request.postData,
  };
  captured.set(key, rec);
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
    rec.body = body.length > 8000 ? body.slice(0, 8000) + "…" : body;
  } catch { /* ignore */ }
});

console.log("重载中，等 20 秒…");
await cdp.send("Page.reload", { ignoreCache: false });
await sleep(20000);

const after = JSON.parse(await evaluate(cdp, `JSON.stringify({u:location.href,text:(document.body?document.body.innerText:"").replace(/\\n{2,}/g,"\\n").slice(0,1800)})`));
console.log(`\n页面文字：\n${after.text.split("\n").map((l) => "   " + l).join("\n")}`);

console.log("\n" + "═".repeat(76));
console.log(`  捕获 ${captured.size} 个接口`);
console.log("═".repeat(76));
for (const c of [...captured.values()].sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`\n[${c.status ?? "?"}] ${c.method} ${c.host}${c.path}`);
  const q = { ...c.query };
  for (const k of ["yodaReady", "csecplatform", "csecversion", "mtgsig", "token"]) delete q[k];
  if (Object.keys(q).length) console.log("    query: " + JSON.stringify(q).slice(0, 380));
  if (c.postData) console.log("    body : " + String(c.postData).replace(/\s+/g, " ").slice(0, 380));
  if (c.body) console.log("    响应 : " + String(c.body).replace(/\s+/g, " ").slice(0, 800));
}

await mkdir("_recon", { recursive: true });
await writeFile(`_recon/sniff-${LABEL}.json`, JSON.stringify({ page: after, api: [...captured.values()] }, null, 2), "utf8");
console.log(`\n落盘 _recon/sniff-${LABEL}.json`);
await cdp.close();
