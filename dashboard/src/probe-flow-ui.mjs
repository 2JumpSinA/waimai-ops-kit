/**
 * 把经营首页「流量模块」的**界面标签与数值**抄下来，用来解释 flow/module 的 exposureNumber 量纲。
 *   node src/probe-flow-ui.mjs [--account=quanyi]
 *
 * 为什么要做：
 *   经营者要「整个平台的总曝光口径」，别再逐店循环（136 次请求 / 97 秒）。
 *   但我打 flow/module 拿到的 exposureNumber = 47（近7天），
 *   而逐店求和是 18,515 —— **差 390 倍，不可能是同一个量纲**。
 *   在把看板切过去之前必须搞清它是「次数/人数」「总数/单店均值」还是别的。
 *   办法：看界面把哪个标签配给了这个数（标签是平台自己写的，比我猜可信）。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const ANALYSIS = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";

const cdp = await connectToPage(acct.port);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 1200));
await cdp.send("Page.navigate", { url: ANALYSIS });
await new Promise((r) => setTimeout(r, 22_000));
await waitSignedReady(cdp, "/api/page/bizdata/manageHome/latestTime?dateType=realTime", { timeoutMs: 90_000 }).catch(() => ({}));

const out = await evaluate(
  cdp,
  `(() => {
     const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
     const res = { exposureCards: [], allLabels: [] };
     for (const d of docs) {
       for (const e of d.querySelectorAll('div,span,li,section,article')) {
         if (!e.offsetParent) continue;
         const t = (e.textContent || '').replace(/\\s+/g, ' ').trim();
         if (!t || t.length > 260) continue;
         if (!/曝光|流量|访客|人数|次数/.test(t)) continue;
         // 只要「标签 + 数字」这种紧凑片段，避免整块容器文本
         if (t.length <= 120 && /[0-9]/.test(t) && !res.exposureCards.includes(t)) res.exposureCards.push(t);
       }
       for (const e of d.querySelectorAll('div,span,label,th')) {
         if (!e.offsetParent) continue;
         const t = (e.textContent || '').replace(/\\s+/g, ' ').trim();
         if (t && t.length <= 14 && /曝光|流量|访客|人数|次数|转化/.test(t) && !res.allLabels.includes(t)) res.allLabels.push(t);
       }
     }
     res.exposureCards = res.exposureCards.slice(0, 40);
     res.allLabels = res.allLabels.slice(0, 40);
     return res;
   })()`,
  { timeoutMs: 60_000 },
);

console.log("══ 含「曝光/流量/访客/人数」的紧凑文本块（标签+数字）══");
if (!out.exposureCards.length) console.log("  （没有 —— 可能这个页面默认不显示流量模块）");
for (const t of out.exposureCards) console.log(`  · ${t}`);

console.log("\n══ 相关短标签 ══");
console.log(`  ${JSON.stringify(out.allLabels)}`);

// 同时再打一次 flow/module，把数值并排摆出来对照
const flow = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const common = { ignoreSetRouterProxy: 'true', businessType: '1', storeType: '2', cityId: '', labelId: '' };
     const r = await fetch('/api/page/bizdata/manageHome/multi/o/flow/module?' + qs({
       ...common, dateType: 'last_7_days', beginTime: '20260914', endTime: '20260920',
       compareBeginTime: '20260907', compareEndTime: '20260913' }));
     return await r.json();
   })()`,
  { timeoutMs: 60_000 },
);
console.log("\n══ flow/module 近7天 原样 ══");
console.log("  " + JSON.stringify(flow?.data ?? flow).slice(0, 700));
console.log("\n对照：逐店求和（exposure-quanyi.json 的 totalExposure）近7天 ≈ 18515");
console.log("若上面 exposureNumber=47 与界面上的 47 一致，就能确定它的口径（次数/人数/单店均值）。");

await cdp.close();
