/**
 * 「是他们还是我」判定：让闪购页面**自己在浏览器里**发 protein 请求，看结果。
 *   node src/probe-taobao-detail-page.mjs [--port=9222]
 *
 * 背景：我在 Node 里直接打 `proteinQueryForArea` 全部报
 *   `FAIL_SYS_SERVICE_INNER_FAULT::服务内部故障`，
 *   而同一网关的 getLoginnode 成功、URL 与当年嗅探到的一字不差。
 * 那就该问：**页面自己现在还拿得到数据吗？**
 *   · 页面也拿不到 → 上游故障/改版，我方无事可做
 *   · 页面拿得到   → 我漏了什么，且能顺手嗅出新形状
 *
 * 只观察，不改数据。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9222"));
const BASE = "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next";

const cdp = await connectToPage(PORT);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (!/nrshop\.ele\.me|mtop\.ele\.me/i.test(u)) return;
  seen.push({ id: p.requestId, url: u, method: p.request.method, status: null });
});
cdp.on("Network.responseReceived", (p) => {
  const rec = seen.find((x) => x.id === p.requestId);
  if (rec) rec.status = p.response?.status ?? null;
});

console.log(`导航到闪购后台：${BASE}`);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 1500));
await cdp.send("Page.navigate", { url: BASE });
await new Promise((r) => setTimeout(r, 25_000));

console.log(`\n落地：${await evaluate(cdp, "location.href").catch(() => "(读不到)")}`);

const mtop = seen.filter((s) => /\/h5\//i.test(s.url));
console.log(`\n════ 页面发出的 MTOP 请求 ${mtop.length} 条 ════`);
const byApi = new Map();
for (const s of mtop) {
  const m = /\/h5\/([^/]+)\//i.exec(s.url);
  const api = m ? m[1] : s.url.slice(0, 60);
  const key = `${api} :: ${s.status ?? "?"}`;
  byApi.set(key, (byApi.get(key) ?? 0) + 1);
}
for (const [k, n] of [...byApi.entries()].sort()) console.log(`  ${String(n).padStart(3)}×  ${k}`);

const protein = mtop.filter((s) => /proteinqueryforarea/i.test(s.url));
console.log(`\n════ 其中 protein 请求 ${protein.length} 条 ════`);
if (protein.length) {
  for (const s of protein.slice(0, 5)) {
    console.log(`  HTTP ${s.status}`);
    // 取出 proteinCode，看页面用的是哪个服务号
    const m = /proteinCode%22%3A%22([^%]+)/.exec(s.url) ?? /proteinCode":"([^"]+)/.exec(decodeURIComponent(s.url));
    console.log(`     proteinCode=${m ? m[1] : "?"}   url 长度 ${s.url.length}`);
    const q = decodeURIComponent(s.url).match(/data=([^&]+)/);
    if (q) console.log(`     data=${q[1].slice(0, 260)}`);
  }
} else {
  console.log("  （页面没发 protein 请求 —— 可能默认页不是数据分析页，或前端已改版）");
}

// 页面里有没有可见的菜单能点进「数据」
const labels = await evaluate(
  cdp,
  `(() => {
     const out = [];
     for (const e of document.querySelectorAll('a,span,li,div,button')) {
       if (!e.offsetParent) continue;
       const t = (e.textContent || '').trim();
       if (t && t.length <= 12 && /数据|分析|营业|门店|流量|曝光/.test(t)) out.push(t);
     }
     return [...new Set(out)].slice(0, 24);
   })()`,
).catch(() => []);
console.log(`\n对照：页面上含「数据/分析/营业」的可见短文本 —— ${JSON.stringify(labels)}`);
console.log(`\n判读：若页面自己的 protein 请求也是 5xx/失败 → 上游故障；若成功 → 我漏了东西。`);
await cdp.close();
