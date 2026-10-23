/**
 * 验证「总曝光」单次调用口径：flowAnalysisV5/recentDays/flowTransformation
 *   node src/probe-flow-total.mjs [--account=quanyi]
 *
 * 背景（2026-09-21，去流量分析页确认出来的）：
 *   流量分析页 `/page/recoanalysis/pc#traffic` 上显示：
 *     曝光人数 5,838 人（比前1日 +3.28%）
 *     曝光次数 18,280 次（比前1日 +1.3%）
 *   —— 与逐店求和 18,515 同量级，**这就是平台的总曝光**。
 *   它用的接口是 flowAnalysisV5/recentDays/flowTransformation（一次调用给总量），
 *   而不是我现在逐店循环的 flowAnalysisV4/single/.../flowPoiExposureRankingV2。
 *
 * ⭐ 判据（数值，不看字段名）：
 *   用 recentDays=7 打一次，若 曝光次数 ≈ 逐店求和（exposure-*.json 的 totalExposure）
 *   → 口径一致，可以整体替换逐店循环（136 次请求 → 1 次）。
 *
 * 只读，不落盘。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";
import { readFileSync, existsSync } from "node:fs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const compact = (v, n = 300) => (v == null ? "(null)" : String(v).replace(/\s+/g, " ").slice(0, n));

/* 本地逐店求和的对照值 */
let localTotal = null, localWindow = null;
const f = dataPath(acct, "exposure");
if (existsSync(f)) {
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    localTotal = j.totalExposure;
    localWindow = j.window;
  } catch { /* ignore */ }
}

const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const { cookies: CK } = await loadCookieSmart({
  stem: STEM, port: acct.port, host: "yiyao.meituan.com", required: ["token", "acctId"],
});
const ACCT_ID = String(CK.acctId ?? "");

const cdp = await connectToPage(acct.port);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 1200));
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame#/page/recoanalysis/pc#traffic" });
await new Promise((r) => setTimeout(r, 22_000));
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 }).catch(() => ({}));
console.log(`账号 ${acct.label}  落地 ${compact(await evaluate(cdp, "location.href").catch(() => "?"), 100)}`);

const pad = (n) => String(n).padStart(2, "0");
const ymd = (o) => { const t = new Date(Date.now() + o * 86400_000); return `${t.getFullYear()}${pad(t.getMonth() + 1)}${p(t.getDate())}`; };
function p(n) { return String(n).padStart(2, "0"); }

const out = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const res = [];
     // 端点是 recentDays 驱动的：窗口 = 截止昨天，长度 = recentDays
     for (const days of [1, 7, 30]) {
       const end = '${ymd(-1)}';
       const begin = (() => { const d = new Date(Date.now() - days * 86400_000); return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0'); })();
       const cEnd = '${ymd(-2)}';
       const cBegin = (() => { const d = new Date(Date.now() - (days * 2) * 86400_000); return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0'); })();
       const url = '/api/page/recoanalysis/flowAnalysisV5/recentDays/flowTransformation?' + qs({
         ignoreSetRouterProxy: 'true', acctId: '${ACCT_ID}', cityIds: '0', source: '0', wmPoiId: '-1',
         beginTime: begin, endTime: end, recentDays: String(days),
         compareBeginTime: cBegin, compareEndTime: cEnd,
       });
       try {
         const r = await fetch(url, { credentials: 'include' });
         const j = await r.json().catch(() => null);
         res.push({ days, begin, end, code: j?.code, msg: j?.msg, data: j?.data ?? null });
       } catch (e) { res.push({ days, err: String(e).slice(0, 90) }); }
       await new Promise(r => setTimeout(r, 400));
     }
     // 顺带看看曝光趋势曲线
     const end = '${ymd(-1)}';
     const begin = (() => { const d = new Date(Date.now() - 7 * 86400_000); return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0'); })();
     const cu = '/api/page/recoanalysis/flowAnalysisV5/recentDays/flowTransformationChart?' + qs({
       ignoreSetRouterProxy: 'true', cityIds: '0', beginTime: begin, endTime: end, recentDays: '7',
       compareBeginTime: '${ymd(-14)}', compareEndTime: '${ymd(-8)}', index: 'FLOW_POI_EXPOSE_UV',
     });
     let chart = null;
     try { chart = await (await fetch(cu, { credentials: 'include' })).json(); } catch { /* ignore */ }
     return { res, chart };
   })()`,
  { timeoutMs: 180_000 },
);

for (const r of out.res) {
  console.log(`\n▸ recentDays=${r.days}  ${r.begin}~${r.end}  code=${r.code ?? "?"} ${r.err ? "ERR " + r.err : ""}`);
  if (r.msg && String(r.msg).length > 3) console.log(`   msg: ${r.msg}`);
  if (!r.data) continue;
  const walk = (o, path = "", acc = []) => {
    if (!o || typeof o !== "object" || path.split(".").length > 4) return acc;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object") walk(v, path + k + ".", acc);
      else acc.push([path + k, v]);
    }
    return acc;
  };
  const flat = walk(r.data);
  const hit = flat.filter(([k]) => /expose|uv|pv|flow|visit|impress/i.test(k));
  console.log(`   顶层键: ${Object.keys(r.data).join(", ")}`);
  for (const [k, v] of (hit.length ? hit : flat).slice(0, 18)) console.log(`     ${k} = ${compact(v, 110)}`);
}

console.log(`\n════ 口径对照 ════`);
console.log(`  本地逐店求和 totalExposure = ${localTotal}   窗口 ${JSON.stringify(localWindow)}`);
console.log(`  平台 flowTransformation 近7天 = 见上面 recentDays=7 的 exposure 类字段`);
console.log(`  判据：两者同量级（约 1.8 万）→ 口径一致，可把 136 次逐店请求换成 1 次调用。`);

if (out.chart) {
  console.log(`\n════ 曝光趋势曲线 (FLOW_POI_EXPOSE_UV, 近7天) ════`);
  const d = out.chart.data ?? out.chart;
  console.log(`  ${compact(JSON.stringify(d), 400)}`);
}

await cdp.close();
