/**
 * 把闪购「营业分析」页里所有数据请求的 functionType 抄全，找出「多门店表格」那一个。
 *   node src/probe-taobao-detail-functions.mjs [--port=9222]
 *
 * 背景（2026-09-21）：闪购前端已改版，`proteinQueryForArea`（老的 proteinCode 体系）
 *   对**所有** code 都返回 `FAIL_SYS_SERVICE_INNER_FAULT`。
 *   页面现在走的是 `data.analysis.getlistdata` / `getpagelistdata` + `functionType`。
 *   要从「老接口的 SEn1HKG（多门店表格）」迁到新接口，必须知道新体系里
 *   **门店级明细**对应哪个 functionType —— 依然是「让页面自己发一遍」。
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
  if (!/data\.analysis\.(getlistdata|getpagelistdata|getmoduledata)/i.test(u)) return;
  const dec = decodeURIComponent(u);
  const q = /[?&]data=([^&]+)/.exec(dec);
  let payload = {};
  try { payload = JSON.parse(q ? q[1] : "{}"); } catch { /* ignore */ }
  seen.push({ api: /getpagelistdata/i.test(u) ? "getPageListData" : /getmoduledata/i.test(u) ? "getModuleData" : "getListData", payload, status: null, url: u });
});
cdp.on("Network.responseReceived", (p) => {
  const rec = seen.find((x) => x.url === p.response?.url);
  if (rec) rec.status = p.response?.status ?? null;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickByText = async (re) =>
  evaluate(
    cdp,
    `(() => {
       const re = new RegExp(${JSON.stringify(re)});
       const cands = [...document.querySelectorAll('a,span,li,div,button')]
         .filter(e => e.offsetParent && re.test((e.textContent||'').trim()) && (e.textContent||'').trim().length <= 14);
       if (!cands.length) return { ok: false, n: 0 };
       const el = cands[0];
       el.click();
       return { ok: true, text: (el.textContent||'').trim(), n: cands.length };
     })()`,
  ).catch((e) => ({ ok: false, err: String(e.message).slice(0, 70) }));

const visibleTexts = async (re) =>
  evaluate(
    cdp,
    `(() => {
       const re = new RegExp(${JSON.stringify(re)});
       const out = [];
       for (const e of document.querySelectorAll('a,span,li,div,button')) {
         if (!e.offsetParent) continue;
         const t = (e.textContent || '').trim();
         if (t && t.length <= 14 && re.test(t)) out.push(t);
       }
       return [...new Set(out)].slice(0, 40);
     })()`,
  ).catch(() => []);

console.log("① 打开闪购后台");
await cdp.send("Page.navigate", { url: "about:blank" });
await sleep(1200);
await cdp.send("Page.navigate", { url: BASE });
await sleep(22_000);

console.log("② 进「数据」");
console.log(`   ${JSON.stringify(await clickByText("^数据$"))}`);
await sleep(6000);

console.log("③ 进「营业分析」");
console.log(`   ${JSON.stringify(await clickByText("^营业分析$"))}`);
await sleep(14_000);

const tabs1 = await visibleTexts("排行|概览|趋势|明细|门店|构成|来源|分布|对比|时段");
console.log(`   可见模块/页签：${JSON.stringify(tabs1)}`);

/** 依次点这些候选，每点一个等一会儿，把新出现的 functionType 收进来 */
const CANDIDATES = ["门店", "门店排行", "明细", "排行", "概览", "经营概览", "分布", "构成", "对比"];
for (const t of CANDIDATES) {
  const before = seen.length;
  const c = await clickByText(`^${t}$`);
  if (!c?.ok) continue;
  await sleep(9000);
  const added = seen.length - before;
  console.log(`   点「${t}」 → 新增 ${added} 条请求`);
}

// 也试一下顶部一级页签
console.log("\n④ 试「经营概览」「流量分析」「商品分析」");
for (const t of ["经营概览", "流量分析", "商品分析", "服务分析"]) {
  const before = seen.length;
  const c = await clickByText(`^${t}$`);
  if (!c?.ok) { console.log(`   「${t}」没点到`); continue; }
  await sleep(11_000);
  console.log(`   点「${t}」 → 新增 ${seen.length - before} 条请求`);
}

// ── 汇总所有见过的 functionType ──
const catalog = new Map();
for (const s of seen) {
  const key = `${s.api} | pageType=${s.payload.pageType ?? "?"} | moduleType=${s.payload.moduleType ?? "?"} | functionType=${s.payload.functionType ?? "?"}`;
  const rec = catalog.get(key) ?? { n: 0, sample: s.payload, status: s.status };
  rec.n++;
  if (s.status) rec.status = s.status;
  catalog.set(key, rec);
}

console.log(`\n════ 捕获 ${seen.length} 条，去重后 ${catalog.size} 种调用 ════`);
for (const [k, v] of [...catalog.entries()].sort()) {
  console.log(`\n  ▸ ${k}   ×${v.n}  HTTP ${v.status ?? "?"}`);
  const p = v.sample;
  console.log(`     datePeriodTypeCode=${p.datePeriodTypeCode} startDate=${p.startDate} endDate=${p.endDate}`);
  if (p.extendParam) console.log(`     extendParam=${String(p.extendParam).slice(0, 140)}`);
}
console.log(`\n⭐ 要找的是**门店级**明细（老接口的 SEn1HKG = 多门店表格）。`);
console.log(`   候选关键词：shop / poi / store / ranking / table 出现在 functionType 或 moduleType 里。`);
await cdp.close();
