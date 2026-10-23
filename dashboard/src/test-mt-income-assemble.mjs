/**
 * 装配层（src/lib/mt-income-assemble.mjs）的离线单测。
 *   node src/test-mt-income-assemble.mjs
 *
 * 用**真实的响应形状**（取自 2026-09-21 实测片段）驱动装配，不需要浏览器、不需要登录。
 * 覆盖的都是真踩过的坑：
 *   · 平台窗口截止昨天，不含今天
 *   · 逐日订单量缺失时不能当 0（否则取消率变 100%）
 *   · core（窗口）与 fixTimeChart（逐日）应当自洽
 *   · 取消单只从 order_cancel 来；core 里没有 cancel
 *   · byPoi 要保留「平台逐店明细里没有、但有取消单」的门店
 *   · 逐日金额求和不能变成字符串拼接
 */
import { test as nodeTest } from "node:test";
import { assembleIncome, bucketCancels } from "./lib/mt-income-assemble.mjs";

const NOW = new Date(2026, 8, 21); // 2026-09-21 → 近7天 09-14~09-20，近30天 08-22~09-20
const T = (n, f) => nodeTest(n, f);
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ?? "不相等"}\n  实际: ${A}\n  期望: ${B}`);
};
const near = (a, b, tol = 0.011, msg) => {
  if (a == null || Math.abs(a - b) > tol) throw new Error(`${msg ?? "数值不符"}：实际 ${a}，期望约 ${b}`);
};

/** epoch 秒：给定 `YYYY-MM-DD` 的本地中午（避开时区把日期挤到前后一天） */
const ep = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d, 12, 0, 0).getTime() / 1000);
};

/** 造一批「取消单」明细行 */
const cancelRows = (specs) =>
  specs.flatMap(([iso, poiId, poiName, n = 1]) =>
    Array.from({ length: n }, () => ({ orderTime: ep(iso), status: 9, poiId, poiName, income: 0 })),
  );

/** 造 core 响应 */
const coreResp = (income, volume, deal, avg) => ({
  json: {
    code: 0, msg: "success",
    data: {
      multiProjectedIncome: { amount: String(income), relativeCycle: "-14.73%" },
      multiDealAmount: { amount: String(deal) },
      multiTransactionVolume: { turnover: String(volume) },
      multiSingleAveragePrice: { averagePrice: avg },
      multiRefundAmount: { amount: "5627.61" },
      multiRefundOrderQuantity: { count: "197" },
      multiAllRefundOrderQuantity: 209,
    },
  },
});

/** 造 fixTimeChart 响应：days = [[ymd, income, volume], ...] */
const chartResp = (days) => ({
  json: {
    code: 0, msg: "success",
    data: {
      multiProjectedIncome: days.map(([y, i]) => ({ axis: y, dataValue: String(i), trulyAxis: null })),
      multiDealAmount: days.map(([y, , , d]) => ({ axis: y, dataValue: String(d ?? 0) })),
      multiTransactionVolume: days.map(([y, , v]) => ({ axis: y, dataValue: String(v) })),
      multiSingleAveragePrice: days.map(([y, i, v]) => ({ axis: y, dataValue: String(v ? i / v : 0) })),
    },
  },
});

/** 近30天的日期字符串（08-22 ~ 09-20），共 30 天 */
const THIRTY = (() => {
  const out = [];
  for (let i = 30; i >= 1; i--) {
    const d = new Date(2026, 8, 21 - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return out;
})();
const YMD30 = THIRTY.map((s) => s.replace(/-/g, ""));

T("bucketCancels: epoch 秒按本地日期分桶 + 按店聚合", () => {
  const { byDay, byPoi } = bucketCancels(
    cancelRows([["2026-09-19", 111, "A店", 2], ["2026-09-19", 222, "B店", 1], ["2026-09-20", 111, "A店", 1]]),
  );
  eq(byDay.get("2026-09-19"), 3, "9-19 取消 3 单");
  eq(byDay.get("2026-09-20"), 1, "9-20 取消 1 单");
  eq(byPoi.get("111"), { poiId: "111", poiName: "A店", cancel: 3 }, "A店 3 单");
  eq(byPoi.get("222").cancel, 1, "B店 1 单");
});

T("bucketCancels: orderTime 缺失的行使被跳过而不是算成今天", () => {
  const { byDay } = bucketCancels([{ orderTime: null, poiId: 1 }, { orderTime: ep("2026-09-19"), poiId: 1 }]);
  eq([...byDay.entries()], [["2026-09-19", 1]], "只统计有时间的行");
});

T("窗口：近30天 / 近7天 用平台值，取消数来自 order_cancel 分桶", () => {
  const rows = cancelRows([
    ["2026-09-10", 111, "A店", 3],  // 落在近7天之外、近30天之内
    ["2026-09-18", 111, "A店", 2],  // 近7天之内
    ["2026-09-20", 222, "B店", 1],  // 近7天之内
  ]);
  // 逐日只给近7天那几天，方便同时验 d7 与 daily 的自洽
  const days = YMD30.map((y, i) => {
    const iso = THIRTY[i];
    const inc = iso >= "2026-09-14" && iso <= "2026-09-20" ? 1000 : 0;
    const vol = iso >= "2026-09-14" && iso <= "2026-09-20" ? 100 : 0;
    return [y, inc, vol, inc * 1.5];
  });
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "236679097", days: 30, now: NOW,
    cancelWindowRows: rows, cancelWindowTotal: 6,
    cancelTodayRows: cancelRows([["2026-09-21", 111, "A店", 1]]), cancelTodayTotal: 1,
    officialToday: { settleIncome: 829.83, validOrderCount: 44, completeOrderCount: 41, processOrderCount: 3, cancelOrderCount: 2 },
    agg: { core7: coreResp(23433.15, 1234, 33703.51, 27.31), core30: coreResp(117947.25, 6469, 171762.46, 26.55), chart30: chartResp(days) },
    poiDetail: { d7: [{ poiId: "111", poiName: "A店", income: 5000, orders: 200 }], d30: [] },
    only: new Set(["today", "yesterday", "d7", "d30", "daily", "byPoi"]),
  });

  eq(result.windows.d7.start, "2026-09-14", "近7天起");
  eq(result.windows.d7.end, "2026-09-20", "近7天止（昨天）");
  near(result.windows.d7.projectedIncome, 23433.15, 0.011, "近7天收入取 core");
  eq(result.windows.d7.validOrderCount, 1234, "近7天订单量取 core 的 transactionVolume");
  eq(result.windows.d7.cancelCount, 3, "近7天取消数 = 09-18 的 2 + 09-20 的 1");
  eq(result.windows.d7.orderCount, 1237, "orderCount = 有效 + 取消");
  // ⚠️ 必须是**小数**：消费方 build-dashboard 会再乘 100（这里原来跟着实现写成了百分数，曾漏掉一个真 bug）
  near(result.windows.d7.cancelRate, 3 / 1237, 0.0001, "取消率（小数口径）");

  eq(result.windows.d30.start, "2026-08-22", "近30天起");
  eq(result.windows.d30.cancelCount, 6, "近30天取消数 = 全部 3+2+1");
  eq(result.windows.d30.validOrderCount, 6469, "近30天订单量");

  eq(result.daily.length, 30, "逐日 30 天");
  eq(result.daily[0].date, "2026-08-22", "逐日首日");
  eq(result.daily[29].date, "2026-09-20", "逐日末日 = 昨天");

  eq(result.source, "platform-aggregate", "来源标记");
  eq(result.cancelOrders, { window: 6, windowTotal: 6, today: 1, todayTotal: 1 }, "取消单统计");
});

T("今日窗口：以官方汇总为准（平台窗口不含今天）", () => {
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelTodayRows: cancelRows([["2026-09-21", 111, "A店", 2]]), cancelTodayTotal: 2,
    officialToday: { settleIncome: 829.83, validOrderCount: 44, completeOrderCount: 41, processOrderCount: 3, cancelOrderCount: 2 },
    agg: {}, only: new Set(["today"]),
  });
  eq(result.windows.today.projectedIncome, 829.83, "今日收入取 settleIncome");
  eq(result.windows.today.validOrderCount, 44, "今日已接订单");
  eq(result.windows.today.cancelCount, 2, "今日取消取 cancelOrderCount");
  eq(result.windows.today.orderCount, 46, "今日订单 = 44 + 2");
  eq(result.windows.today.source, "todayOrderSummary（官方今日实时汇总）", "来源标注");
  if (/cancel/i.test(Object.keys(result.windows.today).join(",")) === false) throw new Error("窗口对象应无 cancel 之外的歧义字段");
});

T("★ core 与 fixTimeChart 自洽：同源两接口应一致（自检必须全绿）", () => {
  /**
   * ⚠️ 样例要用**两位小数**的真实值。
   * 我第一版把每天写成 3931.575（三位小数），逐日 r2 后 30 天累积出 0.15 的差，
   * 测试挂了 —— 但那是**样例不真实**：平台返回的 dataValue 本来就是两位小数字符串
   * （实测 "5041.89"），逐日取整是幂等的。
   *
   * 自检容差取 1 元而非 0：万一某天平台给了三位小数，30 天最多累积 0.15 元，
   * 1 元的容差既不会误报，也足够抓住真正的不一致（量级差几十上百元）。
   */
  const per = 3931.57;
  const days = YMD30.map((y) => [y, per, 200, 0]);
  const sumIncome = Math.round(per * 30 * 100) / 100;
  const sumVol = 200 * 30;
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelWindowRows: [], // 没有取消单 → cancel 为 null，不影响收入自洽
    agg: {
      core7: coreResp(Math.round(per * 7 * 100) / 100, 1400, 0, 27),
      core30: coreResp(sumIncome, sumVol, 0, 26),
      chart30: chartResp(days),
    },
    only: new Set(["d7", "d30", "daily"]),
  });
  const checks = result.selfCheck.checks.filter((c) => /vs fixTimeChart/.test(c.name));
  if (checks.length < 2) throw new Error(`自检项太少：${checks.length}`);
  for (const c of checks) {
    if (c.ok !== true) throw new Error(`自检未通过：${c.name}  ${c.a} vs ${c.b} diff=${c.diff}`);
  }
  eq(result.selfCheck.checks.find((c) => c.name.startsWith("近30天 预计收入")).diff, 0, "两位小数样例下收入差应恰为 0");
});

T("★ 逐日订单量缺失时：cancelRate 必须为 null，不能是 100%", () => {
  // 逐日只有收入、没有订单量（模拟 fixTimeChart 未返回 multiTransactionVolume）
  const days = YMD30.map((y) => [y, 1000, null]);
  const chart = {
    json: {
      code: 0, msg: "success",
      data: {
        multiProjectedIncome: days.map(([y, i]) => ({ axis: y, dataValue: String(i) })),
        multiTransactionVolume: [], // 空
      },
    },
  };
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelWindowRows: cancelRows([["2026-09-19", 111, "A店", 5]]),
    agg: { chart30: chart },
    only: new Set(["daily"]),
  });
  const d = result.daily.find((x) => x.date === "2026-09-19");
  eq(d.cancelCount, 5, "取消数照记");
  eq(d.validOrderCount, null, "订单量缺失应为 null");
  eq(d.orderCount, null, "orderCount 不能退化成取消数");
  eq(d.cancelRate, null, "⚠️ 取消率必须是 null，不能变成 100%");
  if (!result.warnings.some((w) => /缺订单量/.test(w))) throw new Error("应当有「缺订单量」提醒");
});

T("逐日金额是数值：求和必须等于窗口值，不能字符串拼接", () => {
  const days = YMD30.map((y) => [y, 5041.89, 282, 0]);
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelWindowRows: [],
    agg: { chart30: chartResp(days) },
    only: new Set(["daily"]),
  });
  const sum = result.daily.reduce((s, d) => s + d.projectedIncome, 0);
  eq(typeof sum, "number", "求和是 number");
  near(sum, 5041.89 * 30, 0.05, "30 天合计");
  eq(typeof result.daily[0].projectedIncome, "number", "逐日收入是 number");
});

T("★ byPoi：取消单落在平台逐店明细里没有的门店时也要保留", () => {
  const days = YMD30.map((y) => [y, 100, 10, 0]);
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    // C 店在取消单里有，但平台逐店明细里没有
    cancelWindowRows: cancelRows([["2026-09-18", 111, "A店", 1], ["2026-09-19", 333, "C店", 4]]),
    agg: { core7: coreResp(1, 1, 1, 1), core30: coreResp(1, 1, 1, 1), chart30: chartResp(days) },
    poiDetail: { d7: [{ poiId: "111", poiName: "A店", income: 5000, orders: 200 }], d30: [{ poiId: "111", poiName: "A店", income: 20000, orders: 800 }] },
    only: new Set(["d7", "d30", "byPoi"]),
  });
  const d7 = result.byPoi.d7;
  const c = d7.find((x) => x.poiId === "333");
  if (!c) throw new Error("C 店被漏掉了 —— 有取消单的门店不能因为平台明细没给就消失");
  eq(c.cancel, 4, "C 店取消数");
  eq(c.income, 0, "C 店收入未知记 0");
  const a = d7.find((x) => x.poiId === "111");
  eq(a.orders, 200 + 1, "A店订单 = 平台 200 + 取消 1");
  eq(d7[0].poiId, "333", "按取消数降序：C 店在前");
});

T("逐日缺失的日期不硬造（chart 少给几天时）", () => {
  const days = [["20260918", 100, 10], ["20260919", 200, 20], ["20260920", 300, 30]];
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelWindowRows: [], agg: { chart30: chartResp(days) },
    only: new Set(["daily"]),
  });
  eq(result.daily.length, 3, "只输出平台给的天数");
  eq(result.daily.map((d) => d.date), ["2026-09-18", "2026-09-19", "2026-09-20"], "日期顺序");
});

T("--only 生效：没要的窗口/逐日不出现在结果里", () => {
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelWindowRows: [], agg: { core30: coreResp(100, 10, 150, 10) },
    only: new Set(["d30"]), byPoiOn: false,
  });
  eq(Object.keys(result.windows), ["d30"], "只有 d30 窗口");
  eq(result.daily.length, 0, "没算逐日");
  eq(Object.keys(result.byPoi), [], "关掉逐店开关后 byPoi 为空");
});

T("★ 逐店独立于 --only：refresh-all.ps1 的真实调用必须能拿到 byPoi", () => {
  /**
   * 回归用例。refresh-all.ps1 第 258/267 行传的是：
   *   --only=today,yesterday,d7,d30,daily --byPoiAll=1
   * **`byPoi` 不在 `--only` 里**。我第一版把逐店绑在 `only` 上，
   * 结果刷新流水线跑完「高取消单占比门店」会静默变空 —— 看板少一块还没人报错。
   */
  const days = YMD30.map((y) => [y, 100, 10, 0]);
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelWindowRows: cancelRows([["2026-09-18", 111, "A店", 2]]),
    agg: { core7: coreResp(1, 1, 1, 1), core30: coreResp(1, 1, 1, 1), chart30: chartResp(days) },
    poiDetail: {
      d7: [{ poiId: "111", poiName: "A店", income: 100, orders: 20 }],
      d30: [{ poiId: "111", poiName: "A店", income: 400, orders: 80 }],
    },
    only: new Set(["today", "yesterday", "d7", "d30", "daily"]), // ← 故意不含 byPoi
    byPoiOn: true, // ← 对应 --byPoiAll=1
  });
  if (!result.byPoi.d7?.length) throw new Error("byPoi.d7 为空 —— 高取消门店会静默变空！");
  if (!result.byPoi.d30?.length) throw new Error("byPoi.d30 为空 —— 高取消门店会静默变空！");
  eq(result.byPoi.d7[0].poiId, "111", "逐店条目");
  eq(result.byPoi.d7[0].cancel, 2, "逐店取消数来自取消单分桶");
  eq(result.windows.d30.validOrderCount, 1, "窗口仍按 --only 计算");
});

T("逐店窗口参数独立于 --only：只给 daily 时 d7/d30 逐店照样算", () => {
  const days = YMD30.map((y) => [y, 100, 10, 0]);
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelWindowRows: [],
    agg: { chart30: chartResp(days) },
    poiDetail: { d7: [{ poiId: "9", poiName: "X", income: 5, orders: 1 }], d30: [{ poiId: "9", poiName: "X", income: 9, orders: 2 }] },
    only: new Set(["daily"]), // 快捷模式：不含 d7/d30/byPoi
    byPoiOn: true,
  });
  eq(Object.keys(result.windows), [], "没算窗口");
  eq(result.daily.length, 30, "算了逐日");
  eq(result.byPoi.d7.length, 1, "d7 逐店仍算出来");
  eq(result.byPoi.d30.length, 1, "d30 逐店仍算出来");
});

T("★★ 量纲不变量：窗口 cancelRate 必须是「小数」，daily 也是（不许写百分数）", () => {
  /**
   * 这条是本轮最值钱的测试。
   *
   * 真实事故：我在装配层把窗口取消率写成百分数（`c/total*100`），
   * 而消费方 build-dashboard.mjs:168 会再乘一次 100 →
   * 品牌B今日取消率显示成 **1273%**。
   *
   * ⚠️ 当时离线单测**没拦住** —— 因为断言里照抄了同一个错误量纲
   *    （`near(cancelRate, (3/1237)*100)`）。测试复述实现，实现错了测试跟着错。
   *
   * 所以这里改成钉**量纲不变量**：取消率是比例，就该落在 [0,1]。
   * 无论实现怎么改，只要它回到百分数就会立刻挂。
   */
  const days = YMD30.map((y) => [y, 1000, 100, 0]);
  const { result } = assembleIncome({
    acct: { key: "yifeng", label: "品牌B" }, acctId: "1", now: NOW,
    // 故意造高取消率：100 单里 50 单取消 → 小数 0.5 / 百分数 50，一测就分得清
    cancelWindowRows: cancelRows([["2026-09-19", 111, "A店", 50]]),
    cancelTodayRows: cancelRows([["2026-09-21", 111, "A店", 50]]), cancelTodayTotal: 50,
    officialToday: { settleIncome: 1000, validOrderCount: 100, cancelOrderCount: 50 },
    agg: { core7: coreResp(7000, 100, 0, 70), core30: coreResp(30000, 100, 0, 70), chart30: chartResp(days) },
    poiDetail: { d7: [{ poiId: "111", poiName: "A店", income: 1, orders: 1 }], d30: [] },
    only: new Set(["today", "yesterday", "d7", "d30", "daily"]), byPoiOn: true,
  });

  const rateOf = (x) => x?.cancelRate;
  const check = (name, r) => {
    if (r == null) throw new Error(`${name} 取消率为空`);
    if (r < 0 || r > 1) {
      throw new Error(
        `${name} 取消率 = ${r}，超出 [0,1] —— 说明写成了百分数。\n` +
        `  消费方 build-dashboard.mjs 会再乘 100，会显示成 ${r * 100}%。`,
      );
    }
  };
  for (const k of ["today", "yesterday", "d7", "d30"]) check(`windows.${k}`, result.windows[k]);
  for (const d of result.daily) check(`daily ${d.date}`, d);

  // 具体值也对一遍：100 有效 + 50 取消 → 1/3
  near(rateOf(result.windows.today), 50 / 150, 0.0001, "今日 50/150");
  near(rateOf(result.windows.d7), 50 / (100 + 50), 0.0001, "近7天 50/150");
  near(rateOf(result.daily.find((d) => d.date === "2026-09-19")), 50 / 150, 0.0001, "逐日 50/150");

  // 逐店 rate 同样是小数
  const bad = result.byPoi.d7.filter((x) => x.rate < 0 || x.rate > 1);
  eq(bad.length, 0, "byPoi.rate 也必须落在 [0,1]");
});

T("窗口：小数口径下 today/d7/d30 的取消率一致可比", () => {
  // 同样的取消比例放在三个窗口，值应当一致 —— 若有一个写成百分数就会露馅
  const days = YMD30.map((y) => [y, 1000, 100, 0]);
  const { result } = assembleIncome({
    acct: { key: "yifeng", label: "品牌B" }, acctId: "1", now: NOW,
    cancelWindowRows: cancelRows([["2026-09-19", 111, "A店", 25]]),
    cancelTodayRows: [], cancelTodayTotal: 0,
    officialToday: { settleIncome: 1000, validOrderCount: 100, cancelOrderCount: 25 },
    agg: { core7: coreResp(7000, 100, 0, 70), core30: coreResp(30000, 100, 0, 70), chart30: chartResp(days) },
    only: new Set(["today", "d7", "d30", "daily"]),
  });
  const t = result.windows.today.cancelRate;
  const d7 = result.windows.d7.cancelRate;
  const d30 = result.windows.d30.cancelRate;
  for (const [n, v] of [["today", t], ["d7", d7], ["d30", d30]]) {
    near(v, 25 / 125, 0.0001, `${n} 应为 0.2 量级的小数`);
  }
});

T("★ 今日确实 0 单取消时，自检应判定「通过」而不是「无法判定」", () => {
  /**
   * 真实场景（品牌A 2026-09-21）：今日 90 单、0 单取消。
   * 我原来写的是 `cancelTodayRows.length || null` —— `0 || null` = null，
   * 于是自检显示成「◻️ 无法判定」，把一条本该通过的检查伪装成不确定。
   * 判据必须是「有没有取过今日取消单」，不是「取到几条」。
   */
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelTodayRows: [], cancelTodayTotal: 0, cancelTodayFetched: true,
    officialToday: { settleIncome: 1818.77, validOrderCount: 90, cancelOrderCount: 0 },
    agg: {}, only: new Set(["today"]),
  });
  const c = result.selfCheck.checks.find((x) => x.name.includes("今日 取消单"));
  if (!c) throw new Error("找不到今日取消单自检项");
  eq(c.a, 0, "官方今日取消数");
  eq(c.b, 0, "order_cancel 列表条数（0 就是 0，不能变成 null）");
  eq(c.ok, true, "两条路都是 0 → 应当判定通过");
  eq(result.windows.today.cancelCount, 0, "窗口取消数");
  eq(result.windows.today.cancelRate, 0, "取消率 0（不是 null、不是 NaN）");
});

T("今日没取过取消单时，自检才是「无法判定」", () => {
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelTodayFetched: false,
    officialToday: { settleIncome: 100, validOrderCount: 10, cancelOrderCount: 1 },
    agg: {}, only: new Set(["today"]),
  });
  const c = result.selfCheck.checks.find((x) => x.name.includes("今日 取消单"));
  eq(c.b, null, "没取过 → 对照值为 null");
  eq(c.ok, null, "无法判定");
});

T("旧字段名兼容：selfCheck.projectedIncomeDiff 必须存在（看板模板依赖）", () => {
  const { result } = assembleIncome({
    acct: { key: "quanyi", label: "品牌A" }, acctId: "1", now: NOW,
    cancelTodayRows: cancelRows([["2026-09-21", 111, "A店", 1]]),
    officialToday: { settleIncome: 829.83, validOrderCount: 44, cancelOrderCount: 2 },
    agg: {}, only: new Set(["today"]),
  });
  eq(result.selfCheck.projectedIncomeDiff, 0, "今日平台=官方 → 差 0");
  eq(result.selfCheck.validOrderDiff, 0, "订单量差 0");
  eq(result.caliber.includes("order_cancel"), true, "口径说明要提到 order_cancel");
  eq(result.statusCodes["9"], "已取消", "状态码保留");
});
