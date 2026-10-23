/**
 * 抓「真实页面」给 accountstatus/get 发的完整请求（方法/参数/body）。

主：我之前的探测是**不带参数**直接打这个接口，得到 `bizLine为空` ——
 * 但那很可能只是因为没传 bizLine，属于**我自己制造的假象**。
 * 所以要看页面真实发的是什么。
 *   node src/sniff-accountstatus.mjs [--port=9223]
 */
import { connectToPage } from "./lib/cdp.mjs";

const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 9223);
const cdp = await connectToPage(PORT);

const hits = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (!/accountstatus|dialogdispatch|queryMenu|menu\/category|role|bizLine/i.test(u)) return;
  hits.push({
    method: p.request.method,
    url: u,
    postData: p.request.postData ?? null,
    headers: Object.fromEntries(
      Object.entries(p.request.headers ?? {}).filter(([k]) =>
        /^(referer|content-type|x-|biz|origin)/i.test(k),
      ),
    ),
  });
});

console.log("导航到 /main/frame 并观察真实请求…");
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await new Promise((r) => setTimeout(r, 15000));

console.log(`\n══ 捕获 ${hits.length} 条 ══`);
for (const h of hits) {
  console.log(`\n${h.method} ${h.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 150)}`);
  if (h.postData) console.log(`  body: ${String(h.postData).slice(0, 400)}`);
  const hs = Object.entries(h.headers);
  if (hs.length) console.log(`  headers: ${JSON.stringify(h.headers).slice(0, 300)}`);
}

await cdp.close();
