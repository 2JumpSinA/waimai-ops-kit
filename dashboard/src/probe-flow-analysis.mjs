/**
 * 去「流量分析」页确认**平台真正的总曝光口径**。
 *   node src/probe-flow-analysis.mjs [--account=quanyi]
 *
 * 要回答的问题：
 *   经营者要「整个平台的总曝光」，别再逐店循环（136 次请求）。
 *   但我打 flow/module 拿到的 exposureNumber 是 47（近7天），
 *   而逐店求和是 18,515 —— **差 390 倍，不可能是同一个量纲**。
 *   所以必须知道：
 *     (a) 流量分析页用的是哪个接口
 *     (b) 界面把哪个标签配给了这个数（标签是平台写的，比我猜可信）
 *     (c) 有没有**单次调用**就给总量的接口
 *
 * 做法：从控制台点「数据 → 流量分析」，把 URL、请求、以及
 *      「关键词元素的父容器文本」（通常是 标签+数值）全部抄下来。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const compact = (v, n = 220) => (v == null ? "(无)" : String(v).replace(/\s+/g, " ").slice(0, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = /catfront|msp\.meituan|dreport|logan|portal-portm|s3plus|s3\.meituan|awp-|api\.neixin|static-prod|emergencyAccess|latestTime|getLabelList|getCityDataList|pushToken|permissions|poiList$/i;

const cdp = await connectToPage(acct.port);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (SKIP.test(u)) return;
  if (!/yiyao\.meituan\.com\/(api|gw|v2|sc)\//.test(u)) return;
  seen.push({ method: p.request.method, url: u, postData: p.request.postData ?? null });
});

const clickByText = (re) =>
  evaluate(
    cdp,
    `(() => {
       const re = new RegExp(${JSON.stringify(re)});
       const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
       for (let i = 0; i < docs.length; i++) {
         const c = [...docs[i].querySelectorAll('button,a,span,li,div')]
           .filter(e => e.offsetParent && re.test((e.textContent||'').trim()) && (e.textContent||'').trim().length <= 14);
         if (c.length) { c[0].click(); return { ok:true, doc:i, text:(c[0].textContent||'').trim(), n:c.length }; }
       }
       return { ok:false };
     })()`,
  ).catch((e) => ({ ok: false, err: String(e.message).slice(0, 70) }));

console.log(`账号 ${acct.label}  端口 ${acct.port}`);
await cdp.send("Page.navigate", { url: "about:blank" });
await sleep(1200);
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/" });
await sleep(24_000);
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 }).catch(() => ({}));
console.log(`控制台落地：${compact(await evaluate(cdp, "location.href").catch(() => "?"), 120)}`);

console.log("\n① 点「数据」");
console.log(`   ${JSON.stringify(await clickByText("^数据$"))}`);
await sleep(6000);

const subs = await evaluate(
  cdp,
  `(() => {
     const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
     const out = new Set();
     for (const d of docs) for (const e of d.querySelectorAll('a,span,li,div')) {
       if (!e.offsetParent) continue;
       const t = (e.textContent||'').trim();
       if (t && t.length <= 14 && /流量|曝光|访客|看经营|经营分析|数据/.test(t)) out.add(t);
     }
     return [...out].slice(0, 30);
   })()`,
).catch(() => []);
console.log(`   子项：${JSON.stringify(subs)}`);

console.log("\n② 点「流量分析」");
const m = seen.length;
console.log(`   ${JSON.stringify(await clickByText("^流量分析$"))}`);
await sleep(20_000);
console.log(`   落地：${compact(await evaluate(cdp, "location.href").catch(() => "?"), 140)}`);

/* 关键的标签↔数值对照：关键词元素的**父容器文本**通常就是「标签 + 数值」 */
const pairs = await evaluate(
  cdp,
  `(() => {
     const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
     const out = new Set();
     for (const d of docs) {
       for (const e of d.querySelectorAll('div,span,p,label,td,th')) {
         if (!e.offsetParent) continue;
         const own = (e.textContent || '').replace(/\\s+/g,' ').trim();
         if (!own || own.length > 20) continue;
         if (!/曝光|访客|人数|次数|流量|转化/.test(own)) continue;
         const par = e.parentElement ? (e.parentElement.textContent || '').replace(/\\s+/g,' ').trim() : '';
         if (par && par.length <= 90) out.add(par);
       }
     }
     return [...out].slice(0, 45);
   })()`,
).catch(() => []);
console.log(`\n③ 界面「标签+数值」候选（含曝光/流量/访客等）：`);
if (!pairs.length) console.log("   （没有 —— 该页可能也要先选门店，或模块不同）");
for (const t of pairs) console.log(`   · ${t}`);

/* 该页发出的业务请求 */
const uniq = new Map();
for (const h of seen.slice(m)) {
  const path = h.url.replace("https://yiyao.meituan.com", "").split("?")[0];
  const q = new URLSearchParams(h.url.split("?")[1] ?? "");
  for (const k of ["mtgsig", "yodaReady", "csecplatform", "csecversion", "ignoreSetRouterProxy"]) q.delete(k);
  const key = h.method + " " + path + " " + q.toString();
  if (!uniq.has(key)) uniq.set(key, { method: h.method, path, q: q.toString() });
}
console.log(`\n④ 流量分析页发出的业务请求（${uniq.size} 条）`);
for (const h of uniq.values()) {
  console.log(`   ${h.method} ${h.path}`);
  if (h.q) console.log(`      q: ${compact(h.q, 200)}`);
}

/* 并排：flow/module 的值 */
const flow = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const r = await fetch('/api/page/bizdata/manageHome/multi/o/flow/module?' + qs({
       ignoreSetRouterProxy:'true', businessType:'1', storeType:'2', cityId:'', labelId:'',
       dateType:'last_7_days', beginTime:'20260914', endTime:'20260920',
       compareBeginTime:'20260907', compareEndTime:'20260913' }));
     return await r.json();
   })()`,
  { timeoutMs: 60_000 },
).catch(() => null);
console.log(`\n⑤ flow/module 近7天 = ${compact(JSON.stringify(flow?.data), 400)}`);
console.log(`   对照：逐店求和 totalExposure（近7天）≈ 18515`);
console.log(`\n判读：若界面上有「曝光 xxx」且 xxx=18515 量级 → 该接口/O 就是总曝光，可用；`);
console.log(`      若界面显示的就是 47 量级 → 说明它是别的口径（如单店均值/转化相关），不能用。`);

await cdp.close();
