/**
 * `src/lib/mini-metrics.mjs` 的离线单测（播报轻指标，待办 ③）。
 *   node src/test-mini-metrics.mjs
 *
 * 与 `test-dashboard-model.mjs` 同一分工：被测的是**纯函数**，所以用固定样例离线测，
 * 不必等真实数据、更不必开浏览器。这里钉死的是播报侧真会踩的坑：
 *   · **字段映射**必须与 kpiAll 同名字段一致（改名时播报静默变空是最坏的失败方式）
 *   · **缺失保持 null**（不能变成 0 / undefined / 拿别的数顶上）
 *   · **取消率是百分数**（12.5 而不是 0.125）—— 量纲错一次，播报就永远显示 0.13%
 *   · **⛔ 不含成交额**：产物里不得出现 caliber.INCOME.MUST_NOT_USE 的任何字段名
 *   · **旧数据必须带日期戳**：dataDate 必须来自数据，不是凭空造的
 *   · **不出环比**：产物里不得出现任何 chainRatio / ratio 以外的环比率字段
 */
import { test as nodeTest } from "node:test";
import { pickMiniMetrics, shiftDate, MINI_METRIC_FIELDS } from "./lib/mini-metrics.mjs";
import { INCOME, KPI_ALL_NOTES } from "./lib/caliber.mjs";

const T = (n, f) => nodeTest(n, f);
const yes = (c, msg) => { if (!c) throw new Error(msg ?? "断言失败"); };
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ?? "不相等"}\n  实际: ${A}\n  期望: ${B}`);
};

/**
 * 造一份最小 VM —— **只造 `pickMiniMetrics` 真会读的那部分结构**
 * （kpiAll / projects[key].income.daily / projects[key].today.date / projects[key].taobao.mda.daily）。
 * 刻意把 `dealAmount` 塞进逐日行里：用来证明「原始行有成交额，产物也带不出去」。
 */
function makeVm(over = {}) {
  const kpiToday = over.kpiToday ?? {
    projectedIncome: 3200.5,
    orderCount: 100,
    validOrderCount: 94,
    cancelCount: 6,
    cancelRate: 6, // ⚠️ 百分数：6 表示 6%
    avgOrderValue: 34.05,
    promoCost: 160.25,
    promoRatio: 5.01,
    promoRoi: 19.97,
  };
  /**
   * ⚠️ 结构真相：`kpiAll` 挂在**每个项目**的模型上，**不在** VM 顶层。
   *    这份样例刻意复刻真实结构（`buildDashboardVm().projects[key].kpiAll`）——
   *    曾经按「VM 顶层有 kpiAll」的想当然写过一版，真实数据跑出来全是 null 才发现。
   */
  const kpiAll = over.kpiAll ?? {
    today: kpiToday,
    yesterday: { ...kpiToday, projectedIncome: 2800, promoCost: 140 },
    d7: { ...kpiToday, projectedIncome: 20000, promoCost: 900 },
    d30: { ...kpiToday, projectedIncome: 80000, promoCost: 3600 },
  };
  return {
    projects: {
      quanyi: {
        key: "quanyi",
        label: "品牌A",
        kpiAll,
        today: { date: over.mtToday ?? "2026-10-22" },
        income: {
          daily: over.daily ?? [
            // ⛔ dealAmount 是成交额：原始行里**有**，但它绝不能被产物带出去
            { date: "2026-10-20", orderCount: 80, validOrderCount: 76, cancelCount: 4, projectedIncome: 2500, dealAmount: 9999 },
            { date: "2026-10-21", orderCount: 84, validOrderCount: 78, cancelCount: 6, projectedIncome: 2530, dealAmount: 8888 },
            { date: "2026-10-22", orderCount: 60, validOrderCount: 57, cancelCount: 3, projectedIncome: 1350, dealAmount: 7777 },
          ],
        },
        taobao: { mda: { daily: over.tbDaily ?? null } },
      },
      yifeng: { key: "yifeng", label: "品牌B", today: { date: null }, income: { daily: [] }, taobao: null },
    },
  };
}

T("结构契约：kpiAll 必须从 vm.projects[key] 取（顶层有 kpiAll 也不算）", () => {
  // 真实 VM 的顶层**没有** kpiAll；有人误以为有 → 这里钉死在项目模型上取
  const vm = makeVm();
  vm.kpiAll = { today: { projectedIncome: 999999 } }; // 顶层放个假数当陷阱
  const r = pickMiniMetrics(vm, "quanyi", "today");
  eq(r.metrics.projectedIncome.value, 3200.5, "必须取项目下的 kpiAll，不能被顶层假数带偏");
});

T("字段映射：四个指标与 kpiAll 同名字段一致", () => {
  const r = pickMiniMetrics(makeVm(), "quanyi", "today");
  eq(Object.keys(r.metrics).sort(), Object.keys(MINI_METRIC_FIELDS).sort(), "指标集合不对");
  eq(r.metrics.projectedIncome.value, 3200.5, "预计收入应取 kpiAll.projectedIncome");
  eq(r.metrics.validOrderCount.value, 94, "有效订单应取 kpiAll.validOrderCount");
  eq(r.metrics.cancelRate.value, 6, "取消率应取 kpiAll.cancelRate");
  eq(r.metrics.promoCost.value, 160.25, "推广消耗应取 kpiAll.promoCost");
  eq(r.project, { key: "quanyi", label: "品牌A" });
  eq(r.window, { key: "today", label: "今日" });
  eq(r.noData, false);
});

T("取消率是百分数：6 原样透传，绝不乘/除 100", () => {
  const r = pickMiniMetrics(makeVm(), "quanyi", "today");
  yes(r.metrics.cancelRate.value === 6, `取消率应为 6（百分数），实际 ${r.metrics.cancelRate.value}`);
  // 反例哨兵：如果把百分数当小数再乘 100 会变成 600
  yes(r.metrics.cancelRate.value !== 600 && r.metrics.cancelRate.value !== 0.06, "取消率量纲被改坏了");
});

T("取消率的来源口径：取消单÷订单数×100（与 kpiAll 同公式）", () => {
  // kpiAll 里缺 cancelRate（旧数据 / 某侧缺失），订单 200 取消 25 → 12.5%
  const vm = makeVm({
    kpiToday: { projectedIncome: 1000, orderCount: 200, validOrderCount: 180, cancelCount: 25, cancelRate: null, promoCost: 50 },
  });
  const r = pickMiniMetrics(vm, "quanyi", "today");
  // 单日窗口缺失时**不给替代值**（不拿逐日切片充数），必须保持 null
  eq(r.metrics.cancelRate.value, null, "kpiAll 缺 cancelRate 时单日窗口应保持 null");
});

T("缺失保持 null：整个 kpiAll 没有该窗口 → 全 null 且 noData=true", () => {
  const vm = makeVm({ kpiAll: { today: null, yesterday: null, d7: null, d30: null } });
  const r = pickMiniMetrics(vm, "quanyi", "today");
  for (const [k, m] of Object.entries(r.metrics)) {
    eq(m.value, null, `${k} 应为 null`);
    eq(m.dataDate, null, `${k} 的 dataDate 应为 null（没有数就不该有日期戳）`);
  }
  eq(r.noData, true);
  yes(typeof r.noDataNote === "string" && r.noDataNote.length > 0, "noData 时应给出 caliber 里的说明");
});

T("缺失保持 null：单个字段缺失只影响该字段", () => {
  const vm = makeVm({
    kpiToday: { projectedIncome: 500, orderCount: 10, validOrderCount: 9, cancelCount: 1, cancelRate: 10, promoCost: null, promoRatio: null, promoRoi: null },
  });
  const r = pickMiniMetrics(vm, "quanyi", "today");
  eq(r.metrics.promoCost.value, null, "推广消耗缺失应为 null，不能变 0");
  eq(r.metrics.projectedIncome.value, 500, "其它字段不该受影响");
  eq(r.noData, false, "只要还有数就不算 noData");
  eq(r.extras.promoRatio, null, "占比缺失应为 null");
});

T("⛔ 不含成交额：产物 JSON 里不出现 MUST_NOT_USE 的任何字段名", () => {
  const r = pickMiniMetrics(makeVm(), "quanyi", "today");
  const text = JSON.stringify(r);
  for (const f of INCOME.MUST_NOT_USE) {
    yes(!text.includes(f), `产物里出现了成交额字段 ${f} —— 收入必须是预计收入`);
  }
  // 原始逐日行里确实有 dealAmount（说明这个陷阱是真的），但产物里没有
  eq(r.incomeField, INCOME.PRIMARY_FIELD, "应如实标注收入来源字段（只是字段名，不是数值）");
  yes(!text.includes("dealAmount"), "原始逐日行的 dealAmount 不能漏进产物");
});

T("数据日期戳：今日窗口 dataDate = 美团 today.date（来自数据，不是凭空造）", () => {
  const r = pickMiniMetrics(makeVm(), "quanyi", "today");
  eq(r.metrics.projectedIncome.dataDate, "2026-10-22", "今日窗口应带今天的数据日期");
  eq(r.metrics.projectedIncome.basis, "single", "单日窗口 basis 应为 single");
  // 数据本身停在昨天 → 日期戳必须跟着走（这正是「旧数据要带日期戳」的意义）
  const old = pickMiniMetrics(makeVm({ mtToday: "2026-10-21" }), "quanyi", "today");
  eq(old.metrics.projectedIncome.dataDate, "2026-10-21", "数据旧了，日期戳必须如实变旧");
});

T("数据日期戳：昨日窗口 dataDate = 今天 -1 天", () => {
  const r = pickMiniMetrics(makeVm(), "quanyi", "yesterday");
  eq(r.metrics.projectedIncome.dataDate, "2026-10-21", "昨日窗口应带昨天的日期");
  eq(r.metrics.projectedIncome.value, 2800);
});

T("区间窗口（d7/d30）：basis=range 且有统计上界，不是「今日」口径", () => {
  const r = pickMiniMetrics(makeVm(), "quanyi", "d7");
  eq(r.metrics.projectedIncome.basis, "range", "d7 应标为区间口径");
  eq(r.metrics.projectedIncome.dataDate, "2026-10-22", "区间里实际有数的最新一天");
  eq(r.metrics.projectedIncome.dataEnd, "2026-10-22", "区间统计上界 = 数据日");
  // 上界跟数据走：today.date 退到 10-21，上界也变 10-21
  const old = pickMiniMetrics(makeVm({ mtToday: "2026-10-21" }), "quanyi", "d7");
  eq(old.metrics.projectedIncome.dataEnd, "2026-10-21", "上界必须跟数据日走");
});

T("区间窗口：最后一天还没数据时，上界不变、dataDate 如实退回有数的那天", () => {
  const vm = makeVm({
    daily: [
      { date: "2026-10-20", orderCount: 80, validOrderCount: 76, cancelCount: 4, projectedIncome: 2500 },
      { date: "2026-10-21", orderCount: 84, validOrderCount: 78, cancelCount: 6, projectedIncome: 2530 },
      // ⚠️ 10-22 那一行刻意缺（T+1 数据还没落）
    ],
  });
  const r = pickMiniMetrics(vm, "quanyi", "d7");
  eq(r.metrics.projectedIncome.dataEnd, "2026-10-22", "上界仍是数据日");
  eq(r.metrics.projectedIncome.dataDate, "2026-10-21", "有数的最新一天必须如实退回");
});

T("区间窗口兜底：kpiAll 缺 d7 时按逐日切片现算（与 kpiAll 同公式）", () => {
  const vm = makeVm({
    kpiAll: { today: null, yesterday: null, d7: null, d30: null },
    daily: [
      { date: "2026-10-16", orderCount: 10, validOrderCount: 10, cancelCount: 0, projectedIncome: 100 },
      { date: "2026-10-22", orderCount: 90, validOrderCount: 81, cancelCount: 9, projectedIncome: 900 },
      { date: "2026-10-01", orderCount: 5, validOrderCount: 5, cancelCount: 0, projectedIncome: 50 }, // 区间外
    ],
  });
  const r = pickMiniMetrics(vm, "quanyi", "d7");
  eq(r.metrics.projectedIncome.value, 1000, "近7天收入 = 切片内两天之和（区间外的 50 不算）");
  eq(r.metrics.cancelRate.value, 9, "取消率 = 9 ÷ 100 × 100 = 9（百分数）");
});

T("不出环比：产物里没有任何环比率字段", () => {
  const r = pickMiniMetrics(makeVm(), "quanyi", "today");
  const text = JSON.stringify(r);
  yes(!/chainRatio|chain_rate|环比/.test(text), "产物里出现了环比字段 —— 硬约束禁止出环比");
  // extras 只允许 占比 / ROI 两根口径值，且都是同一窗口内算的
  eq(Object.keys(r.extras).sort(), ["promoRatio", "promoRoi", "promoRatioFoot", "promoRoiFoot"].sort());
});

T("口径脚注一律来自 caliber.KPI_ALL_NOTES（不写死句子）", () => {
  const r = pickMiniMetrics(makeVm(), "quanyi", "today");
  eq(r.metrics.projectedIncome.foot, KPI_ALL_NOTES.incomeShort);
  eq(r.metrics.validOrderCount.foot, KPI_ALL_NOTES.orderFoot);
  eq(r.metrics.cancelRate.foot, KPI_ALL_NOTES.cancelFoot);
  eq(r.metrics.promoCost.foot, KPI_ALL_NOTES.promoCostFoot);
  eq(r.extras.promoRatioFoot, KPI_ALL_NOTES.promoRatioFoot);
  eq(r.extras.promoRoiFoot, KPI_ALL_NOTES.roiFoot);
});

T("合计数：美团 + 闪购逐日求和（kpiAll 已装配好时直接用它的值）", () => {
  const vm = makeVm({
    kpiToday: { projectedIncome: 1234.56, orderCount: 30, validOrderCount: 28, cancelCount: 2, cancelRate: 6.67, promoCost: 88.8 },
  });
  const r = pickMiniMetrics(vm, "quanyi", "today");
  eq(r.metrics.projectedIncome.value, 1234.56);
  eq(r.metrics.promoCost.value, 88.8);
});

T("未知项目 / 未知窗口 → 抛错（不静默返回空）", () => {
  let threw = 0;
  try { pickMiniMetrics(makeVm(), "nope", "today"); } catch { threw += 1; }
  try { pickMiniMetrics(makeVm(), "quanyi", "nope"); } catch { threw += 1; }
  eq(threw, 2, "未知项目/窗口必须抛错");
});

T("两个项目都不串味：yifeng 没有数据时是 noData，不拿 quanyi 的数", () => {
  const r = pickMiniMetrics(makeVm(), "yifeng", "today");
  eq(r.project.label, "品牌B");
  eq(r.metrics.projectedIncome.value, null, "品牌B没数据就该是 null");
  eq(r.noData, true);
});

T("shiftDate：跨月跨年正确，非法输入返回空串", () => {
  eq(shiftDate("2026-10-01", -1), "2026-09-30");
  eq(shiftDate("2026-01-01", -1), "2025-12-31");
  eq(shiftDate("2026-10-22", 0), "2026-10-22");
  eq(shiftDate("", -1), "");
  eq(shiftDate(null, -1), "");
});
