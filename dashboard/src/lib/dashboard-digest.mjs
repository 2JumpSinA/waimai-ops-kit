/**
 * 看板产物的**规范化摘要**（机器对比的唯一基准）。
 *
 * 目的：结构优化必须能证明「对外表现与派生口径逐项没变」。
 *   肉眼比对不可信，所以要能把任意一份 dashboard.html 折算成**确定性**的 JSON：
 *     · 键递归按键名排序 → 同样的语义产出同样的字节
 *     · 易变字段（`generatedAt`）被替换成哨兵值，不参与比较
 *     · 数值统一保留 6 位小数，规避浮点尾差的假差异
 *
 * 两级摘要：
 *   `vmDigest(vm)`      —— 整份 VM 的规范化（数据契约级对比）
 *   `derivedDigest(vm)` —— 只留"看板真正渲染/派生"的字段（表现级对比），体积小、可读
 *
 * 本文件不碰文件系统、不碰浏览器。
 */
import { createHash } from "node:crypto";
import { extractScripts, extractAppJs, extractEchartsJs, extractVmBlock, checkSelfContainedStructure } from "./dashboard-html.mjs";

/** 递归按键名排序；数组顺序是语义，保持不动。 */
export function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  return v;
}

/** 稳定 JSON 序列化：canonicalize + 2 空格缩进 + 结尾换行。 */
export function stableJson(v) {
  return JSON.stringify(canonicalize(v), null, 2) + "\n";
}

/** 数值统一到 6 位小数，规避浮点尾差造成的假差异。 */
export const round6 = (x) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(6)) : x);

/** 递归把数值收敛到 6 位小数（哈希必须在收敛之后算，否则浮点尾差制造假差异）。 */
export const round6Deep = (v) => {
  if (Array.isArray(v)) return v.map(round6Deep);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = round6Deep(v[k]);
    return o;
  }
  return round6(v);
};

/**
 * 整个数组的内容哈希（16 位）。
 *
 * 为什么需要：摘要里对数组只留「条数 + 首行样例」时，任何**只影响第 2..N 行**的变化
 * （排序稳定性、某一类门店、部分行被误乘 100）在对比里都不可见。
 * 全量哈希把「抽样等价」升级成「全量等价」。
 */
export const hashOf = (arr) =>
  createHash("sha256").update(JSON.stringify(round6Deep(arr ?? []))).digest("hex").slice(0, 16);

/** 易变字段：这些不参与等价比较（每次构建都不同，与结构无关）。 */
export const VOLATILE_VM_KEYS = ["generatedAt"];

/** 整份 VM 的规范化摘要。 */
export function vmDigest(vm) {
  const copy = { ...vm };
  for (const k of VOLATILE_VM_KEYS) if (k in copy) copy[k] = "<volatile>";
  return canonicalize(copy);
}

// ════════════════════════════════════════════════════════════════════
// 派生值摘要 —— 「看板渲染字段」的机器可读投影
// ════════════════════════════════════════════════════════════════════

const WIN_KEYS = ["today", "yesterday", "d7", "d30"];

const pick = (o, keys) => {
  const out = {};
  for (const k of keys) out[k] = o?.[k] ?? null;
  return out;
};

function windowView(x) {
  if (!x) return null;
  return {
    label: x.label ?? null,
    projectedIncome: round6(x.projectedIncome ?? null),
    orderCount: x.orderCount ?? null,
    validOrderCount: x.validOrderCount ?? null,
    cancelCount: x.cancelCount ?? null,
    cancelRate: round6(x.cancelRate ?? null),
    avgOrderValue: round6(x.avgOrderValue ?? null),
    projectedIncomeSource: x.projectedIncomeSource ?? null,
    promoCost: round6(x.promoCost ?? null),
    promoShow: x.promoShow ?? null,
    promoClick: x.promoClick ?? null,
    promoRoi: round6(x.promoRoi ?? null),
    promoClickRate: round6(x.promoClickRate ?? null),
    promoUnavailable: x.promoUnavailable ?? null,
    promoNote: x.promoNote ?? null,
    promoRatio: round6(x.promoRatio ?? null),
    // ★ 2026-09-22：今日改用推广首页**实时**口径（报表 T+1 的补救）
    promoLive: x.promoLive ?? null,
    promoBudget: round6(x.promoBudget ?? null),
    promoCostRate: round6(x.promoCostRate ?? null),
    promoChainRatio: round6(x.promoChainRatio ?? null),
    promoRoiNote: x.promoRoiNote ?? null,
  };
}

function incomeWindowView(x) {
  if (!x) return null;
  return {
    label: x.label ?? null,
    start: x.start ?? null,
    end: x.end ?? null,
    orderCount: x.orderCount ?? null,
    validOrderCount: x.validOrderCount ?? null,
    cancelCount: x.cancelCount ?? null,
    cancelRate: round6(x.cancelRate ?? null),
    projectedIncome: round6(x.projectedIncome ?? null),
    cancelIncome: round6(x.cancelIncome ?? null),
    avgOrderValue: round6(x.avgOrderValue ?? null),
    source: x.source ?? null,
  };
}

const sample = (arr, n = 1) => (Array.isArray(arr) ? arr.slice(0, n) : []);

/**
 * 派生值摘要：只保留看板真正读/算的字段。
 * ⚠️ 新增字段要慎重 —— 它会被当成「表现契约」纳入等价比较。
 */
export function derivedDigest(vm) {
  const out = { projectOrder: vm.projectOrder ?? null, projects: {}, notes: vm.notes ?? [] };
  for (const k of vm.projectOrder ?? Object.keys(vm.projects ?? {})) {
    const p = vm.projects?.[k];
    if (!p) continue;
    const inc = p.income ?? {};
    const expo = p.exposure ?? {};
    const ed = expo.daily ?? [];
    const last = ed[ed.length - 1] ?? null;

    out.projects[k] = {
      label: p.label ?? null,
      fullLabel: p.fullLabel ?? null,
      dataTime: p.dataTime ?? null,
      acctId: p.acctId ?? null,
      warnings: p.warnings ?? [],
      income: {
        source: inc.source ?? null,
        caliber: inc.caliber ?? null,
        selfCheck: inc.selfCheck ?? null,
        officialToday: inc.officialToday ?? null,
        dailyDays: (inc.daily ?? []).length,
        dailyFirst: inc.daily?.[0] ?? null,
        dailyLast: lastDaily(inc.daily),
        /** ★ 全量内容哈希：只留首末行会让「中间某天被改坏」逃过对比 */
        dailyHash: hashOf(inc.daily),
        byPoiD7Count: (inc.byPoiD7 ?? []).length,
        byPoiD30Count: (inc.byPoiD30 ?? []).length,
        byPoiD7Sample: sample(inc.byPoiD7),
        byPoiD7Hash: hashOf(inc.byPoiD7),
        byPoiD30Hash: hashOf(inc.byPoiD30),
        crossCheck: inc.crossCheck ?? null,
        crossCheckHash: hashOf(inc.crossCheck),
        windows: Object.fromEntries(WIN_KEYS.map((w) => [w, incomeWindowView(inc.windows?.[w])])),
      },
      ka: {
        windows: Object.fromEntries(
          Object.entries(p.ka?.windows ?? {}).map(([a, b]) => [
            a,
            {
              label: b.label ?? null,
              cost: round6(b.cost ?? null),
              showCount: b.showCount ?? null,
              clickCount: b.clickCount ?? null,
              roi: round6(b.roi ?? null),
              clickRate: round6(b.clickRate ?? null),
              cpc: round6(b.cpc ?? null),
              cpm: round6(b.cpm ?? null),
              convertOrderAmount: round6(b.convertOrderAmount ?? null),
            },
          ]),
        ),
        dailyCount: (p.ka?.daily ?? []).length,
        dailyHash: hashOf(p.ka?.daily),
        // ★ 2026-09-22 新增：近 30 天逐日（供看板「近30天」窗口的推广图）
        daily30Count: (p.ka?.daily30 ?? []).length,
        daily30Hash: hashOf(p.ka?.daily30),
        /**
         * ★ 2026-09-22 新增：推广首页**实时**（今日口径）。
         *   含 `hourly` / `hourlyYesterday` 分时曲线 —— 「今日/昨日」窗口据此画**真小时**图。
         */
        realtime: p.ka?.realtime
          ? {
              source: p.ka.realtime.source ?? null,
              delayMin: p.ka.realtime.delayMin ?? null,
              cost: round6(p.ka.realtime.cost ?? null),
              budget: round6(p.ka.realtime.budget ?? null),
              costRate: round6(p.ka.realtime.costRate ?? null),
              chainRatio: round6(p.ka.realtime.chainRatio ?? null),
              showCount: p.ka.realtime.showCount ?? null,
              clickCount: p.ka.realtime.clickCount ?? null,
              ecpm: round6(p.ka.realtime.ecpm ?? null),
              cpc: round6(p.ka.realtime.cpc ?? null),
              spreadingPoiNum: p.ka.realtime.spreadingPoiNum ?? null,
              costPoiNum: p.ka.realtime.costPoiNum ?? null,
              balance: round6(p.ka.realtime.balance ?? null),
              hourlyCount: (p.ka.realtime.hourly ?? []).length,
              hourlyHash: hashOf(p.ka.realtime.hourly),
              hourlyYesterdayCount: (p.ka.realtime.hourlyYesterday ?? []).length,
              hourlyYesterdayHash: hashOf(p.ka.realtime.hourlyYesterday),
            }
          : null,
        byProduct: (p.ka?.byProduct ?? []).map((x) => ({
          name: x.name ?? null,
          cost: round6(x.cost ?? null),
          showCount: x.showCount ?? null,
          roi: round6(x.roi ?? null),
          convertOrderAmount: round6(x.convertOrderAmount ?? null),
        })),
        byProductHash: hashOf(p.ka?.byProduct),
      },
      exposure: expo.windows
        ? {
            source: expo.source ?? null,
            fetchedAt: "<volatile>",
            dailyCaliber: expo.dailyCaliber ?? null,
            windows: Object.fromEntries(
              Object.entries(expo.windows).map(([a, b]) => [
                a,
                {
                  days: b.days ?? null,
                  uv: b.uv ?? null,
                  pv: b.pv ?? null,
                  ringUv: round6(b.ringUv ?? null),
                  ringPv: round6(b.ringPv ?? null),
                  ringRateUv: round6(b.ringRateUv ?? null),
                  ringRatePv: round6(b.ringRatePv ?? null),
                  day: b.day ?? null,
                },
              ]),
            ),
            dailyCount: ed.length,
            dailyLast: last,
            dailyHash: hashOf(ed),
            // ★ 关键不变量：曝光曲线末点必须等于「最新日」窗口值
            invariantLastEqualsWindow:
              !!last && !!expo.windows.today && last.uv === expo.windows.today.uv && last.pv === expo.windows.today.pv,
          }
        : null,
      today: p.today
        ? {
            date: p.today.date ?? null,
            totals: p.today.totals ?? null,
            recentHour: p.today.recentHour ?? null,
            recent3Hour: p.today.recent3Hour ?? null,
            hourlyCount: (p.today.hourly ?? []).length,
            hourlyHash: hashOf(p.today.hourly),
            // ★ 2026-09-22 新增：昨日逐小时（供看板「昨日」窗口；来源与今日同为逐单分桶）
            dateYesterday: p.today.dateYesterday ?? null,
            hourlyYesterdayCount: (p.today.hourlyYesterday ?? []).length,
            hourlyYesterdayHash: hashOf(p.today.hourlyYesterday),
            yesterdayTotals: p.today.yesterdayTotals ?? null,
            caliberYesterday: p.today.caliberYesterday ?? null,
            poiRankCount: (p.today.poiRank ?? []).length,
            poiRankHash: hashOf(p.today.poiRank),
            caliber: p.today.caliber ?? null,
          }
        : null,
      taobao: p.taobao
        ? {
            storeCount: p.taobao.storeCount ?? null,
            cityDist: p.taobao.cityDist ?? null,
            cityDistHash: hashOf(Object.entries(p.taobao.cityDist ?? {}).map(([k, v]) => [k, v])),
            storeCountDetail: p.taobao.storeCountDetail ?? null,
            detailWindow: p.taobao.detailWindow ?? null,
            kpi: p.taobao.kpi ?? null,
            /** ★ 2026-09-22：闪购近 7 天窗口聚合（平台维度的闪购视图靠它，唯一带时间含义的闪购数字） */
            kpiView: p.taobao.kpiView ?? null,
            /**
             * ★ 2026-09-22：闪购**营业统计**（今日/昨日详情 + 分时 + 逐日 + 窗口）——
             *   「平台切换器 → 闪购」视图的数据源，来自 fetch-taobao-stats.mjs。
             */
            series: p.taobao.series
              ? {
                  source: p.taobao.series.source ?? null,                  ds: p.taobao.series.ds ?? null,
                  today: p.taobao.series.today ?? null,
                  yesterday: p.taobao.series.yesterday ?? null,
                  hourlyTodayCount: (p.taobao.series.hourlyToday ?? []).length,
                  hourlyTodayHash: hashOf(p.taobao.series.hourlyToday),
                  hourlyYesterdayCount: (p.taobao.series.hourlyYesterday ?? []).length,
                  hourlyYesterdayHash: hashOf(p.taobao.series.hourlyYesterday),
                  /** ★ 多指标分时（含**流失订单**）+ 曝光（单日/分时/窗口/来源/逐日） */
                  hourlyByFieldHash: hashOf(p.taobao.series.hourlyByField),
                  exposureHash: hashOf(p.taobao.series.exposure),
                  dailyHash: hashOf(p.taobao.series.daily),
                  dailyGmvCount: (p.taobao.series.daily?.gmv ?? []).length,
                  windows: p.taobao.series.windows ?? null,
                  caliber: p.taobao.series.caliber ?? null,
                }
              : null,
            /**
             * ★★ 2026-09-22：闪购 **② 族（MDA 门户）** —— **两个账号共用一条通路**。
             *   protein 族（①）只有品牌A能用；品牌B此前「整族失败」其实是走错了族。
             *   营业（窗口/逐日/分时）两账号都走这里；曝光（流量）② 只有品牌B能用。
             */
            mda: p.taobao.mda
              ? {
                  source: p.taobao.mda.source ?? null,
                  family: p.taobao.mda.family ?? null,
                  ds: p.taobao.mda.ds ?? null,
                  windowsHash: hashOf(p.taobao.mda.windows),
                  dailyHash: hashOf(p.taobao.mda.daily),
                  hourlyHash: hashOf(p.taobao.mda.hourly),
                  flowWindowsHash: hashOf(p.taobao.mda.flowWindows),
                  flowDailyHash: hashOf(p.taobao.mda.flowDaily),
                }
              : null,
            /**
             * ★ 2026-09-23：闪购**推广**（斗金 BP 通路）—— 闪购视图推广板块的数据源。
             *   USER_DATE 全站推广口径（102301117）逐日 + 窗口汇总 + 今日实时/分时 + 余额。
             */
            promo: p.taobao.promo
              ? {
                  source: p.taobao.promo.source ?? null,
                  fetchedAt: "<volatile>",
                  balance: round6(p.taobao.promo.balance ?? null),
                  dailyCount: (p.taobao.promo.daily ?? []).length,
                  dailyHash: hashOf(p.taobao.promo.daily),
                  windows: Object.fromEntries(
                    Object.entries(p.taobao.promo.windows ?? {}).map(([a, b]) => [
                      a,
                      b
                        ? {
                            cost: round6(b.cost ?? null),
                            impression: b.impression ?? null,
                            click: b.click ?? null,
                            orderNum: b.orderNum ?? null,
                            orderGrossGmv1d: round6(b.orderGrossGmv1d ?? null),
                            roi: round6(b.roi ?? null),
                            days: b.days ?? null,
                          }
                        : null,
                    ]),
                  ),
                  today: p.taobao.promo.today ?? null,
                  todayHourlyCount: (p.taobao.promo.todayHourly ?? []).length,
                  todayHourlyHash: hashOf(p.taobao.promo.todayHourly),
                  todayHourlyCost: round6(p.taobao.promo.todayHourlyCost ?? null),
                  plansHash: hashOf(p.taobao.promo.plans),
                }
              : null,
            storesCount: (p.taobao.stores ?? []).length,
            storesSample: sample(p.taobao.stores),
            storesHash: hashOf(p.taobao.stores),
          }
        : null,
      mtStoresCount: (p.mtStores ?? []).length,
      mtStoresSample: sample(p.mtStores),
      mtStoresHash: hashOf(p.mtStores),
      mtStatusDist: p.mtStatusDist ?? {},
      mtStatusDistHash: hashOf(Object.entries(p.mtStatusDist ?? {}).map(([k, v]) => [k, v])),
      storeChart: p.storeChart ?? [],
      storeChartHash: hashOf(p.storeChart),
      // ★ 门店表的数据源（D-1 修复点：模板原先读错字段名）
      unifiedRowsCount: (p.unifiedRows ?? []).length,
      unifiedRowsSample: sample(p.unifiedRows),
      unifiedRowsHash: hashOf(p.unifiedRows),
      unifiedRowsFieldNames: Object.keys(p.unifiedRows?.[0] ?? {}).sort(),
      plan: p.plan ?? null,
      anomaliesCount: (p.anomalies ?? []).length,
      anomaliesSample: sample(p.anomalies),
      anomaliesHash: hashOf(p.anomalies),
      highCancelD7Count: (p.highCancelD7 ?? []).length,
      highCancelD30Count: (p.highCancelD30 ?? []).length,
      highCancelD7Sample: sample(p.highCancelD7),
      highCancelD7Hash: hashOf(p.highCancelD7),
      highCancelD30Hash: hashOf(p.highCancelD30),
      windows: Object.fromEntries(WIN_KEYS.map((w) => [w, windowView(p.windows?.[w])])),
      // ⭐ R21（2026-09-24）：「全部平台」KPI 合计卡的数据层（字段与 windows 同构，口径见 dashboard-model R21）
      kpiAll: Object.fromEntries(WIN_KEYS.map((w) => [w, windowView(p.kpiAll?.[w])])),
      // ⭐ R22（2026-09-24）：四个趋势板块「全部平台」合计序列（键名与渲染层读取路径一一对应）
      trendAll: p.trendAll ? {
        income: {
          hourly: {
            today: (p.trendAll.income?.hourly?.today ?? []).map((x) => ({ hour: x.hour, value: round6(x.value) })),
            yesterday: (p.trendAll.income?.hourly?.yesterday ?? []).map((x) => ({ hour: x.hour, value: round6(x.value) })),
          },
          daily: (p.trendAll.income?.daily ?? []).map((x) => ({ date: x.date, value: round6(x.value) })),
        },
        cancel: {
          hourly: {
            today: (p.trendAll.cancel?.hourly?.today ?? []).map((x) => ({ hour: x.hour, cancel: x.cancel, orders: x.orders })),
            yesterday: (p.trendAll.cancel?.hourly?.yesterday ?? []).map((x) => ({ hour: x.hour, cancel: x.cancel, orders: x.orders })),
          },
          daily: (p.trendAll.cancel?.daily ?? []).map((x) => ({ date: x.date, cancel: x.cancel, orders: x.orders })),
        },
        promo: {
          daily: (p.trendAll.promo?.daily ?? []).map((x) => ({ date: x.date, cost: round6(x.cost), income: round6(x.income) })),
          hourly: {
            today: (p.trendAll.promo?.hourly?.today ?? []).map((x) => ({ hour: x.hour, cost: round6(x.cost), income: round6(x.income) })),
            yesterday: (p.trendAll.promo?.hourly?.yesterday ?? []).map((x) => ({ hour: x.hour, cost: round6(x.cost), income: round6(x.income) })),
          },
        },
        expo: {
          daily: (p.trendAll.expo?.daily ?? []).map((x) => ({ date: x.date, uv: x.uv, pv: x.pv })),
          flow: p.trendAll.expo?.flow ? {
            d7: { uv: p.trendAll.expo.flow.d7?.uv ?? null, pv: p.trendAll.expo.flow.d7?.pv ?? null },
            d30: { uv: p.trendAll.expo.flow.d30?.uv ?? null, pv: p.trendAll.expo.flow.d30?.pv ?? null },
            lastUv: p.trendAll.expo.flow.lastUv ?? null,
          } : null,
        },
      } : null,
    };
  }
  out.notesCount = (vm.notes ?? []).length;
  out.notesHash = hashOf(vm.notes);
  return canonicalize(out);
}

function lastDaily(daily) {
  const a = daily ?? [];
  return a.length ? a[a.length - 1] : null;
}

// ════════════════════════════════════════════════════════════════════
// HTML → 摘要
// ════════════════════════════════════════════════════════════════════

/**
 * 一份 dashboard.html 的完整结构画像（供 parity/verify 打印与比较）。
 *
 * ⚠️ 对**模板源码**（`src/template/dashboard.html`）也能调用：那时 VM 位置是数据占位符，
 *    不是合法 JSON —— 此时 `hasVm=false`、`vm=null`，其它画像字段照常给出。
 *    这样 parity 才能同时吃"模板源码"和"构建产物"两种输入。
 */
export function htmlProfile(html) {
  const scripts = extractScripts(html);
  const appJs = extractAppJs(html);
  let vm = null, text = "", vmError = null;
  try {
    const b = extractVmBlock(appJs);
    vm = b.vm; text = b.text;
  } catch (e) {
    vmError = e.message;
  }
  return {
    bytes: Buffer.byteLength(html, "utf8"),
    lines: html.split("\n").length,
    scriptBlocks: scripts.length,
    echartsBytes: Buffer.byteLength(extractEchartsJs(html) ?? "", "utf8"),
    appJsBytes: Buffer.byteLength(appJs, "utf8"),
    appJsLines: appJs.split("\n").length,
    vmJsonChars: text.length,
    vmJsonBytes: Buffer.byteLength(text, "utf8"),
    hasVm: vm !== null,
    vmError,
    structure: checkSelfContainedStructure(html),
    vm,
  };
}
