/**
 * 点进闪购「数据」菜单，让页面自己发 protein 请求，把真实请求参数抄下来。
 *   node src/probe-taobao-detail-menu.mjs [--port=9222]
 *
 * 为什么需要它（2026-09-21）：
 *   Node 侧直接打 `proteinQueryForArea` 全部报 `FAIL_SYS_SERVICE_INNER_FAULT`，
 *   而同一网关的 getLoginnode 成功、URL 与当年嗅探的一字不差、所有变体都一样失败。
 *   判别「是他们改版了还是我漏了参数」的唯一可靠办法：
 *   **让页面自己发一遍，把 data 逐字抄下来**。猜是最贵的方式。
 *
 * 只观察，不改任何数据。
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
  if (!/\/h5\//i.test(u)) return;
  if (!/protein|data\.analysis/i.test(u)) return;
  seen.push({ url: u, method: p.request.method, status: null, postData: p.request.postData ?? null });
});
cdp.on("Network.responseReceived", (p) => {
  const rec = seen.find((x) => x.url === p.response?.url);
  if (rec) rec.status = p.response?.status ?? null;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("① 打开闪购后台");
await cdp.send("Page.navigate", { url: "about:blank" });
await sleep(1200);
await cdp.send("Page.navigate", { url: BASE });
await sleep(22_000);
console.log(`   落地：${await evaluate(cdp, "location.href").catch(() => "?")}`);

/** 在页面里按文本找一个可见可点的元素并点击 */
const clickByText = async (re, pick = 0) =>
  evaluate(
    cdp,
    `(() => {
       // ⚠️ 必须 JSON.stringify —— 直接 ${'`'}const src = ${'$'}{re}${'`'} 会把 ^数据$ 当成
       //    裸表达式注入，报 "Unexpected token '^'"，而且看起来像页面出错（我第一版就栽这）。
       const src = ${JSON.stringify(re)};
       const re = new RegExp(src);
       const cands = [...document.querySelectorAll('a,span,li,div,button')]
         .filter(e => e.offsetParent && re.test((e.textContent||'').trim()) && (e.textContent||'').trim().length <= 14);
       if (!cands.length) return { ok: false, n: 0 };
       const el = cands[Math.min(${pick}, cands.length - 1)];
       el.click();
       return { ok: true, text: (el.textContent||'').trim(), n: cands.length };
     })()`,
  ).catch((e) => ({ ok: false, err: String(e.message).slice(0, 80) }));

console.log("\n② 点「数据」菜单");
const c1 = await clickByText("^数据$");
console.log(`   ${JSON.stringify(c1)}`);
await sleep(6000);

const subs = await evaluate(
  cdp,
  `(() => {
     const out = [];
     for (const e of document.querySelectorAll('a,span,li,div')) {
       if (!e.offsetParent) continue;
       const t = (e.textContent || '').trim();
       if (t && t.length <= 14 && /营业|分析|门店|流量|曝光|商品|订单|看板|概览/.test(t)) out.push(t);
     }
     return [...new Set(out)].slice(0, 30);
   })()`,
).catch(() => []);
console.log(`   可见子项：${JSON.stringify(subs)}`);

console.log("\n③ 依次尝试点子项（营业/分析优先）");
for (const pat of ["营业统计|营业分析", "门店", "流量|曝光", "分析"]) {
  const c = await clickByText(pat, 0);
  if (c?.ok) {
    console.log(`   点了「${c.text}」（匹配 ${c.n} 个）`);
    await sleep(12_000);
    if (seen.some((s) => /protein/i.test(s.url))) break;
  } else {
    console.log(`   「${pat}」没点到（${JSON.stringify(c)}）`);
  }
}

console.log(`\n════ 捕获到的 data.analysis / protein 请求 ${seen.length} 条 ════`);
const uniq = new Map();
for (const s of seen) {
  const m = /\/h5\/([^/]+)\//i.exec(s.url);
  const api = m ? m[1] : "?";
  const dec = decodeURIComponent(s.url);
  const code = /proteinCode"?:"?([A-Za-z0-9]+)/.exec(dec.replace(/\\"/g, '"'))?.[1] ?? "-";
  const key = `${api} :: ${code} :: ${s.status ?? "?"}`;
  if (!uniq.has(key)) uniq.set(key, { ...s, api, code, dec });
}
for (const [k, s] of uniq) {
  console.log(`\n  ▸ ${k}`);
  const q = s.dec.match(/[?&]data=([^&]+)/);
  if (q) {
    console.log(`     data（解码后，截断 400）= ${q[1].slice(0, 400)}`);
    console.log(`     ⭐ 与本地构造的差异要看这里：context / request 的键顺序与字段`);
  } else if (s.postData) {
    console.log(`     body = ${String(s.postData).slice(0, 400)}`);
  }
}
console.log(`\n判读：若这里有 HTTP 200 且带 records 的 protein 请求，就把上面 data 逐字抄成模板并对照差异；`);
console.log(`      若一条都没有 200，说明上游确实坏了，我方无事可做。`);
await cdp.close();
