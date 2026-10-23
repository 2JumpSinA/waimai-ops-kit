/**
 * 纯装配层 + 口径真相源的离线单测。
 *   node src/test-dashboard-model.mjs
 *
 * 为什么要有（照搬 `test-mt-income-assemble.mjs` 的分工）：
 *   `src/lib/dashboard-model.mjs` 与 `src/lib/caliber.mjs` 是**不碰文件系统**的纯函数，
 *   所以可以用固定样例离线测「口径有没有被改坏」，不必等真实数据、更不必开浏览器。
 *   覆盖的都是本项目真踩过/差点踩的坑：
 *     · 推广占比的分母必须是预计收入（不是 ka 的 convertOrderAmount，那会夸大约 3-4 倍）
 *     · 窗口 cancelRate 在 VM 层是**百分数**，而逐店 rate 是**小数**（量纲边界）
 *     · 收入口径说明必须**由 income.source 驱动**（旧版硬编码，与数据源不符）
 *     · 模板注入必须用**函数式 replace**（字符串式会把 echarts 里的 `$$`/`$1` 当替换模式展开）
 *     · 曝光 T+1：最新日不是今天
 */
import { test as nodeTest } from "node:test";
import { mergeByPoi, buildProjectModel, buildDashboardVm, assembleDashboardHtml } from "./lib/dashboard-model.mjs";
import { checkInvariants, yesterdayIso, incomeCaliberNotes, INCOME, PROMO, THRESHOLDS, SELF_CHECK_SPECS, buildCaliber } from "./lib/caliber.mjs";
import { extractScripts } from "./lib/dashboard-html.mjs";

const T = (n, f) => nodeTest(n, f);
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ?? "不相等"}\n  实际: ${A}\n  期望: ${B}`);
};
const yes = (c, msg) => { if (!c) throw new Error(msg ?? "断言失败"); };
const near = (a, b, tol = 0.011, msg) => {
  if (a == null || Math.abs(a - b) > tol) throw new Error(`${msg ?? "数值不符"}：实际 ${a}，期望约 ${b}`);
};

const META = { key: "quanyi", label: "品牌A", fullLabel: "品牌A健康" };

/** 造一份最小可用的输入。默认「平台聚合」口径、ka 金额单位是分。 */
function makeInputs(over = {}) {
  const daily = over.daily ?? [
    { date: "2026-09-14", orderCount: 100, validOrderCount: 98, cancelCount: 2, cancelRate: 0.02, projectedIncome: 1000, avgOrderValue: 10.2 },
    { date: "2026-09-15", orderCount: 200, validOrderCount: 196, cancelCount: 4, cancelRate: 0.02, projectedIncome: 2000, avgOrderValue: 10.2 },
  ];
  const inc = {
    source: INCOME.SOURCE_PLATFORM,
    caliber: "平台聚合",
    selfCheck: { projectedIncomeDiff: 0 },
    officialToday: { settleIncome: 500 },
    daily,
    windows: {
      today: { label: "今日", start: "2026-09-15", end: "2026-09-15", orderCount: 50, validOrderCount: 49, cancelCount: 1, cancelRate: 0.02, projectedIncome: 500, cancelIncome: null, avgOrderValue: 10.2, source: "todayOrderSummary（官方今日实时汇总）" },
      yesterday: { label: "昨日", start: "2026-09-15", end: "2026-09-15", orderCount: 200, validOrderCount: 196, cancelCount: 4, cancelRate: 0.02, projectedIncome: 2000, cancelIncome: null, avgOrderValue: 10.2, source: "fixTimeChart 昨日行 + order_cancel" },
    },
    byPoi: {
      d7: [{ poiId: "p1", poiName: "甲店", orders: 10, cancel: 3, income: 100, rate: 0.3 }],
      d30: [{ poiId: "p1", poiName: "甲店", orders: 40, cancel: 6, income: 400, rate: 0.15 }],
    },
    ...over.inc,
  };
  // ka 报表金额单位是「分」；convertOrderAmount 是**转化口径**，绝不可当收入分母
  const ka = {
    results: [
      { kind: "overview", label: "今日", data: { cost: 0, showCount: 0, clickCount: 0, cpc: 0, cpm: 0, clickRate: 0, convertEffectRoi: null, convertOrderAmount: 0 } },
      { kind: "overview", label: "昨日", data: { cost: 10000, showCount: 5000, clickCount: 100, cpc: 100, cpm: 200, clickRate: 0.02, convertEffectRoi: 3, convertOrderAmount: 30000 } },
      { kind: "overview", label: "近7天", data: { cost: 70000, showCount: 35000, clickCount: 700, cpc: 100, cpm: 200, clickRate: 0.02, convertEffectRoi: 7, convertOrderAmount: 500000 } },
      { kind: "list", data: { list: [{ time: "2026-09-15", cost: 10000, showCount: 5000, clickCount: 100, convertEffectRoi: 3, convertOrderAmount: 30000 }] } },
    ],
  };
  const expo = {
    source: "platform-total",
    caliber: "（原始文件里这句是错的，故意留着测「不抄它」）",
    fetchedAt: "2026-09-22T02:00:00.000Z",
    windows: { today: { days: 1, uv: 100, pv: 300, ringUv: 1, ringPv: 2, ringRateUv: 1, ringRatePv: 2, day: "2026-09-21" } },
    daily: [{ date: "2026-09-20", uv: 90, pv: 280 }, { date: "2026-09-21", uv: 100, pv: 300 }],
    dailyCaliber: "逐日来自 flowTransformationChart",
  };
  const files = { mt: null, inc, ka, expo, today: { date: "2026-09-22", recentHour: { orders: 5, cancel: 1, rate: 0.2 }, hourly: [{ hour: "10", orders: 5, rate: 0.2 }], caliber: { recentHour: "近1小时" } }, tb: null, tbDetail: null, ...over.files };
  const unifiedAll = over.unifiedAll ?? [
    { project: "quanyi", mtName: "甲店", city: "杭州", kind: "planned", mtId: "p1", tbId: "t1", planned: true, duplicate: false, live: { mtStatus: "营业中" } },
    { project: "quanyi", mtName: "乙店", city: "成都", kind: "planned", mtId: "", tbId: "t2", planned: false, duplicate: false, live: { mtStatus: "" } },
    { project: "quanyi", mtName: "重复店-N", city: "成都", kind: "planned", mtId: "p9", tbId: "", planned: false, duplicate: true, live: { mtStatus: "停业中" } },
    { project: "yifeng", mtName: "别家店", city: "上海", kind: "attention", mtId: "q1", tbId: "", planned: true, duplicate: false, live: { mtStatus: "营业中" } },
  ];
  const anomaliesAll = over.anomaliesAll ?? [
    { project: "quanyi", mtName: "甲店", city: "杭州", planned: true, offlineReason: "", anomaly: { meituan: true, eleme: false }, live: { mtStatus: "停业中", mtStatusFrom: "接口" } },
    { project: "yifeng", mtName: "别家店", city: "上海", planned: false, offlineReason: "", anomaly: { meituan: false, eleme: true }, live: { tbStatus: "休息中", tbStatusFrom: "台账" } },
  ];
  return { unifiedAll, anomaliesAll, files, meta: META };
}

const build = (over) => buildProjectModel(META, makeInputs(over));

// ════════════════════════════════════════════════════════════════
T("mergeByPoi：rate 是**小数**，income 收 2 位，脏 poiId 被剔除，按 cancel 降序", () => {
  const r = mergeByPoi([
    { byPoi: [{ poiId: "a", poiName: "A", orders: 10, cancel: 2, income: 1.234 }, { poiId: "null", orders: 1, cancel: 1, income: 1 }] },
    { byPoi: [{ poiId: "a", orders: 10, cancel: 3, income: 2.0 }, { poiId: "?", orders: 1, cancel: 1, income: 1 }, { poiId: "b", poiName: "B", orders: 100, cancel: 1, income: 5 }] },
  ]);
  eq(r.map((x) => x.poiId), ["a", "b"], "剔除 null/? 后按 cancel 降序");
  eq(r[0].orders, 20);
  eq(r[0].cancel, 5);
  eq(r[0].rate, 0.25, "rate 必须是小数 0-1");
  eq(r[0].income, 3.23, "income 收 2 位小数（1.234 + 2.0 = 3.234 → 3.23）");
});

// ════════════════════════════════════════════════════════════════
T("★ 推广占比分母 = 预计收入（不是 ka 的 convertOrderAmount）", () => {
  const p = build();
  // 昨日：cost 10000 分 = 100 元；预计收入 2000 → 5%
  near(p.windows.yesterday.promoCost, 100, 0.001, "cost 由分转元");
  near(p.windows.yesterday.promoRatio, 5, 0.001, "100/2000*100 = 5%");
  // 若错用 convertOrderAmount（30000 分 = 300 元）会得到 15%
  yes(Math.abs(p.windows.yesterday.promoRatio - 15) > 1, "绝不能是 convertOrderAmount 算出来的 15%");
  near(p.ka.windows.yesterday.convertOrderAmount, 300, 0.001, "转化金额只作展示，单位分→元");
});

T("★ 今日推广：ka 报表 T+1 → promoUnavailable，显示 — 而不是 0", () => {
  const p = build();
  eq(p.windows.today.promoUnavailable, true);
  eq(p.windows.today.promoCost, null, "取不到就必须是 null，不能是 0");
  eq(p.windows.today.promoRatio, null);
  yes(/T\+1/.test(p.windows.today.promoNote ?? ""), "要有 T+1 说明");
});

T("★ 量纲边界：VM 窗口 cancelRate 是百分数，逐店 rate 是小数", () => {
  const p = build();
  near(p.income.windows.today.cancelRate, 2, 0.001, "边界 0.02 → VM 2（百分数）");
  near(p.windows.today.cancelRate, 2, 0.001);
  near(p.income.byPoiD7[0].rate, 0.3, 1e-9, "逐店 rate 不转换，仍是小数");
  near(p.income.daily[0].cancelRate, 2, 0.001, "逐日也转成百分数");
});

T("d7/d30 由**逐日汇总**派生，且 cancelRate 是百分数", () => {
  const daily = Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-${String(8 + i).padStart(2, "0")}`, orderCount: 10, validOrderCount: 10, cancelCount: 1, cancelRate: 0.1, projectedIncome: 100, avgOrderValue: 10 }));
  const p = build({ daily, inc: { windows: {} } });
  eq(p.income.windows.d7.orderCount, 70, "7 天 × 10 单");
  eq(p.income.windows.d7.cancelCount, 7);
  near(p.income.windows.d7.cancelRate, 10, 0.001, "7/70 = 10%");
  eq(p.income.windows.d7.source, "逐日汇总");
  eq(p.income.windows.d7.end, "2026-09-14", "end 是最后一天，不含今天");
});

T("逐日天数不足时不硬凑：d7 退回区间查询值（若有）", () => {
  const p = build({ daily: [{ date: "2026-09-15", orderCount: 1, validOrderCount: 1, cancelCount: 0, cancelRate: 0, projectedIncome: 10, avgOrderValue: 10 }] });
  eq(p.income.windows.d7, undefined, "只有 1 天 → 既没区间值也没派生值");
});

T("★ 收入口径说明由 income.source 驱动（D-0 回归）", () => {
  const label = { quanyi: "品牌A", yifeng: "品牌B" };
  const a = incomeCaliberNotes({ quanyi: INCOME.SOURCE_PLATFORM, yifeng: INCOME.SOURCE_PLATFORM }, label);
  yes(a.includes("平台") && a.includes(INCOME.PRIMARY_FIELD), "平台聚合版要写平台字段");
  yes(!a.includes("Σ 逐单"), "平台聚合版不能再写逐单求和");
  const b = incomeCaliberNotes({ quanyi: INCOME.SOURCE_LEGACY, yifeng: INCOME.SOURCE_LEGACY }, label);
  yes(b.includes("Σ 逐单"), "逐单版要写逐单求和");
  yes(!b.includes(INCOME.PRIMARY_FIELD), "逐单版不该写平台字段");
  const c = incomeCaliberNotes({ quanyi: INCOME.SOURCE_PLATFORM, yifeng: INCOME.SOURCE_LEGACY }, label);
  yes(c.includes("品牌A") && c.includes("品牌B"), "两项目来源不同时必须分别写清");
  yes(c.includes("平台") && c.includes("Σ 逐单"), "两种算法都要出现");
});

T("VM 装配：notes 顺序、caliber/thresholds/selfCheckSpecs 注入、项目隔离", () => {
  const p = build();
  const vm = buildDashboardVm({ projects: [p, buildProjectModel({ key: "yifeng", label: "品牌B", fullLabel: "品牌B" }, makeInputs())], projectMetas: [{ key: "quanyi", label: "品牌A" }, { key: "yifeng", label: "品牌B" }], generatedAt: "T" });
  eq(vm.projectOrder, ["quanyi", "yifeng"]);
  yes(vm.notes[0].includes("收入口径"), "notes[0] 是收入口径");
  yes(vm.notes[1].includes(PROMO.FORMULA_TEXT), "notes[1] 是推广占比");
  // D-2 演进（2026-09-22）：今日改用首页实时接口 → 措辞从「今日窗口取不到数」改成「历史走报表 / 今日走实时」
  yes(vm.notes[1].includes("实时"), "notes[1] 说明今日走首页实时、历史走 T+1 报表");
  eq(vm.thresholds, THRESHOLDS, "阈值集中注入");
  eq(vm.selfCheckSpecs.length, SELF_CHECK_SPECS.length);
  yes(!("total" in vm), "不得有跨项目合计字段");
  eq(vm.caliber.exposure.samplesByProject.quanyi.platformPv, 18280, "品牌A曝光样本按项目给");
  yes(vm.caliber.exposure.samplesByProject.yifeng.byPoiSumPv === null, "没样本就不编数字");
  yes(vm.caliber.exposure.textByProject.quanyi.includes("品牌A"), "文案带项目名");
  yes(!vm.caliber.exposure.textByProject.yifeng.includes("18,280"), "品牌B文案不得出现品牌A的数字");
});

T("unifiedRows 字段名即数据契约（D-1 的根因面）", () => {
  const p = build();
  eq(Object.keys(p.unifiedRows[0]).sort(), ["city", "kind", "mtId", "mtStatus", "name", "offlineReason", "planned", "tbId"]);
  eq(p.unifiedRows[0].name, "甲店", "店名来自台账 mtName");
  eq(p.unifiedRows[0].mtStatus, "营业中", "状态来自 live.mtStatus");
  eq(p.unifiedRows.length, 2, "重复建店被剔除");
  eq(p.plan.total, 3);
  eq(p.plan.kept, 2);
  eq(p.plan.duplicate, 1);
  eq(p.plan.bothPlatforms + p.plan.onlyMeituan + p.plan.onlyEleme + p.plan.noId, p.plan.kept, "渠道分类要加得起来");
  eq(p.plan.listed + p.plan.unplanned, p.plan.kept, "登记/未登记要加得起来");
});

T("项目隔离：yifeng 的门店与异常不会串进 quanyi", () => {
  const p = build();
  yes(p.unifiedRows.every((s) => s.name !== "别家店"), "别家店属于 yifeng");
  eq(p.anomalies.length, 1);
  eq(p.anomalies[0].name, "甲店");
});

T("曝光透传 + 旧口径要告警", () => {
  const warns = [];
  const p = buildProjectModel(META, { ...makeInputs(), files: { ...makeInputs().files, expo: { source: "byPoi-sum", daily: [] } }, warn: (m) => warns.push(m) });
  yes(warns.some((w) => w.includes("旧口径")), "旧口径必须告警");
  eq(p.exposure.daily.length, 0);
  const p2 = build();
  eq(p2.exposure.windows.today.day, "2026-09-21");
  eq(p2.exposure.daily[p2.exposure.daily.length - 1].pv, p2.exposure.windows.today.pv, "★ 曲线末点 == 最新日窗口");
});

// ════════════════════════════════════════════════════════════════
T("★ 不变量自检：合规 VM 全绿；改坏一处只该挂对应那条", () => {
  const good = buildDashboardVm({
    projects: [build(), buildProjectModel({ key: "yifeng", label: "品牌B", fullLabel: "品牌B" }, makeInputs())],
    projectMetas: [{ key: "quanyi", label: "品牌A" }, { key: "yifeng", label: "品牌B" }],
    generatedAt: "T",
  });
  const r = checkInvariants(good);
  const bad = r.filter((x) => !x.ok);
  eq(bad.map((x) => x.id), [], "合规 VM 必须全绿");
  /**
   * ⚠️ `checkInvariants` 对**项目级**断言会逐项目各出一条（detail 里带项目名），
   *    所以条数 > 清单长度是**设计如此**；要钉的是「每个 id 都至少有一条结论」。
   */
  eq([...new Set(r.map((x) => x.id))].sort(), SELF_CHECK_SPECS.map((s) => s.id).sort(), "每个 id 都要有结论");
  yes(r.length >= SELF_CHECK_SPECS.length, "项目级断言逐项目展开");

  // ① 把逐店 rate 误乘 100（量纲写错的经典事故）
  const b1 = JSON.parse(JSON.stringify(good));
  b1.projects.quanyi.income.byPoiD7[0].rate = 30;
  const f1 = checkInvariants(b1).filter((x) => !x.ok).map((x) => x.id);
  yes(f1.includes("poi-rate-decimal"), `应挂 poi-rate-decimal，实际 ${JSON.stringify(f1)}`);

  // ② 推广占比用错分母
  const b2 = JSON.parse(JSON.stringify(good));
  b2.projects.quanyi.windows.yesterday.promoRatio = 15;
  const f2 = checkInvariants(b2).filter((x) => !x.ok).map((x) => x.id);
  yes(f2.includes("promo-ratio-denominator"), `应挂 promo-ratio-denominator，实际 ${JSON.stringify(f2)}`);

  // ③ 曝光曲线末点与窗口错位
  const b3 = JSON.parse(JSON.stringify(good));
  b3.projects.quanyi.exposure.daily[b3.projects.quanyi.exposure.daily.length - 1].pv = 1;
  const f3 = checkInvariants(b3).filter((x) => !x.ok).map((x) => x.id);
  yes(f3.includes("exposure-last-eq-window"), `应挂 exposure-last-eq-window，实际 ${JSON.stringify(f3)}`);

  // ④ 窗口 end 跑到今天之后
  const b4 = JSON.parse(JSON.stringify(good));
  b4.projects.quanyi.income.windows.d30 = { label: "近30天", start: "2026-09-01", end: "2099-01-01", orderCount: 1, cancelCount: 0, cancelRate: 0 };
  const f4 = checkInvariants(b4).filter((x) => !x.ok).map((x) => x.id);
  yes(f4.includes("window-end-excludes-today"), `应挂 window-end-excludes-today，实际 ${JSON.stringify(f4)}`);

  // ⑤ 曝光「最新日」写成今天
  const b5 = JSON.parse(JSON.stringify(good));
  b5.projects.quanyi.exposure.windows.today.day = "2099-01-01";
  const f5 = checkInvariants(b5).filter((x) => !x.ok).map((x) => x.id);
  yes(f5.includes("exposure-latest-is-yesterday"), `应挂 exposure-latest-is-yesterday，实际 ${JSON.stringify(f5)}`);
});

T("yesterdayIso：上海时区的昨天", () => {
  // 2026-09-22 02:00 UTC = 北京 10:00 → 昨天 2026-09-21
  eq(yesterdayIso(new Date("2026-09-22T02:00:00Z")), "2026-09-21");
  // 2026-09-22 20:00 UTC = 北京 09-23 04:00 → 昨天 09-22
  eq(yesterdayIso(new Date("2026-09-22T20:00:00Z")), "2026-09-22");
});

// ════════════════════════════════════════════════════════════════
T("★ 模板注入用**函数式 replace**：echarts 里的 $$ / $1 不被展开（真实事故回归）", () => {
  const echartsJs = 'var a="$$";var b="x$1y";var c="$&";';
  const tpl = `<!doctype html><html><body><!--ECHARTS--><script>const VM = /*__${"DATA__*/"};</script></body></html>`;
  const html = assembleDashboardHtml({ template: tpl, echartsJs, vm: { a: 1 } });
  const blocks = extractScripts(html);
  eq(blocks.length, 2, "两个 script 块");
  eq(blocks[0], echartsJs, "内联 echarts 必须与入参逐字节相同");
  yes(blocks[0].includes('"$$"'), "`$$` 不能被折成 `$`");
  yes(blocks[0].includes('"x$1y"'), "`$1` 不能被折成空串");
  yes(blocks[0].includes('"$&"'), "`$&` 不能被替换成整段匹配");
  yes(blocks[1].includes('"a":1'), "VM 已注入");
  yes(!html.includes("/*__" + "DATA__*/"), "占位符应已替换");
});

T("模板注入：占位符缺失必须抛错（别静默出一个白屏页）", () => {
  let threw = false;
  try { assembleDashboardHtml({ template: "<html><body>没有占位符</body></html>", echartsJs: "x", vm: {} }); } catch { threw = true; }
  yes(threw, "没有数据占位符就该抛错");
  let threw2 = false;
  try {
    assembleDashboardHtml({ template: "<html><!--ECHARTS--><script>/*__" + "APP__*/</script></html>", echartsJs: "x", vm: {}, appJs: "没有数据占位符的脚本" });
  } catch { threw2 = true; }
  yes(threw2, "分片模式下拼接结果缺数据占位符也该抛错");
});

T("buildCaliber：口径常量随 VM 注入，值与单一定义一致", () => {
  const p = build();
  const c = buildCaliber({ projectOrder: ["quanyi"], projects: { quanyi: p } });
  eq(c.income.primaryField, INCOME.PRIMARY_FIELD);
  eq(c.income.mustNotUse, INCOME.MUST_NOT_USE);
  eq(c.promo.denominator, PROMO.DENOMINATOR);
  eq(c.promo.mustNotUse, PROMO.MUST_NOT_USE);
  eq(c.promo.formulaText, PROMO.FORMULA_TEXT);
  eq(c.cancelRate.VM_WINDOW_UNIT, "percent");
  eq(c.cancelRate.VM_BYPOI_UNIT, "decimal");
  eq(c.window.excludeToday, true);
  eq(c.windowDefs.length, 4);
  eq(c.exposure.mode, "platform-total");
  yes(c.exposure.mustNotUse.includes("flowPoiExposureRankingV2"), "旧逐店口径必须在禁用清单里");
});
