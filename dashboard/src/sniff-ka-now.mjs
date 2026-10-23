/**
 * 重载「数据报表」子应用页并捕获全部请求。
 *   node src/sniff-ka-now.mjs [--port=9222]
 *
 * 场景：页面已停在 #/subapp/datareport/effectData，但数据早已加载完。
 * 重载一次即可让子应用重新发起全部数据请求。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
const cur = JSON.parse(await evaluate(cdp, `JSON.stringify({u:location.href,t:document.title})`));
console.log(`当前页：${cur.t}  ${cur.u}`);

const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|webp|map|ttf)(\?|$)/i;
const SKIP = /(msp\.meituan\.com|analytics\.meituan\.net|dreport|lx\d?\.meituan\.net|mmstat\.com|dpfile\.com|catfront|51ping)/i;
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
    rec.body = body.length > 6000 ? body.slice(0, 6000) + "…" : body;
  } catch { /* ignore */ }
});

console.log("\n重载中…");
await cdp.send("Page.reload", { ignoreCache: false });
await sleep(20000);

const after = JSON.parse(await evaluate(cdp, `JSON.stringify({u:location.href,n:(document.body?document.body.innerText:"").length,txt:(document.body?document.body.innerText:"").slice(0,900)})`));
console.log(`\n重载后：${after.u.replace("https://ka.waimai.meituan.com/new", "")}   正文 ${after.n} 字`);
console.log("\n页面文字：");
console.log(after.txt.split("\n").map((l) => "   " + l).join("\n"));

console.log("\n" + "═".repeat(74));
console.log(`  捕获 ${captured.size} 个接口`);
console.log("═".repeat(74));
for (const c of [...captured.values()].sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`\n[${c.status ?? "?"}] ${c.method} ${c.host}${c.path}`);
  const q = { ...c.query };
  for (const k of ["yodaReady", "csecplatform", "csecversion", "mtgsig"]) delete q[k];
  if (Object.keys(q).length) console.log("    query: " + JSON.stringify(q).slice(0, 340));
  if (c.postData) console.log("    body : " + String(c.postData).replace(/\s+/g, " ").slice(0, 340));
  if (c.body) console.log("    响应 : " + String(c.body).replace(/\s+/g, " ").slice(0, 700));
}

await mkdir("_recon/ka", { recursive: true });
await writeFile("_recon/ka/sniff-effect.json", JSON.stringify([...captured.values()], null, 2), "utf8");
console.log(`\n落盘 _recon/ka/sniff-effect.json`);
await cdp.close();
