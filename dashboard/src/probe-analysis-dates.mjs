/**
 * 经营首页（/page/analysis/home/o2o）的时间切换器到底是哪几个、点了发什么请求。
 *   node src/probe-analysis-dates.mjs [--account=quanyi]
 *
 * 为什么要重做：
 *   经营者确认「7天/30天 入口就在这个页面下」，但我上一轮在这个页面上只看到 5 个外壳标签
 *   （全部门店/全部订单/今日待办7/财务统计/全部服务），点「近30天」返回 {ok:false}。
 *
 *   我的怀疑：`Page.navigate` 到**只有 hash 不同**的 URL，浏览器不会重新加载文档，
 *   single-spa 微应用因此没有挂载 —— 我看到的只是外壳。
 *   所以这轮先 `about:blank` 再跳目标页，制造一次**真正的文档加载**，并且等更久。
 *
 * 这轮只做观察，不改任何数据。不打印 cookie / token / mtgsig。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;
const TARGET = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";

const compact = (v, n = 300) => (v == null ? "(无)" : String(v).replace(/\s+/g, " ").slice(0, n));
const SKIP = /catfront|horn\/v1|s3plus|s3\.meituan|awps-assets|awp-static|msp\.meituan|dreport|logan|portal-portm|static-prod/;

const cdp = await connectToPage(PORT);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (SKIP.test(u)) return;
  seen.push({ method: p.request.method, url: u, postData: p.request.postData ?? null });
});

const dumpNew = (from, label) => {
  const list = seen.slice(from);
  const uniq = new Map();
  for (const h of list) {
    const key = h.method + " " + h.url.split("?")[0] + " " + String(h.postData ?? "").slice(0, 90);
    if (!uniq.has(key)) uniq.set(key, h);
  }
  console.log(`\n      ── ${label}（新增 ${list.length}，去重 ${uniq.size}） ──`);
  if (!uniq.size) { console.log("         （无）"); return; }
  for (const h of uniq.values()) {
    const path = h.url.replace("https://yiyao.meituan.com", "").split("?")[0];
    const q = new URLSearchParams(h.url.split("?")[1] ?? "");
    for (const k of ["mtgsig", "yodaReady", "csecplatform", "csecversion", "ignoreSetRouterProxy", "test[businessType]", "test[storeType]", "test[cityId]", "test[labelId]"]) q.delete(k);
    console.log(`         ${h.method} ${path}`);
    const qs = q.toString();
    if (qs) console.log(`            query: ${compact(qs, 250)}`);
    if (h.postData) console.log(`            body : ${compact(h.postData, 260)}`);
  }
};

// ── 强制真加载 ──────────────────────────────────────────────────
console.log("── 制造一次真正的文档加载（about:blank → 目标页） ──");
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 2500));
const mark = seen.length;
await cdp.send("Page.navigate", { url: TARGET });
await new Promise((r) => setTimeout(r, 32_000));

console.log(`   落地: ${compact(await evaluate(cdp, "location.href"), 130)}`);
console.log(`   标题: ${compact(await evaluate(cdp, "document.title"), 80)}`);
const size = await evaluate(cdp, "document.body ? document.body.innerText.length : -1");
console.log(`   body.innerText 长度: ${size}`);
dumpNew(mark, "加载时");

// ── 把页面上所有短文本倒出来 ────────────────────────────────────
const labels = await evaluate(
  cdp,
  `(() => {
     const out = [];
     for (const e of document.querySelectorAll('button,a,span,div,li,label,p,em,i,strong,td,th,h1,h2,h3,h4')) {
       if (!e.offsetParent) continue;
       const t = (e.textContent || '').trim();
       if (t && t.length <= 12) out.push(t);
     }
     return [...new Set(out)];
   })()`,
);
console.log(`\n   ── 可见短文本 ${labels.length} 个（全量，便于肉眼找） ──`);
console.log("      " + JSON.stringify(labels).slice(0, 2200));

// 时间语义单独挑出来
const TIME_RE = /近\s*\d+\s*[天日周月]|\d+\s*[天日周月]|今日|今天|昨日|昨天|实时|本周|上周|本月|上月|自定义|全部|统计|环比|同比/;
const timeish = labels.filter((t) => TIME_RE.test(t));
console.log(`\n   ── 含时间语义 ${timeish.length} 个 ──`);
console.log("      " + JSON.stringify(timeish));

// 下拉框选项
const selects = await evaluate(
  cdp,
  `(() => [...document.querySelectorAll('select')].filter(s => s.offsetParent)
     .map(s => ({ val: s.value, opts: [...s.options].map(o => o.textContent.trim()) })))()`,
);
console.log(`\n   ── <select> 下拉 ${selects.length} 个 ──`);
console.log("      " + JSON.stringify(selects).slice(0, 800));

// ── 挨个试时间控件 ──────────────────────────────────────────────
const tryClick = async (re, name) => {
  const mark2 = seen.length;
  const r = await evaluate(
    cdp,
    `(() => {
       const re = ${re};
       const cands = [...document.querySelectorAll('button,a,span,li,label,div,em,i')]
         .filter(e => e.offsetParent && re.test((e.textContent || '').trim()) && (e.textContent || '').trim().length <= 8);
       if (!cands.length) return { ok: false };
       cands[0].click();
       return { ok: true, text: (cands[0].textContent || '').trim(), n: cands.length,
                cls: String(cands[0].className || '').slice(0, 60) };
     })()`,
  );
  console.log(`\n   ── 点「${name}」 → ${JSON.stringify(r)} ──`);
  if (!r?.ok) return;
  await new Promise((x) => setTimeout(x, 13_000));
  dumpNew(mark2, `点「${name}」之后`);
};

await tryClick(`/近?\\s*7\\s*[天日]/`, "近7天");
await tryClick(`/近?\\s*30\\s*[天日]|近一月|本月/`, "近30天");

console.log("\n════════════════════════════════════════════════════════════");
console.log("关注：点完之后的请求里，若出现金额且落在近7天/近30天的量级，即为平台现成的窗口入口。");
console.log("      品牌A近30天预计收入基准 ≈ 121,869 元（成交额口径会更大，注意区分）。");
await cdp.close();
