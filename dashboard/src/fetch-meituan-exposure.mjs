/**
 * 美团「曝光」取数。
 *   node src/fetch-meituan-exposure.mjs [--account=quanyi|yifeng] [--mode=total|byPoi]
 *
 * ⭐ 默认 `--mode=total`：**平台总口径**（经营者 2026-09-21 决定）
 *   入口页面：流量分析 `/page/recoanalysis/pc#traffic`
 *   接口：`GET /api/page/recoanalysis/flowAnalysisV5/recentDays/flowTransformation`
 *     → data 数组：`FLOW_POI_EXPOSE_UV`(曝光人数) / `FLOW_POI_EXPOSE_PV`(曝光次数)
 *   窗口由 `recentDays` 决定；**约 5 次调用**（今日/近7/近30 + 逐日曲线 UV/PV）。
 *
 *   `--mode=byPoi`：旧的逐店模式（136 次调用 / ~97 秒），保留原因有两个：
 *     ① 口径对账要能复现（见下）；② 万一平台总口径接口变了还有退路。
 *     它写 `exposure-bypoi-<账号>.json`，**不覆盖**总口径那份。
 *
 * ⛔⛔ 为什么换掉逐店求和 —— 它是**另一个口径**（实测，别忘）
 *   同一天 2026-09-21 对照（`src/probe-exposure-caliber.mjs`）：
 *     平台 PV（曝光次数）= 18,280     平台 UV（曝光人数）= 5,838
 *     逐店 Σ poiExposureTimes = 2,526（119/136 家有值）
 *   → **两边都对不上**（差 -15,754 / -3,312）。逐店的 `flowPoiExposureRankingV2`
 *     是「门店**排行**」接口，度量更小（大概只含达标门店）。
 *   所以旧看板上的「大盘曝光」一直**低估约 7 倍**；换总口径同时也是一次口径修正。
 *
 * ⛔⛔ 平台接口的两个坑（都实测踩过，别踩第二遍）
 *   1. **多日窗口第一次必返回 `code=100 数据处理中请耐心等待。`** → 重试一次就出数。
 *   2. **`recentDays=1` 忽略 `beginTime`/`endTime`，永远给"最新一天"。**
 *      连取 7 个不同单日会返回**同一个值** → 「逐日取再求和」会得到 7× 虚高。
 *      **必须**用 `recentDays=N` 一次取窗口。
 *
 * 落盘 data/raw/exposure-<account>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = acct.port;
const MODE = arg("mode", "total");
const DAYS = Number(arg("days", "7"));
const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const OUT = dataPath(acct, MODE === "byPoi" ? "exposure-bypoi" : "exposure");

const FLOW_PAGE = "https://yiyao.meituan.com/main/frame#/page/recoanalysis/pc#traffic";
const TRANSFORM = "/api/page/recoanalysis/flowAnalysisV5/recentDays/flowTransformation";
const CHART = "/api/page/recoanalysis/flowAnalysisV5/recentDays/flowTransformationChart";
const POI_RANK = "/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (off) => { const t = new Date(Date.now() + off * 86400_000); return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`; };

const cdp = await connectToPage(PORT);
console.log(`账号 ${acct.label}  端口 ${PORT}  模式 ${MODE}`);
const { cookies: CK } = await loadCookieSmart({
  stem: STEM, port: PORT, host: "yiyao.meituan.com", required: ["token", "acctId"],
});
const ACCT_ID = String(CK.acctId ?? "");

await cdp.send("Page.navigate", { url: FLOW_PAGE });
const ready = await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", {
  timeoutMs: 90_000,
  label: `美团医药商家端（${acct.label}）`,
});
console.log(`🔏 签名链路就绪（${ready.waitedMs}ms，已停在流量分析页）`);

/* ════════════════════ 模式一：平台总口径 ════════════════════ */
async function fetchTotal() {
  const out = await evaluate(
    cdp,
    `(async () => {
       const qs = (o) => new URLSearchParams(o).toString();
       const sleep = (ms) => new Promise(r => setTimeout(r, ms));
       /* 日期必须在页内算：写成 \${ymd(-days)} 会被 Node 的模板字符串提前求值，
          而 days 是页内变量 → ReferenceError: days is not defined（踩过）。 */
       const pad = (n) => String(n).padStart(2, '0');
       const ymd = (off) => { const t = new Date(Date.now() + off * 86400000); return '' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()); };

       /**
        * flowTransformation 多日窗口首次返回 code=100（平台按需计算），必须重试。
        * 实测：7 天/30 天第 1 次 code=100，第 2 次（约 4s 后）code=0。
        */
       const callWindow = async (days) => {
         for (let attempt = 1; attempt <= 5; attempt++) {
           const url = '${TRANSFORM}?' + qs({
             ignoreSetRouterProxy: 'true', acctId: '${ACCT_ID}', cityIds: '0', source: '0', wmPoiId: '-1',
             beginTime: ymd(0), endTime: ymd(0), recentDays: String(days),
             compareBeginTime: ymd(-days), compareEndTime: ymd(-days),
           });
           const r = await fetch(url, { credentials: 'include' });
           const j = await r.json().catch(() => null);
           if (j && j.code === 0) {
             const arr = Array.isArray(j.data) ? j.data : [];
             const g = (idx) => { const o = arr.find(x => x.index === idx); return o ?? null; };
             return { days, attempt, uv: g('FLOW_POI_EXPOSE_UV'), pv: g('FLOW_POI_EXPOSE_PV') };
           }
           if (attempt < 5) await sleep(4000);
         }
         return { days, attempt: 5, failed: true, uv: null, pv: null };
       };

      /** 逐日曲线：同样要重试 */
      const callChart = async (index, days) => {
        for (let attempt = 1; attempt <= 5; attempt++) {
          const url = '${CHART}?' + qs({
            ignoreSetRouterProxy: 'true', cityIds: '0', index,
            beginTime: ymd(0), endTime: ymd(0), recentDays: String(days),
            compareBeginTime: ymd(-days), compareEndTime: ymd(-days),
          });
          const r = await fetch(url, { credentials: 'include' });
          const j = await r.json().catch(() => null);
          if (j && j.code === 0) return { index, days, attempt, data: j.data ?? null };
          if (attempt < 5) await sleep(4000);
        }
        return { index, days, attempt: 5, failed: true, data: null };
      };

      /**
       * ⭐ R14（2026-09-24）：5 路调用改**并行**（Promise.all）。
       *   原先串行：每个多日窗口首查必 code=100，sleep 4s 重试 → 等待时间逐个叠加，
       *   实测单账号 ~26s。并行后 4s 重试等待重叠（A/B 实测：接口段 26.1s → 8.3s，
       *   attempts=[2,3,3,1,1]，无串行惩罚、无限流）。返回结构不变。
       */
      const windows = {};
      const [winToday, winD7, winD30, chartUv, chartPv] = await Promise.all([
        callWindow(1), callWindow(7), callWindow(30),
        callChart('FLOW_POI_EXPOSE_UV', 30), callChart('FLOW_POI_EXPOSE_PV', 30),
      ]);
      windows.today = winToday; windows.d7 = winD7; windows.d30 = winD30;

      return { windows, chartUv, chartPv };
    })()`,
    { timeoutMs: 240_000 },
  );
  return out;
}

/* ════════════════════ 模式二：逐店（保留） ════════════════════ */
async function fetchByPoi() {
  const mf = join(ROOT, "data", "raw", `${STEM}.json`);
  const { readFileSync } = await import("node:fs");
  const stores = (JSON.parse(readFileSync(mf, "utf8")).stores ?? []).map((s) => ({ id: String(s.id), name: s.name, city: s.cityName ?? s.city }));
  const begin = ymd(-DAYS).slice(2);
  const end = ymd(-1).slice(2);
  console.log(`窗口：近 ${DAYS} 天（${begin} ~ ${end}），逐店取曝光，共 ${stores.length} 家`);
  const ids = stores.map((s) => s.id);
  const rows = {};
  const BATCH = Number(arg("batch", "25"));
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    process.stdout.write(`\r  取曝光 ${i + chunk.length}/${ids.length} 家…   `);
    const result = await evaluate(
      cdp,
      `(async () => {
         const ids = ${JSON.stringify(chunk)};
         const out = {};
         const sleep = (ms) => new Promise(r => setTimeout(r, ms));
         for (const pid of ids) {
           try {
             const r = await fetch('${POI_RANK}?acctId=${ACCT_ID}&beginTime=${begin}&endTime=${end}&recentDays=${DAYS}'
               + '&wmPoiId=' + pid + '&cityIds=0&source=0&type=2', { credentials: 'include' });
             const j = await r.json();
             const d = j.data;
             out[pid] = d ? {
               exposure: d.poiExposureTimes ?? null, dataDate: d.dataDate ?? null,
               cityName: d.cityName ?? null, avgRanking: d.weightedAvgRanking?.current ?? null,
             } : null;
           } catch (e) { out[pid] = { error: String(e && e.message) }; }
           await sleep(60);
         }
         return out;
       })()`,
      { timeoutMs: 180_000 },
    );
    Object.assign(rows, result);
  }
  process.stdout.write("\r" + " ".repeat(44) + "\r");

  const withData = Object.entries(rows).filter(([, v]) => v && v.exposure !== undefined && v.exposure !== null);
  const nulls = Object.entries(rows).filter(([, v]) => v === null);
  const totalExposure = withData.reduce((s, [, v]) => s + (Number(v.exposure) || 0), 0);
  console.log(`  有数据门店 ${withData.length} 家   返回 null ${nulls.length} 家`);
  console.log(`  Σ门店曝光次数 ${totalExposure.toLocaleString("zh-CN")}`);

  const nameOf = new Map(stores.map((s) => [s.id, s.name]));
  return {
    mode: "byPoi",
    window: { days: DAYS, begin, end },
    withData: withData.length,
    nullCount: nulls.length,
    totalExposure,
    stores: stores.map((s) => {
      const v = rows[s.id];
      return { id: s.id, name: s.name, city: v?.cityName ?? s.city ?? "", exposure: v?.exposure ?? null, avgRanking: v?.avgRanking ?? null };
    }),
    raw: rows,
  };
}

if (MODE === "byPoi") {
  const r = await fetchByPoi();
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), account: { key: acct.key, label: acct.label }, source: "flowPoiExposureRankingV2-byPoi", caliber: "逐店求和（排行接口，与平台总口径不同，仅用于对账）", ...r }, null, 2), "utf8");
  console.log(`\n落盘 ${OUT}`);
} else {
  const r = await fetchTotal();
  for (const [k, w] of Object.entries(r.windows)) {
    console.log(`  ${k.padEnd(6)} days=${String(w.days).padStart(2)} 第${w.attempt}次  UV=${w.uv?.current ?? "—"}  PV=${w.pv?.current ?? "—"}${w.failed ? "  ⛔失败" : ""}`);
  }
  console.log(`  逐日曲线 UV 第${r.chartUv.attempt}次 ${r.chartUv.data ? "有数据" : "⛔失败"}；PV 第${r.chartPv.attempt}次 ${r.chartPv.data ? "有数据" : "⛔失败"}`);

  const mk = (w) => (w && !w.failed ? {
    days: w.days,
    uv: w.uv?.current ?? null, pv: w.pv?.current ?? null,
    ringUv: w.uv?.ring ?? null, ringPv: w.pv?.ring ?? null,
    ringRateUv: w.uv?.ringRate ?? null, ringRatePv: w.pv?.ringRate ?? null,
    day: toLocalDate(w.uv?.date ?? w.pv?.date) ?? null,
  } : null);

  /**
   * 逐日曲线：真实结构是 `data.chart = { index, indexEnum, current[], ring[], date[], compareWithRing[] }`。
   * （我第一版瞎猜成 {axis,dataValue} / {dateList,valueList}，结果 daily 恒为空 —— 已实测校正。）
   *
   * ⚠️ `date[]` 是 **UTC 16:00 的 ISO**（`2026-08-22T16:00:00.000+0000`），
   *    +8h 才是北京时间，即**次日** 00:00 —— 最后一个点是今天，不是昨天。
   *    不做这步换算，整条曲线会整体错一天。
   * `ring[i]` 就是 `current[i-1]`（环比=上一日），所以可直接当对比基准。
   */
  const toLocalDate = (s) => {
    const t = new Date(s);
    if (Number.isNaN(t.getTime())) return null;
    const bj = new Date(t.getTime() + 8 * 3600_000);
    return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`;
  };
  const normSeries = (c) => {
    const ch = c?.data?.chart;
    if (!ch || !Array.isArray(ch.date)) return [];
    return ch.date
      .map((s, i) => ({
        date: toLocalDate(s),
        value: Number(ch.current?.[i] ?? 0),
        ring: ch.ring?.[i] === undefined || ch.ring?.[i] === null ? null : Number(ch.ring[i]),
      }))
      .filter((p) => p.date);
  };
  const uvSeries = normSeries(r.chartUv);
  const pvSeries = normSeries(r.chartPv);
  const byDate = new Map();
  for (const p of uvSeries) byDate.set(p.date, { date: p.date, uv: p.value, ringUv: p.ring, pv: null, ringPv: null });
  for (const p of pvSeries) {
    const cur = byDate.get(p.date) ?? { date: p.date, uv: null, ringUv: null, pv: null, ringPv: null };
    cur.pv = p.value;
    cur.ringPv = p.ring;
    byDate.set(p.date, cur);
  }
  const daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const okAny = Object.values(r.windows).some((w) => w && !w.failed) || daily.length > 0;
  if (!okAny) {
    console.error(`\n⛔ 所有窗口都失败，**不覆盖** ${OUT}`);
    await cdp.close();
    process.exit(2);
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    account: { key: acct.key, label: acct.label },
    source: "platform-total",
    caliber:
      "平台总口径：flowAnalysisV5/recentDays/flowTransformation 的 FLOW_POI_EXPOSE_UV(曝光人数)/FLOW_POI_EXPOSE_PV(曝光次数)；" +
      "窗口由 recentDays 决定（含今天）。⛔ 旧的逐店求和（flowPoiExposureRankingV2）与它口径不同" +
      "（同日实测 2526 vs 18280），已弃用，仅保留在 --mode=byPoi 供对账。",
    windows: {
      today: mk(r.windows.today),
      d7: mk(r.windows.d7),
      d30: mk(r.windows.d30),
    },
    daily,
    dailyCaliber: "逐日曲线来自 flowTransformationChart（index=FLOW_POI_EXPOSE_UV / _PV），近 30 天。",
    rawCharts: { uv: r.chartUv, pv: r.chartPv },
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\n落盘 ${OUT}`);
}

await cdp.close();
