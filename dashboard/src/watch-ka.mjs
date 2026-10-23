/**
 * 被动监听：只记录，不导航（用户自己点菜单时用）。
 *   node src/watch-ka.mjs [--port=9222] [--seconds=300]
 *
 * 与 sniff-*.mjs 的区别：**不主动导航**，纯监听，避免打断用户操作。
 * 每 15 秒把当前捕获落盘一次，便于中途读取。
 */
import { writeFile, mkdir } from "node:fs/promises";
import { connectToPage } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9222"));
const SECONDS = Number(arg("seconds", "300"));
const OUT = "_recon/ka/watch.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdp = await connectToPage(PORT);
console.log(`✅ 已连接，开始被动监听 ${SECONDS} 秒（你现在可以去点「数据报表」）`);

const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|webp|map|ttf)(\?|$)/i;
const SKIP = /(msp\.meituan\.com|analytics\.meituan\.net|dreport|lx\d?\.meituan\.net|mmstat\.com|dpfile\.com|catfront)/i;
const pending = new Map();
const captured = new Map();

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (STATIC.test(url) || SKIP.test(url) || !/^https?:/i.test(url)) return;
  const base = url.split("?")[0];
  if (captured.has(base)) { pending.set(p.requestId, captured.get(base)); return; }
  let qs = {};
  try { qs = Object.fromEntries(new URL(url).searchParams); } catch {}
  const rec = {
    method: p.request.method,
    host: (() => { try { return new URL(url).host; } catch { return "?"; } })(),
    path: (() => { try { return new URL(url).pathname; } catch { return "?"; } })(),
    query: qs,
    postData: p.request.postData,
    t: new Date().toISOString().slice(11, 19),
  };
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
    rec.body = body.length > 5000 ? body.slice(0, 5000) + "…" : body;
  } catch { /* ignore */ }
});

await mkdir("_recon/ka", { recursive: true });
const deadline = Date.now() + SECONDS * 1000;
let last = 0;
while (Date.now() < deadline) {
  await sleep(2000);
  try {
    await writeFile(OUT, JSON.stringify([...captured.values()], null, 2), "utf8");
  } catch { /* ignore */ }
  if (Date.now() - last > 20000) {
    last = Date.now();
    console.log(`   …已捕获 ${captured.size} 个接口（剩余 ${Math.round((deadline - Date.now()) / 1000)}s）`);
  }
}

// 汇总：只打印疑似报表的
console.log(`\n${"=".repeat(72)}\n  监听结束，共捕获 ${captured.size} 个接口\n${"=".repeat(72)}`);
const interesting = [...captured.values()]
  .filter((c) => /(kepler|effect|report|statistic|data|history|metric)/i.test(c.path))
  .sort((a, b) => a.t.localeCompare(b.t));
for (const c of interesting) {
  console.log(`\n[${c.t}] [${c.status ?? "?"}] ${c.method} ${c.host}${c.path}`);
  const q = { ...c.query };
  for (const k of ["yodaReady", "csecplatform", "csecversion", "mtgsig"]) delete q[k];
  if (Object.keys(q).length) console.log("    query: " + JSON.stringify(q).slice(0, 340));
  if (c.postData) console.log("    body : " + String(c.postData).replace(/\s+/g, " ").slice(0, 340));
  if (c.body) console.log("    响应 : " + String(c.body).replace(/\s+/g, " ").slice(0, 600));
}
await cdp.close();
