/**
 * mt-window 纯函数的离线单元测试。
 *   node src/test-mt-window.mjs        直接跑
 *   node --test src/test-mt-window.mjs 用测试运行器
 *
 * 全是纯计算，不需要浏览器、不需要登录。
 */
import { test as nodeTest } from "node:test";
import {
  lastNDays, dayWindows, ymd, isoDate, today, shift, parseYmd, ymdToIso,
  unwrapMetric, cycleOf, parseCore, parseFlowModule, parseFixTimeChart, mergeDaily,
} from "./lib/mt-window.mjs";



const T = (name, fn) => nodeTest(name, fn);
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ?? "不相等"}\n  实际: ${A}\n  期望: ${B}`);
};

T("lastNDays: 近7天 / 近30天 截止昨天，对比窗口紧邻在前", () => {
  // 取一个固定「今天」，且跨月，能同时验月底与月内
  const now = new Date(2026, 8, 21); // 2026-09-21
  const d7 = lastNDays(7, now);
  eq(
    { b: d7.beginTime, e: d7.endTime, cb: d7.compareBeginTime, ce: d7.compareEndTime, dt: d7.dateType },
    { b: "20260914", e: "20260920", cb: "20260907", ce: "20260913", dt: "last_7_days" },
    "近7天窗口",
  );
  eq(d7.days.length, 7, "近7天应恰好 7 天");
  eq(d7.days[0], "20260914", "近7天第一天");
  eq(d7.days[6], "20260920", "近7天最后一天（昨天）");

  const d30 = lastNDays(30, now);
  eq(
    { b: d30.beginTime, e: d30.endTime, cb: d30.compareBeginTime, ce: d30.compareEndTime, dt: d30.dateType },
    { b: "20260822", e: "20260920", cb: "20260723", ce: "20260821", dt: "last_30_days" },
    "近30天窗口",
  );
  eq(d30.days.length, 30, "近30天应恰好 30 天");
});

T("lastNDays: 跨月跨年边界", () => {
  // 2026-01-01 的近7天要能正确退到 2025-12
  const now = new Date(2026, 0, 1);
  const d7 = lastNDays(7, now);
  eq({ b: d7.beginTime, e: d7.endTime }, { b: "20251225", e: "20251231" }, "跨年近7天");
  // 2026-03-01 的近7天要跨 2 月（2026 非闰年，2 月 28 天）
  const d7b = lastNDays(7, new Date(2026, 2, 1));
  eq({ b: d7b.beginTime, e: d7b.endTime }, { b: "20260222", e: "20260228" }, "跨 2 月近7天");
});

T("lastNDays: 含当天不算今天（end 永远是昨天）", () => {
  const now = new Date(2026, 8, 21);
  eq(lastNDays(1, now).endTime, "20260920", "近1天=昨天");
  eq(lastNDays(1, now).beginTime, "20260920", "近1天起止同一天");
});

T("lastNDays: 非法 n 要抛错而不是静默算错", () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    let threw = false;
    try { lastNDays(bad, new Date(2026, 8, 21)); } catch { threw = true; }
    if (!threw) throw new Error(`n=${bad} 应当抛错`);
  }
});

T("dayWindows: 今天/昨天（订单页用带横线格式）", () => {
  const w = dayWindows(new Date(2026, 8, 21));
  eq(w.today, { iso: "2026-09-21", ymd: "20260921" }, "今天");
  eq(w.yesterday, { iso: "2026-09-20", ymd: "20260920" }, "昨天");
  // 月初回退
  const w2 = dayWindows(new Date(2026, 8, 1));
  eq(w2.yesterday.ymd, "20260831", "9/1 的昨天是 8/31");
});

T("parseYmd / ymdToIso: 合法与非法", () => {
  eq(ymdToIso("20260822"), "2026-08-22", "标准");
  eq(ymdToIso("2026-08-22"), "2026-08-22", "已带横线也认");
  eq(ymdToIso("bogus"), "bogus", "非法原样返回");
  eq(parseYmd("2026822"), null, "位数不对返回 null");
});

T("unwrapMetric: 三种包装对象 + 纯数值 + 空值", () => {
  eq(unwrapMetric({ amount: "117947.25" }), 117947.25, "amount 字符串");
  eq(unwrapMetric({ turnover: "6469" }), 6469, "turnover 字符串");
  eq(unwrapMetric({ averagePrice: 26.55 }), 26.55, "averagePrice 数值");
  eq(unwrapMetric(123.45), 123.45, "纯数值");
  eq(unwrapMetric(null), null, "null");
  eq(unwrapMetric(undefined), null, "undefined");
  eq(unwrapMetric({}), null, "空对象");
  eq(unwrapMetric("abc"), null, "非数字字符串");
});

T("parseCore: 真实响应形状 → 窗口汇总", () => {
  // 取自 2026-09-21 实测的 last_30_days 响应片段（原样保留字符串型数值）
  const data = {
    multiDealAmount: { amount: "171762.46", relativeCycle: "-13.73%" },
    multiProjectedIncome: { amount: "117947.25", relativeCycle: "-14.73%", absValue: "20377.94" },
    multiTransactionVolume: { turnover: "6469", relativeCycle: "-11.97%" },
    multiSingleAveragePrice: { averagePrice: 26.55, relativeCycle: "-1.99%" },
    multiMerchantSubsidyAmount: { amount: "222818.42" },
    multiRefundAmount: { amount: "5627.61" },
    multiRefundOrderQuantity: { count: "197" },
    multiAllRefundOrderQuantity: 209,
    multiUserDeliveryFee: { amount: "3911.80" },
    multiStoreProjectedIncome: { amount: "951.19" },
  };
  const p = parseCore(data);
  eq(p.projectedIncome, 117947.25, "预计收入");
  eq(p.dealAmount, 171762.46, "成交额");
  eq(p.transactionVolume, 6469, "成交订单量");
  eq(p.avgPrice, 26.55, "客单价");
  eq(p.refundOrderQuantity, 197, "退款单量（count 包装）");
  eq(p.allRefundOrderQuantity, 209, "全退款单量（纯数值）");
  eq(p.cycles.projectedIncome, "-14.73%", "环比");
  // ⛔ 取消单**不在** core 里 —— 这条断言是防止以后误以为有
  eq(Object.keys(p).filter((k) => /cancel/i.test(k)), [], "core 不应出现 cancel 字段");
});

T("parseFixTimeChart: dataValue 是字符串，必须转成数值", () => {
  const data = {
    multiProjectedIncome: [
      { axis: "20260822", dataValue: "5041.89", trulyAxis: null },
      { axis: "20260823", dataValue: "4919.56", trulyAxis: null },
    ],
    multiTransactionVolume: [
      { axis: "20260822", dataValue: "282", trulyAxis: null },
    ],
  };
  const s = parseFixTimeChart(data);
  eq(s.projectedIncome, [
    { ymd: "20260822", value: 5041.89 },
    { ymd: "20260823", value: 4919.56 },
  ], "逐日预计收入已转数值");
  eq(typeof s.projectedIncome[0].value, "number", "必须是 number 而不是 string");
  eq(s.transactionVolume[0].value, 282, "逐日订单量");
  eq(parseFixTimeChart(undefined).projectedIncome, [], "空输入给空数组");
});

T("mergeDaily: 按日期对齐，缺失不硬造", () => {
  const days = mergeDaily({
    income: [{ ymd: "20260822", value: 5041.89 }, { ymd: "20260823", value: 4919.56 }],
    volume: [{ ymd: "20260823", value: 280 }],
    avgPrice: [{ ymd: "20260822", value: 25.81 }],
  });
  eq(days.length, 2, "天数");
  eq(days[0], {
    ymd: "20260822", date: "2026-08-22",
    projectedIncome: 5041.89, dealAmount: null, validOrderCount: null, avgOrderValue: 25.81,
  }, "第一天（订单量缺失为 null，不编 0）");
  eq(days[1].validOrderCount, 280, "第二天订单量");
  eq(days[1].avgOrderValue, null, "第二天客单价缺失");
  eq(days.map((d) => d.date), ["2026-08-22", "2026-08-23"], "日期为带横线格式且升序");
});

T("mergeDaily: 逐日金额求和必须等于窗口值（防字符串拼接）", () => {
  const income = [
    { ymd: "20260901", dataValue: "4190.86" },
    { ymd: "20260902", dataValue: "3878.59" },
    { ymd: "20260903", dataValue: "4435.94" },
  ].map((x) => ({ ymd: x.ymd, value: Number(x.dataValue) }));
  const days = mergeDaily({ income });
  const sum = days.reduce((a, d) => a + d.projectedIncome, 0);
  eq(typeof sum, "number", "求和结果必须是 number");
  eq(Math.round(sum * 100) / 100, 12505.39, "三日合计");
});
