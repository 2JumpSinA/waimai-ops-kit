/**
 * 经营首页微应用很可能在 iframe 里 —— 钻进去找时间切换器。
 *   node src/probe-analysis-iframe.mjs [--account=quanyi]
 *
 * 上一轮的教训：
 *   · 顶层文档只有外壳菜单（105 个），没有 近7天/近30天 字样 → 内容不在顶层
 *   · 输出被 IM(api.neixin.cn) / 埋点 / data:base64 刷屏 → 本轮严格过滤
 *
 * 本轮：
 *   1. about:blank → 目标页（真加载）
 *   2. 列出所有 iframe（src + 是否同源 + innerText 长度）
 *   3. 同源 iframe 里找时间控件，点它，录请求
 *   4. 也直接枚举 iframe 里有「金额感」的文本，便于确认内容到底渲染了没
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;
const TARGET = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";
const compact = (v, n = 200) => (v == null ? "(无)" : String(v).replace(/\s+/g, " ").slice(0, n));

/** 只留业务接口；埋点/IM/静态资源/base64 一律丢 */
const KEEP = /^https:\/\/yiyao\.meituan\.com\/(api|gw|v2|sc|health|customerService)\//;
const BUSINESS = /manageHome|bizdata|order\/list|analysis|report|chart/i;

const cdp = await connectToPage(PORT);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (!KEEP.test(u) || !BUSINESS.test(u)) return;
  seen.push({ method: p.request.method, url: u, postData: p.request.postData ?? null });
});

const dumpNew = (from, label) => {
  const uniq = new Map();
  for (const h of seen.slice(from)) {
    const k = h.method + " " + h.url.split("?")[0] + " " + String(h.postData ?? "").slice(0, 70);
    if (!uniq.has(k)) uniq.set(k, h);
  }
  console.log(`\n   ── ${label}（${uniq.size} 条） ──`);
  if (!uniq.size) { console.log("      （无）"); return; }
  for (const h of uniq.values()) {
    const q = new URLSearchParams(h.url.split("?")[1] ?? "");
    for (const k of ["mtgsig", "yodaReady", "csecplatform", "csecversion", "ignoreSetRouterProxy"]) q.delete(k);
    console.log(`      ${h.method} ${h.url.replace("https://yiyao.meituan.com", "").split("?")[0]}`);
    if (q.toString()) console.log(`         q: ${compact(q.toString(), 200)}`);
    if (h.postData) console.log(`         b: ${compact(h.postData, 200)}`);
  }
};

console.log("── 真加载 ──");
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 2500));
const mark = seen.length;
await cdp.send("Page.navigate", { url: TARGET });
await new Promise((r) => setTimeout(r, 30_000));
console.log(`   落地: ${compact(await evaluate(cdp, "location.href"), 120)}`);

// ── iframe 清单 ────────────────────────────────────────────────
const frames = await evaluate(
  cdp,
  `(() => [...document.querySelectorAll('iframe')].map((f, i) => {
     let same = false, len = -1, err = null, texts = [];
     try {
       same = !!f.contentDocument;
       if (same) {
         len = f.contentDocument.body ? f.contentDocument.body.innerText.length : -1;
         const re = /近\\s*\\d+\\s*[天日]|今日|昨日|营业额|成交|预计收入|曝光|排名|环比/;
         const s = new Set();
         for (const e of f.contentDocument.querySelectorAll('*')) {
           const t = (e.textContent || '').trim();
           if (t && t.length <= 14 && re.test(t)) s.add(t);
         }
         texts = [...s].slice(0, 30);
       }
     } catch (e) { err = String(e).slice(0, 60); }
     return { i, src: (f.src || '(空)').slice(0, 110), same, len, err, texts };
   }))()`,
);
console.log(`\n── iframe 清单（${frames.length} 个） ──`);
for (const f of frames) {
  console.log(`   [${f.i}] same=${f.same} innerText=${f.len}  src=${f.src}`);
  if (f.err) console.log(`         err: ${f.err}`);
  if (f.texts?.length) console.log(`         时间/金额字样: ${JSON.stringify(f.texts)}`);
}

// 顶层也再确认一次内容区
const topTexts = await evaluate(
  cdp,
  `(() => {
     const re = /近\\s*\\d+\\s*[天日]|今日|昨日|营业额|成交额|预计收入|曝光|排名|环比|同比/;
     const s = new Set();
     for (const e of document.querySelectorAll('*')) {
       const t = (e.textContent || '').trim();
       if (t && t.length <= 16 && re.test(t)) s.add(t);
     }
     return [...s].slice(0, 40);
   })()`,
);
console.log(`\n── 顶层含时间/金额语义的文本 ──\n   ${JSON.stringify(topTexts)}`);

const bodyLen = await evaluate(cdp, "document.body.innerText.length");
console.log(`   顶层 body.innerText 长度 = ${bodyLen}`);

dumpNew(mark, "整个加载过程（只留业务接口）");

// ── 在 iframe 里点时间控件 ─────────────────────────────────────
const clickIn = async (frameIdx, reSrc, name) => {
  const mark2 = seen.length;
  const r = await evaluate(
    cdp,
    `(() => {
       const f = document.querySelectorAll('iframe')[${frameIdx}];
       const doc = f && f.contentDocument;
       if (!doc) return { ok: false, why: 'no-contentDocument' };
       const re = ${reSrc};
       const cands = [...doc.querySelectorAll('button,a,span,li,label,div,em,i')]
         .filter(e => e.offsetParent && re.test((e.textContent || '').trim()) && (e.textContent || '').trim().length <= 8);
       if (!cands.length) return { ok: false, why: 'no-candidate' };
       cands[0].click();
       return { ok: true, text: (cands[0].textContent || '').trim(), n: cands.length };
     })()`,
  );
  console.log(`\n   ── iframe[${frameIdx}] 点「${name}」 → ${JSON.stringify(r)} ──`);
  if (!r?.ok) return;
  await new Promise((x) => setTimeout(x, 12_000));
  dumpNew(mark2, `点「${name}」之后`);
};

if (frames.length) {
  for (let i = 0; i < Math.min(frames.length, 4); i++) {
    if (!frames[i].same) continue;
    await clickIn(i, `/近?\\s*7\\s*[天日]/`, "近7天");
    await clickIn(i, `/近?\\s*30\\s*[天日]|近一月|本月/`, "近30天");
  }
} else {
  console.log("\n   （顶层没有 iframe —— 那内容不在这里，需要换判据）");
}

console.log("\n════════════════════════════════════════════════════════════");
console.log("品牌A近30天预计收入基准 ≈ 121,869 元；成交额口径会明显更大，注意区分。");
await cdp.close();
