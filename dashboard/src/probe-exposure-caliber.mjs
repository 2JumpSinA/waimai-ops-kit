/**
 * 同窗口口径对照：平台总曝光（flowTransformation）vs 逐店求和（flowPoiExposureRankingV2）
 *   node src/probe-exposure-caliber.mjs [--account=quanyi]
 *
 * 为什么必须先做这个：
 *   要按经营者的决定把曝光换成「平台总口径」，但我**没有证据**证明逐店的
 *   `poiExposureTimes` 与平台的 `FLOW_POI_EXPOSE_UV`/`PV` 是同一个东西。
 *   先前吃过「一次没对上就换口径」的亏，这次先标定：
 *     同一个窗口（最近一天）两边各取一遍，看 Σ逐店 落在 UV 还是 PV 上。
 *
 * 判据（数值，不看字段名）：
 *   · Σ逐店 ≈ FLOW_POI_EXPOSE_PV  → 逐店是「次数」，可平滑替换
 *   · Σ逐店 ≈ FLOW_POI_EXPOSE_UV  → 逐店是「人数」
 *   · 都不等                      → 口径不同，必须记录差异、不能默默替换
 *
 * 只读，不落盘。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { resolveAccount } from "./lib/account.mjs";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const { cookies: CK } = await loadCookieSmart({ stem: STEM, port: acct.port, host: "yiyao.meituan.com", required: ["token", "acctId"] });
const ACCT_ID = String(CK.acctId ?? "");

/* 门店清单 */
const mf = join(ROOT, "data", "raw", `${STEM}.json`);
if (!existsSync(mf)) { console.error(`缺 ${mf}`); process.exit(1); }
const stores = (JSON.parse(readFileSync(mf, "utf8")).stores ?? []).map((s) => String(s.id));
console.log(`账号 ${acct.label}  acctId=${ACCT_ID}  门店 ${stores.length} 家`);

const cdp = await connectToPage(acct.port);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 1200));
// 逐店接口在「流量分析」页上下文里最稳
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame#/page/recoanalysis/pc#traffic" });
await new Promise((r) => setTimeout(r, 22_000));
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 }).catch(() => ({}));

const pad = (n) => String(n).padStart(2, "0");
const ymd = (off) => { const t = new Date(Date.now() + off * 86400_000); return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`; };
const today = ymd(0);

/* ── ① 平台总口径（recentDays=1，+ 重试） ── */
const platform = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     for (let attempt = 1; attempt <= 4; attempt++) {
       const r = await fetch('/api/page/recoanalysis/flowAnalysisV5/recentDays/flowTransformation?' + qs({
         ignoreSetRouterProxy:'true', acctId:'${ACCT_ID}', cityIds:'0', source:'0', wmPoiId:'-1',
         beginTime:'${today}', endTime:'${today}', recentDays:'1',
         compareBeginTime:'${ymd(-1)}', compareEndTime:'${ymd(-1)}',
       }), { credentials: 'include' });
       const j = await r.json().catch(() => null);
       if (j && j.code === 0) {
         const arr = Array.isArray(j.data) ? j.data : [];
         const g = (idx) => { const o = arr.find(x => x.index === idx); return o ? { current: o.current, ring: o.ring, date: o.date } : null; };
         return { ok: true, attempt, uv: g('FLOW_POI_EXPOSE_UV'), pv: g('FLOW_POI_EXPOSE_PV') };
       }
       await new Promise(r2 => setTimeout(r2, 4000));
     }
     return { ok: false };
   })()`,
  { timeoutMs: 120_000 },
);
console.log(`\n平台总口径（recentDays=1，第 ${platform.attempt} 次成功）`);
console.log(`  FLOW_POI_EXPOSE_UV = ${JSON.stringify(platform.uv)}`);
console.log(`  FLOW_POI_EXPOSE_PV = ${JSON.stringify(platform.pv)}`);

/* ── ② 逐店求和（同一天：beginTime=endTime=今天，recentDays=1） ── */
const BATCH = 25;
const ids = stores;
let sumTimes = 0, sumOk = 0, sumErr = 0;
const sampleDates = new Set();
for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  process.stdout.write(`\r  逐店 ${i + chunk.length}/${ids.length}…   `);
  const res = await evaluate(
    cdp,
    `(async () => {
       const ids = ${JSON.stringify(chunk)};
       const sleep = (ms) => new Promise(r => setTimeout(r, ms));
       const out = [];
       for (const pid of ids) {
         try {
           const r = await fetch('/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2'
             + '?acctId=${ACCT_ID}&beginTime=${today}&endTime=${today}&recentDays=1'
             + '&wmPoiId=' + pid + '&cityIds=0&source=0&type=2', { credentials: 'include' });
           const j = await r.json();
           const d = j.data;
           out.push({ pid, times: d ? (d.poiExposureTimes ?? null) : null, dataDate: d ? (d.dataDate ?? null) : null,
                      uv: d ? (d.poiExposureUv ?? d.poiExposureUV ?? null) : null,
                      keys: d ? Object.keys(d).slice(0, 24) : null });
         } catch (e) { out.push({ pid, error: String(e && e.message) }); }
         await sleep(60);
       }
       return out;
     })()`,
    { timeoutMs: 180_000 },
  );
  for (const r of res) {
    if (r.error) { sumErr++; continue; }
    if (r.times == null) continue;
    sumTimes += Number(r.times) || 0;
    sumOk++;
    if (r.dataDate) sampleDates.add(String(r.dataDate));
    if (sumOk === 1) console.log(`\n  首个门店字段键：${JSON.stringify(r.keys)}`);
  }
}
process.stdout.write("\r" + " ".repeat(48) + "\r");

console.log(`\n逐店求和（同一天 ${today}，recentDays=1）`);
console.log(`  有效门店 ${sumOk} 家   报错 ${sumErr} 家   dataDate 集合 ${JSON.stringify([...sampleDates])}`);
console.log(`  Σ poiExposureTimes = ${sumTimes.toLocaleString("zh-CN")}`);

console.log(`\n════ 口径对照 ════`);
const pv = platform.pv?.current, uv = platform.uv?.current;
console.log(`  平台 PV（次数） = ${pv}      差 ${pv != null ? sumTimes - pv : "?"}`);
console.log(`  平台 UV（人数） = ${uv}      差 ${uv != null ? sumTimes - uv : "?"}`);
const nearPv = pv != null && Math.abs(sumTimes - pv) <= Math.max(2, pv * 0.02);
const nearUv = uv != null && Math.abs(sumTimes - uv) <= Math.max(2, uv * 0.02);
if (nearPv && !nearUv) console.log(`  → ✅ Σ逐店 = 平台**次数(PV)**，口径一致，可替换`);
else if (nearUv && !nearPv) console.log(`  → ✅ Σ逐店 = 平台**人数(UV)**，口径一致，可替换`);
else if (nearPv && nearUv) console.log(`  → ⚠️ UV 与 PV 数值相同（该日曝光只算一次？），无法区分`);
else console.log(`  → ❌ 两边都对不上（差 ${pv != null ? sumTimes - pv : "?"} / ${uv != null ? sumTimes - uv : "?"}）—— 口径不同，**不能直接替换**，须记录差异`);

await cdp.close();
