/**
 * 美团经营首页「窗口」计算的纯函数层。
 *
 * 为什么单独成文件：这些是最容易写错、也最容易测的部分（日期边界、量纲、字段包装），
 * 而它们**完全不需要浏览器**。放到纯函数里就能用离线单元测试钉死，
 * 免得每次都要连着商家端跑一遍才发现差一天。
 *
 * ⭐ 口径（2026-09-21 实测标定，见 reference/meituan-yiyao-api.md §3.11）：
 *   · `dateType=last_7_days` / `last_30_days` 的区间是 **截止昨天，不含今天**
 *     近7天  → begin = 昨天-6，end = 昨天
 *     近30天 → begin = 昨天-29，end = 昨天
 *   · `compareBeginTime`/`compareEndTime` **必填**，取「往前再推一个等长窗口」
 *   · 平台的指标值是**包装对象**，真值在 amount / turnover / averagePrice 里
 *   · `fixTimeChart` 的 axis 是 `YYYYMMDD`（无横线）
 */
import { test as nodeTest } from "node:test";

/* ───────────────────────── 日期 ───────────────────────── */

const pad = (n) => String(n).padStart(2, "0");

/** Date → `YYYYMMDD`（经营首页用它） */
export function ymd(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Date → `YYYY-MM-DD`（订单列表用它） */
export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 本地时区的「今天」。
 * ⛔ 绝不要用 toISOString() —— 它按 UTC 算，东八区晚 8 点后会跳天。
 */
export function today(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 在某天基础上加减天数（走本地日历，避开夏令时/UTC 偏移） */
export function shift(base, days) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/** `YYYYMMDD` → Date；非法返回 null */
export function parseYmd(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `YYYYMMDD` → `YYYY-MM-DD`（解析不了就原样返回） */
export function ymdToIso(s) {
  const d = parseYmd(s);
  return d ? isoDate(d) : String(s ?? "");
}

/**
 * 「近 N 天」窗口 —— **截止昨天，不含今天**。
 *
 * @param {number} n
 * @param {Date} [now]
 * @returns {{dateType:string, beginTime:string, endTime:string,
 *            compareBeginTime:string, compareEndTime:string,
 *            isoBegin:string, isoEnd:string, days:string[], n:number}}
 */
export function lastNDays(n, now = new Date()) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`lastNDays: n 必须是正整数，收到 ${n}`);
  const t = today(now);
  const end = shift(t, -1);              // 昨天
  const begin = shift(end, -(n - 1));    // 往前 n-1 天
  const cmpEnd = shift(begin, -1);       // 对比窗口：紧邻在前的等长窗口
  const cmpBegin = shift(cmpEnd, -(n - 1));

  const days = [];
  for (let i = 0; i < n; i++) days.push(ymd(shift(begin, i)));

  return {
    n,
    dateType: `last_${n}_days`,
    beginTime: ymd(begin),
    endTime: ymd(end),
    compareBeginTime: ymd(cmpBegin),
    compareEndTime: ymd(cmpEnd),
    isoBegin: isoDate(begin),
    isoEnd: isoDate(end),
    days,
  };
}

/** 今天 / 昨天（订单页与今日汇总用 `YYYY-MM-DD`） */
export function dayWindows(now = new Date()) {
  const t = today(now), y = shift(t, -1);
  return {
    today: { iso: isoDate(t), ymd: ymd(t) },
    yesterday: { iso: isoDate(y), ymd: ymd(y) },
  };
}

/* ───────────────────── 响应解析 ───────────────────── */

/**
 * 平台指标的**包装对象**取值。
 *   {amount:"117947.25"} / {turnover:"6469"} / {averagePrice:26.55} → 数值
 * 纯数值原样返回；null/undefined → null。
 */
export function unwrapMetric(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v !== "object") return null;
  for (const k of ["amount", "turnover", "averagePrice", "value", "count", "num"]) {
    if (k in v) {
      const n = Number(v[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** 取包装对象的环比字符串（`-14.73%`），没有则 null */
export function cycleOf(v) {
  if (v && typeof v === "object" && typeof v.relativeCycle === "string") return v.relativeCycle;
  return null;
}

/**
 * `manageHome/multi/o/core` → 窗口汇总。
 * @returns {{projectedIncome:number|null, dealAmount:number|null, transactionVolume:number|null,
 *            avgPrice:number|null, merchantSubsidy:number|null, refundAmount:number|null,
 *            refundOrderQuantity:number|null, allRefundOrderQuantity:number|null,
 *            deliveryFee:number|null, storeProjectedIncome:number|null,
 *            cycles:Object, raw:Object}}
 */
export function parseCore(data) {
  const g = (k) => data?.[k];
  return {
    projectedIncome: unwrapMetric(g("multiProjectedIncome")),
    dealAmount: unwrapMetric(g("multiDealAmount")),
    transactionVolume: unwrapMetric(g("multiTransactionVolume")),
    avgPrice: unwrapMetric(g("multiSingleAveragePrice")),
    merchantSubsidy: unwrapMetric(g("multiMerchantSubsidyAmount")),
    refundAmount: unwrapMetric(g("multiRefundAmount")),
    refundOrderQuantity: unwrapMetric(g("multiRefundOrderQuantity")),
    allRefundOrderQuantity: unwrapMetric(g("multiAllRefundOrderQuantity")),
    deliveryFee: unwrapMetric(g("multiUserDeliveryFee")),
    storeProjectedIncome: unwrapMetric(g("multiStoreProjectedIncome")),
    storeAvgDealAmount: unwrapMetric(g("multiStoreAverageDealAmount")),
    cycles: {
      projectedIncome: cycleOf(g("multiProjectedIncome")),
      dealAmount: cycleOf(g("multiDealAmount")),
      transactionVolume: cycleOf(g("multiTransactionVolume")),
      avgPrice: cycleOf(g("multiSingleAveragePrice")),
    },
    raw: data ?? null,
  };
}

/** `flow/module` → 曝光与转化 */
export function parseFlowModule(data) {
  return {
    exposureNumber: unwrapMetric(data?.exposureNumber),
    storeNumber: unwrapMetric(data?.storeNumber),
    orderNumber: unwrapMetric(data?.orderNumber),
    storeConversionRate: unwrapMetric(data?.multiStoreConversionRate),
    orderConversionRate: unwrapMetric(data?.multiOrderConversionRate),
  };
}

/**
 * `fixTimeChart` → 逐日序列。
 * 形如 `{multiProjectedIncome:[{axis:"20260822",dataValue:"5041.89"}, ...]}`
 *
 * ⛔ `dataValue` 是**字符串**；直接相加会变成字符串拼接（经典坑）。
 */
export function parseFixTimeChart(data) {
  const series = (arr) => {
    const out = [];
    for (const it of arr ?? []) {
      if (!it || it.axis == null) continue;
      const v = Number(it.dataValue);
      out.push({ ymd: String(it.axis).replace(/-/g, ""), value: Number.isFinite(v) ? v : null });
    }
    return out;
  };
  return {
    projectedIncome: series(data?.multiProjectedIncome),
    dealAmount: series(data?.multiDealAmount),
    transactionVolume: series(data?.multiTransactionVolume),
    avgPrice: series(data?.multiSingleAveragePrice),
    merchantSubsidy: series(data?.multiMerchantSubsidyAmount),
    refundAmount: series(data?.multiRefundAmount),
  };
}

/**
 * 把逐日序列按日期拼成逐日记录。
 * 金额保留 2 位；不存在的那天不硬造。
 */
export function mergeDaily({ income = [], deal = [], volume = [], avgPrice = [] }) {
  const byDay = new Map();
  const touch = (ymdStr) => {
    if (!byDay.has(ymdStr)) {
      byDay.set(ymdStr, {
        ymd: ymdStr, date: ymdToIso(ymdStr),
        projectedIncome: null, dealAmount: null, validOrderCount: null, avgOrderValue: null,
      });
    }
    return byDay.get(ymdStr);
  };
  for (const x of income) touch(x.ymd).projectedIncome = x.value;
  for (const x of deal) touch(x.ymd).dealAmount = x.value;
  for (const x of volume) touch(x.ymd).validOrderCount = x.value;
  for (const x of avgPrice) touch(x.ymd).avgOrderValue = x.value;
  return [...byDay.values()].sort((a, b) => a.ymd.localeCompare(b.ymd));
}
