/**
 * 定位并嗅探 ka 平台的「datareport」子应用（7天/30天 口径在这里）。
 *   node src/sniff-ka-subapp.mjs [--port=9222]
 *
 * 依据：horn 配置 micro-subapp-reconsitution 的 ka.webStaticWhiteList 含 "datareport"；
 * 子应用挂载形式参考 AI 助手返回的 pcUrl: https://ka.waimai.meituan.com/new#/subapp/account/poi
 */
import { mkdir, writeFile } from "node:fs/promises";
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
console.log("✅ 已连接\n");

const STATIC = /\.(css|png|jpe?g|gif|svg|woff2?|ico|webp|map|ttf)(\?|$)/i;
const SKIP = /(msp\.meituan\.com|analytics\.meituan\.net|dreport|lx\d?\.meituan\.net|mmstat\.com|dpfile\.com)/i;
const pending = new Map();
const captured = new Map();

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (STATIC.test(url) || SKIP.test(url) || !/^https?:/i.test(url)) return;
  const base = url.split("?")[0];
  if (captured.has(base)) { pending.set(p.requestId, captured.get(base)); return; }
  let qs = {};
  try { qs = Object.fromEntries(new URL(url).searchParams); } catch {}
  const isJs = /\.js$/.test(base);
  const rec = {
    kind: isJs ? "js" : "api",
    method: p.request.method,
    host: (() => { try { return new URL(url).host; } catch { return "?"; } })(),
    path: (() => { try { return new URL(url).pathname; } catch { return "?"; } })(),
    query: qs,
    postData: p.request.postData,
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
  if (!rec || rec.kind === "js" || rec.body !== undefined) return;
  try {
    const { body } = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
    rec.body = body.length > 4000 ? body.slice(0, 4000) + "…" : body;
  } catch { /* ignore */ }
});

// 先回首页，保证 hash 变化能触发路由
await cdp.send("Page.navigate", { url: "https://ka.waimai.meituan.com/new#/newhome" });
await sleep(5000);

const ROUTES = [
  "#/subapp/datareport",
  "#/subapp/datareport/index",
  "#/subapp/datareport/home",
  "#/subapp/jjg_data",
  "#/subapp/datareport/effectData",
];
for (const r of ROUTES) {
  const url = `https://ka.waimai.meituan.com/new${r}`;
  const before = captured.size;
  const beforeJs = [...captured.values()].filter((x) => x.kind === "js").length;
  await cdp.send("Page.navigate", { url });
  await sleep(9000);
  const t = await evaluate(cdp, `JSON.stringify({u:location.href,n:(document.body?document.body.innerText:"").length,txt:(document.body?document.body.innerText:"").slice(0,200).replace(/\\n+/g," | ")})`).catch(() => null);
  const o = t ? JSON.parse(t) : { u: "?", n: -1, txt: "（evaluate 失败）" };
  const newJs = [...captured.values()].filter((x) => x.kind === "js").length - beforeJs;
  console.log(`${r}`);
  console.log(`   实际: ${String(o.u).replace("https://ka.waimai.meituan.com/new", "")}   正文 ${o.n} 字   新增 ${captured.size - before}（其中 js ${newJs}）`);
  if (o.n > 30) console.log(`   文字: ${o.txt}`);
  console.log();
}

console.log("═".repeat(74));
console.log("  子应用 JS 资源（可据此继续静态挖接口）");
console.log("═".repeat(74));
for (const c of [...captured.values()].filter((x) => x.kind === "js" && /micro|subapp|datareport|jjg/i.test(x.path)).sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`  https://${c.host}${c.path}`);
}

console.log("\n" + "═".repeat(74));
console.log("  报表类 API");
console.log("═".repeat(74));
for (const c of [...captured.values()].filter((x) => x.kind === "api").sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`\n[${c.status ?? "?"}] ${c.method} ${c.host}${c.path}`);
  const q = { ...c.query };
  for (const k of ["yodaReady", "csecplatform", "csecversion", "mtgsig"]) delete q[k];
  if (Object.keys(q).length) console.log("    query: " + JSON.stringify(q).slice(0, 320));
  if (c.postData) console.log("    body : " + String(c.postData).replace(/\s+/g, " ").slice(0, 320));
  if (c.body) console.log("    响应 : " + String(c.body).replace(/\s+/g, " ").slice(0, 600));
}

await mkdir("_recon/ka", { recursive: true });
await writeFile("_recon/ka/sniff-subapp.json", JSON.stringify([...captured.values()], null, 2), "utf8");
console.log(`\n落盘 _recon/ka/sniff-subapp.json`);
await cdp.close();
