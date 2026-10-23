/**
 * 口径的唯一真相源（single source of truth）。
 *
 * 为什么必须单独一个文件：
 *   2026-09-21 收入从「逐单求和」换成「平台聚合」之后，**代码改了、口径说明没改** ——
 *   `build-dashboard.mjs` 的 `notes[0]` 仍写着「Σ 逐单 finalSettlementAmount」，
 *   而同一个文件 `:194` 已经把真实来源透传进看板了，模板 `:295-299` 也据此切换 KPI 文案。
 *   结果同一页上「徽标说平台聚合、口径说明说逐单求和」——**在向用户陈述一个不适用的算法**。
 *   这类漂移的根因是「口径事实散落在注释、硬编码字符串与实现里」。
 *   所以：**数值常量、文案生成器、不变量断言，全部集中到本文件**，
 *   由 `build-dashboard.mjs` 注入 `VM.caliber` / `VM.thresholds`，模板只读不算。
 *
 * ⚠️ 本文件**定义**口径，不**抄写**口径：
 *   `data/raw/exposure-*.json` 自报的 `caliber` 字符串写着「窗口由 recentDays 决定（**含今天**）」，
 *   而同一文件的 `windows.today.day = 2026-09-21`（昨天）—— 文件自报文案本身就是错的。
 *   因此这里自定义 T+1 规则，原始文案只作存档、绝不作为真相源。
 *
 * 本文件不碰文件系统、不碰浏览器。
 */

/** 两个项目：品牌A / 品牌B。**独立项目，不汇总、不跨项目相加。** */
export const PROJECTS = [
  { key: "quanyi", label: "品牌A", fullLabel: "品牌A健康" },
  { key: "yifeng", label: "品牌B", fullLabel: "品牌B" },
];

/** 看板切换器的四个窗口。 */
export const WINDOW_DEFS = [
  { key: "today", label: "今日" },
  { key: "yesterday", label: "昨日" },
  { key: "d7", label: "近7天" },
  { key: "d30", label: "近30天" },
];

/** ka 报表里的区间标签 → 看板窗口 key。 */
export const KA_LABEL_TO_KEY = { 今日: "today", 昨日: "yesterday", 近7天: "d7", 近30天: "d30" };

// ════════════════════════════════════════════════════════════════════
// 收入：一律「预计收入」，不是成交额
// ════════════════════════════════════════════════════════════════════
export const INCOME = {
  /** ⭐ 预计收入的平台字段（窗口） */
  PRIMARY_FIELD: "multiProjectedIncome",
  /** ⭐ 预计收入的平台字段（逐日） */
  DAILY_FIELD: "fixTimeChart",
  /** ⛔ 绝不能当收入用的字段 */
  MUST_NOT_USE: ["multiDealAmount"],
  /** 平台聚合口径的来源标记（由 lib/mt-income-assemble.mjs 写入 income-*.json） */
  SOURCE_PLATFORM: "platform-aggregate",
  /** 旧逐单口径的来源标记 */
  SOURCE_LEGACY: "orderlist-legacy",
  /** 逐单求和的实体（已退为对账基准） */
  LEGACY_MODULE: "src/legacy/fetch-meituan-income-orderlist.mjs",
  /** 官方对账字段（自校验用） */
  OFFICIAL_FIELD: "settleIncome",
  /** 关系运算的语义：逐单时剔除已取消 */
  LEGACY_CANCEL_STATUS: 9,
};

/** 各来源对应的**算法描述**（D-0：口径说明必须由数据源驱动，不许硬编码）。 */
export const INCOME_ALGO = {
  [INCOME.SOURCE_PLATFORM]:
    `平台 \`manageHome/core\` 的 \`${INCOME.PRIMARY_FIELD}\`（窗口）/ \`${INCOME.DAILY_FIELD}\`（逐日）`,
  [INCOME.SOURCE_LEGACY]:
    `Σ 逐单 \`finalSettlementAmount\`（\`orderStatus ≠ ${INCOME.LEGACY_CANCEL_STATUS}\`，即剔除已取消）`,
};

/** 未知来源时的兜底（既不是平台聚合也不是逐单 —— 说明数据格式变了，宁可说不确定）。 */
export const INCOME_ALGO_UNKNOWN = "来源未标记（既非平台聚合亦非逐单，需复查取数脚本）";

export const algoOf = (source) => INCOME_ALGO[source] ?? INCOME_ALGO_UNKNOWN;

/** KPI 卡片脚注里的**短**口径短语。 */
export function incomeCaliberShort(source) {
  return source === INCOME.SOURCE_PLATFORM
    ? `平台 ${INCOME.PRIMARY_FIELD}（窗口聚合）`
    : source === INCOME.SOURCE_LEGACY
      ? `Σ 逐单 finalSettlementAmount（剔除已取消）`
      : INCOME_ALGO_UNKNOWN;
}

/**
 * D-0：收入口径的**全局说明**，按各项目自报的 source 生成。
 * 两个项目来源不同时，必须**分别写清**，不能笼统混讲。
 * @param {Record<string,string>} sourceByProject key → source
 * @param {Record<string,string>} labelByProject key → 中文名
 */
export function incomeCaliberNotes(sourceByProject, labelByProject) {
  const keys = Object.keys(sourceByProject);
  const distinct = [...new Set(keys.map((k) => sourceByProject[k]))];
  const tail =
    `该口径已与平台官方 \`${INCOME.OFFICIAL_FIELD}\` 逐单核对，差额 0.00。` +
    `**不是成交额 \`${INCOME.MUST_NOT_USE[0]}\`**。`;
  if (distinct.length <= 1) {
    return (
      `**收入口径**：全看板收入一律使用「**预计收入**」= ${algoOf(distinct[0])}。${tail}`
    );
  }
  const parts = keys.map((k) => `${labelByProject[k] || k} 用 ${algoOf(sourceByProject[k])}`);
  return (
    `**收入口径（按项目不同）**：全看板收入一律使用「**预计收入**」，但两个项目的数据来源不同 —— ` +
    parts.join("；") + `。${tail}`
  );
}

// ════════════════════════════════════════════════════════════════════
// 推广占比：分母是预计收入，不是 ka 自己的 convertOrderAmount
// ════════════════════════════════════════════════════════════════════
export const PROMO = {
  FORMULA_TEXT: "推广消耗 ÷ 预计收入",
  /** ⭐ 分母必须是这个字段 */
  DENOMINATOR: "projectedIncome",
  /** ⛔ 不是 ka 报表的转化金额（口径偏小，会夸大约 3-4 倍） */
  MUST_NOT_USE: ["convertOrderAmount"],
  /** ka 报表金额单位是「分」，消费时 ÷100 */
  REPORT_UNIT: "fen",
  COST_DIVISOR: 100,
  /** 报表 T+1：今日窗口取不到数（**今日改用首页实时，见 PROMO_LIVE_NOTE**） */
  T1: true,
  /** 首页实时接口的**短标签**（KPI 脚注用，完整说明见 PROMO_LIVE_NOTE） */
  LIVE_SHORT: "推广首页实时 ≤15 分钟延迟",
};

/** D-2：T+1 缺数的说明必须**由 promoUnavailable 驱动**，不许写死一句话。 */
export const PROMO_UNAVAILABLE_NOTE = "今日推广报表次日生成，本窗口取不到数，显示 —";

/**
 * ⭐ 2026-09-22：今日推广改用**首页实时接口**（经营者要求「今日的能看到的就加进看板」）。
 *   报表 T+1，但推广首页有当下值（含今日与昨日的**分时**曲线）。
 *   ⚠️ 首页原话「数据预计最长有 15 分钟延迟」—— 必须如实标注，不能当秒级实时。
 */
export const PROMO_LIVE_NOTE = "今日消耗/曝光/点击来自推广首页实时接口（数据最长约 15 分钟延迟）";
/**
 * ⭐ R13（2026-09-24）：推广 ROI 口径统一改为**本看板计算** = 预计收入 ÷ 推广消耗
 *   （经营者原话：「看板上所有的推广ROI口径都需要调整为预计收入/推广消耗」）。
 *   平台「转化 ROI」（convertEffectRoi）弃用；今日用实时消耗 × 今日预计收入现算。
 */
export const PROMO_ROI_NOTE = "推广 ROI = 预计收入 ÷ 推广消耗（本看板计算，非平台转化口径）";
/** 实时也取不到时（接口失败）才用的说明。 */
export const PROMO_T1_NOTE = "推广报表为 T+1，今日数据次日才有";

export function promoNotes() {
  return (
    `**推广占比** = ${PROMO.FORMULA_TEXT}。推广消耗取自美团营销平台：` +
    `**历史窗口**用 T+1 报表（金额单位原为「分」，已 ÷${PROMO.COST_DIVISOR}）；` +
    `**今日**用推广首页的**实时接口**（含今日/昨日分时，数据最长约 15 分钟延迟）。` +
    `**推广 ROI** = ${PROMO_ROI_NOTE}；今日/昨日分时图的小时 ROI = ` +
    `逐单分时预计收入 ÷ 实时分时消耗（按小时对齐现算）。`
  );
}

// ════════════════════════════════════════════════════════════════════
// 数据语义：**缺失值标记**（不是「确定的未营业」）
// ════════════════════════════════════════════════════════════════════
/**
 * ⭐ R2：台账 Excel 里 `#N/A` / `N/A` 这类「查不到值的占位符」会被
 *    `src/import-plan.mjs:107` 的 `isLiveClosed()` 判成**确定的未营业**
 *    （它只挡了空串：`v !== "" && !isLiveOpen(v)`）。
 *    后果：品牌B七宝店 `live.tbStatus = "#N/A"` → 被算作未营业 → 进入「异常未营业」，
 *    且 D-1 修好后门店表会把它渲染成一个「未营业」红标签 —— 显示一个并不存在的状态。
 *
 * 语义规定：缺失值标记算「**未知**」——**既不归未营业，也不归营业中**。
 *
 * ⚠️ 根治点在 `src/import-plan.mjs:107-110`（把 `isMissingValue` 并进 `isLiveClosed`），
 *    但那不在本任务的写作用域内、且要重跑 import-plan 写 `data/plan/*`。
 *    本文件在**消费侧**（`dashboard-model.mjs`）先做归一化，保证看板不再显示假状态；
 *    根治补丁已作为遗留项报给 Lead。
 */
export const MISSING_VALUE_RE = /^(#?N\/A|#?NA|NULL|NIL|NONE|-|--|—|\?|无|未知|不详)$/i;

/** 是否是「缺失值标记」（而非一个真实业务取值）。 */
export const isMissingValue = (v) => {
  const s = String(v ?? "").trim();
  return s === "" || MISSING_VALUE_RE.test(s);
};

/** 状态字段归一化：缺失值标记 → `""`（未知），真实取值原样返回。 */
export const normStatus = (v) => (isMissingValue(v) ? "" : String(v ?? "").trim());

/** 城市名归一化：去「市」后缀再比较（R10：台账里「杭州」与「杭州市」并存，筛选会漏）。 */
export const normCity = (v) => String(v ?? "").trim().replace(/市$/, "").toLowerCase();

// ════════════════════════════════════════════════════════════════════
// 窗口：last_N_days 截止昨天、不含今天
// ════════════════════════════════════════════════════════════════════
export const WINDOW = {
  EXCLUDE_TODAY: true,
  RULE_TEXT: "`last_N_days` 截止昨天、**不含今天**",
  TODAY_SOURCE: "todayOrderSummary",
  TODAY_RULE_TEXT: "今日单独走 `todayOrderSummary`",
};

// ════════════════════════════════════════════════════════════════════
// 取消率量纲：边界层是 0-1 小数，VM 窗口层是 0-100 百分数
// ════════════════════════════════════════════════════════════════════
export const CANCEL_RATE = {
  /** `data/raw/income-*.json` 的 windows[].cancelRate / daily[].cancelRate / byPoi.*[].rate */
  BOUNDARY_UNIT: "decimal",
  BOUNDARY_RANGE: [0, 1],
  /** VM 的 `projects[].windows[].cancelRate` 与 `income.windows/daily[].cancelRate`（×100） */
  VM_WINDOW_UNIT: "percent",
  VM_WINDOW_RANGE: [0, 100],
  /** VM 的 `income.byPoiD7/D30[].rate` —— **不转换**，仍是小数 */
  VM_BYPOI_UNIT: "decimal",
  VM_BYPOI_RANGE: [0, 1],
  NOTE:
    "⚠️ 同一份 VM 里 `windows[].cancelRate` 是百分数，而 `income.byPoi*[].rate` 是小数 —— " +
    "消费方必须按字段名区分，模板里 `×100` 只许出现在 `rate` 上。",
};

// ════════════════════════════════════════════════════════════════════
// 曝光：平台总口径，不是逐店求和
// ════════════════════════════════════════════════════════════════════
export const EXPOSURE = {
  MODE: "platform-total",
  /** 窗口值 + 环比 */
  API: "flowAnalysisV5/recentDays/flowTransformation",
  UV_FIELD: "FLOW_POI_EXPOSE_UV",
  PV_FIELD: "FLOW_POI_EXPOSE_PV",
  /** 逐日曲线 */
  CHART_API: "flowTransformationChart",
  /** ⛔ 旧的逐店求和：与平台总曝光**不是同一个度量** */
  MUST_NOT_USE: ["flowPoiExposureRankingV2"],
  /** ⭐ 平台最新可用日是**昨天**（T+1）；标签写「最新日」，不写「今日」 */
  LATEST_DAY_IS_T1: true,
  LABEL: "最新日",
  /**
   * ⭐ 实测对照样本 —— **必须按项目分开**。
   *   原先模板把品牌A的 18,280 / 2,526 硬编码成两个项目通用的说明，
   *   而品牌B那天的 PV 是 17,395 —— 等于在品牌B页面上展示品牌A的数字，违反项目隔离。
   *   品牌B的逐店求和实测值没有留存 → 记 `null`，文案里就不给数字对比（宁可不说，也不编）。
   */
  SAMPLES: {
    quanyi: { date: "2026-09-21", platformPv: 18280, byPoiSumPv: 2526 },
    yifeng: { date: "2026-09-21", platformPv: 17395, byPoiSumPv: null },
  },
};

/** 按项目生成曝光口径说明（含实测倍数，仅在该项目有逐店样本时给出）。 */
export function exposureCaliberText(projectKey, projectLabel) {
  const s = EXPOSURE.SAMPLES[projectKey] ?? null;
  const head =
    `口径 = 流量分析「曝光次数(PV) / 曝光人数(UV)」的<b>平台总计</b>，不是各门店求和。`;
  if (s && s.byPoiSumPv != null && s.platformPv) {
    const times = (s.platformPv / s.byPoiSumPv).toFixed(1);
    return (
      head +
      `（${projectLabel} ${s.date} 实测两者差 ${times} 倍：平台 ${s.platformPv.toLocaleString("en-US")} ` +
      `vs 逐店求和 ${s.byPoiSumPv.toLocaleString("en-US")}，属不同度量，逐店口径已撤下。）`
    );
  }
  if (s && s.platformPv) {
    return head + `（${projectLabel} ${s.date} 平台 PV ${s.platformPv.toLocaleString("en-US")}；逐店求和是另一个度量，口径已撤下。）`;
  }
  return head + `（逐店求和是另一个度量，口径已撤下。）`;
}

// ════════════════════════════════════════════════════════════════════
// 隔离：项目不汇总、平台不可加
// ════════════════════════════════════════════════════════════════════
export const ISOLATION = {
  PROJECTS_ARE_SEPARATE: true,
  PLATFORMS_NOT_ADDITIVE: true,
  PROJECT_NOTE:
    "**项目隔离**：品牌A与品牌B是两个独立项目，各有独立登录态与门店体系，**看板不做汇总、不跨项目相加**。",
  PLATFORM_NOTE:
    "**跨平台口径不可加**：美团「已取消」= orderStatus 9（仅取消）；闪购「流失订单」= 取消 + 全款退，定义更宽。" +
    "两个平台的取消/流失**不能相加**。",
  ANOMALY_NOTE:
    "**异常未营业**：口径为「台账未标注未营业原因 且 线上实际营业状态为未营业」。" +
    "美团侧用门店营业状态接口的真实状态；**闪购侧门店节点接口不返回营业状态**，" +
    "若某条标注来源为「台账」，那是台账人工列，不等于线上实际状态，需人工复核。",
  RECENT_HOUR_NOTE:
    "**近1小时取消**：= 下单时间落在近 1 小时内的订单中状态为已取消的。" +
    "平台无「取消时刻」字段，所以这**不是**「近1小时内发生的取消」，两者在取消有延迟时会不同。",
};

// ════════════════════════════════════════════════════════════════════
// 看板内的告警阈值（原先散落在模板 6 处字面量）
// ════════════════════════════════════════════════════════════════════
export const THRESHOLDS = {
  /** KPI 取消率标红的阈值（百分数） */
  cancelRateDanger: 10,
  /** 取消单三格标红的阈值（百分数） */
  cancelCardBad: 10,
  /** 跨项目告警：取消率高于对方多少倍 */
  cancelRateAlertFactor: 2.5,
  /** 跨项目告警：且自身高于该绝对值（百分数）才报 */
  cancelRateAlertFloor: 8,
  /** 推广占比警示（百分数） */
  promoRatioWarn: 20,
  /** 逐店取消率标红（**小数**，与 byPoi[].rate 同量纲） */
  poiCancelRateBad: 0.2,
  /** 门店表 d7 取消率标红（百分数） */
  storeCancelRateBad: 20,
};

// ════════════════════════════════════════════════════════════════════
// 页面自检块（P5）要跑的断言清单
//   · id 与标签从这里注入 VM，模板按 id 实现求值 —— 两侧靠 id 对齐，
//     并由 assertSpecCoverage() 断言「每个注入的 id 在模板里都有实现」。
// ════════════════════════════════════════════════════════════════════
export const SELF_CHECK_SPECS = [
  { id: "vm-has-no-undefined", label: "VM 内无 undefined/NaN 字面量（全量扫描）" },
  { id: "income-selfcheck-diff-zero", label: "预计收入自校验差 = 0（对齐官方 settleIncome）" },
  { id: "exposure-last-eq-window", label: "曝光曲线末点 == 最新日窗口值（UV 与 PV）" },
  { id: "exposure-latest-is-yesterday", label: "曝光「最新日」≤ 昨天（T+1，不含今天）" },
  { id: "window-cancelrate-range", label: "窗口 cancelRate ∈ [0,100] 且 ≈ cancelCount/orderCount" },
  { id: "poi-rate-decimal", label: "逐店 rate ∈ [0,1]（边界量纲为小数）" },
  { id: "promo-ratio-denominator", label: "推广占比 ≈ 推广消耗 ÷ 预计收入 × 100" },
  { id: "window-end-excludes-today", label: "d7/d30 窗口 end ≤ 昨天（last_N_days 不含今天）" },
  { id: "projects-isolated", label: "项目隔离：两项目独立、无跨项目合计字段" },
  { id: "platforms-not-additive", label: "平台不可加：无把美团与闪购相加的字段" },
  { id: "exposure-caliber-per-project", label: "曝光口径文案按项目给数（不串项目）" },
];

// ════════════════════════════════════════════════════════════════════
// 不变量断言（build 期间 warn + 离线单测 + 页面自检共用同一份 id 语义）
// ════════════════════════════════════════════════════════════════════

/** 上海时区的「昨天」ISO 日期（曝光 T+1、窗口 end 判据都用它）。 */
export function yesterdayIso(now = new Date()) {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000 - 24 * 3600 * 1000);
  return sh.toISOString().slice(0, 10);
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 对整份 VM 跑不变量检查，返回 `[{id, label, ok, detail}]`。
 * 页面自检块（P5）用同样的 id 名称显示，两侧语义一致。
 */
export function checkInvariants(vm, { now = new Date() } = {}) {
  const out = [];
  const push = (id, ok, detail) => {
    const spec = SELF_CHECK_SPECS.find((s) => s.id === id);
    out.push({ id, label: spec?.label ?? id, ok: !!ok, detail: detail ?? "" });
  };
  const yday = yesterdayIso(now);

  // 1. VM 里不得混进 undefined / NaN
  //
  // ⚠️ 这个判据只能命中**字符串里**的 `undefined`/`NaN`：`JSON.stringify` 本来就把
  //    `undefined` 丢掉、把 `NaN` 写成 `null`，所以裸值根本不会出现在序列化文本里。
  //    它真正的价值是抓「`${undefined}` 漏进页面文案」这类事故。
  //    因此**只扫数据与用户可见文案**（projects / notes / caliber），
  //    排除 `selfCheckSpecs` —— 那份断言清单的 label 里本来就写着 "undefined/NaN"（自指，会误报）。
  {
    const s = JSON.stringify({ projectOrder: vm.projectOrder, projects: vm.projects, notes: vm.notes, caliber: vm.caliber });
    const bad = /undefined|NaN/.test(s);
    push("vm-has-no-undefined", !bad, bad ? `数据/文案命中 undefined|NaN（扫描长度 ${s.length}）` : `全量扫描 ${s.length} 字符`);
  }

  const keys = vm.projectOrder ?? [];
  for (const k of keys) {
    const p = vm.projects?.[k] ?? {};
    const inc = p.income ?? {};

    // 2. 自校验差
    {
      const d = inc.selfCheck?.projectedIncomeDiff;
      push("income-selfcheck-diff-zero", d === 0, `[${p.label ?? k}] projectedIncomeDiff=${d}`);
    }

    // 3. 曝光曲线末点 == 最新日窗口
    {
      const ed = p.exposure?.daily ?? [];
      const last = ed[ed.length - 1];
      const w = p.exposure?.windows?.today;
      const ok = !!last && !!w && last.uv === w.uv && last.pv === w.pv;
      push("exposure-last-eq-window", ok,
        `[${p.label ?? k}] 曲线 ${last?.date} UV ${last?.uv}/PV ${last?.pv} vs 窗口 UV ${w?.uv}/PV ${w?.pv}`);
    }

    // 4. 曝光最新日 ≤ 昨天
    {
      const day = p.exposure?.windows?.today?.day ?? null;
      push("exposure-latest-is-yesterday", !!day && day <= yday, `[${p.label ?? k}] 最新日 ${day}，昨天 ${yday}`);
    }

    // 5. 窗口 cancelRate 量纲 + 自洽
    {
      const bad = [];
      for (const w of Object.values(p.windows ?? {})) {
        if (!w || w.cancelRate == null) continue;
        if (w.cancelRate < 0 || w.cancelRate > 100) bad.push(`${w.label} 越界 ${w.cancelRate}`);
        const exp = w.orderCount ? (w.cancelCount / w.orderCount) * 100 : null;
        if (exp != null && Math.abs(w.cancelRate - exp) > 0.01) bad.push(`${w.label} ${w.cancelRate}≠${exp.toFixed(2)}`);
      }
      push("window-cancelrate-range", bad.length === 0, `[${p.label ?? k}] ${bad.join("；") || "全部合规"}`);
    }

    // 6. 逐店 rate 是小数
    {
      const all = [...(inc.byPoiD7 ?? []), ...(inc.byPoiD30 ?? [])];
      const bad = all.filter((x) => num(x.rate) != null && (x.rate < 0 || x.rate > 1));
      push("poi-rate-decimal", bad.length === 0, `[${p.label ?? k}] ${all.length} 条中越界 ${bad.length} 条`);
    }

    // 7. 推广占比分母 = 预计收入
    {
      const bad = [];
      for (const w of Object.values(p.windows ?? {})) {
        if (!w || w.promoRatio == null) continue;
        const exp = w.promoCost != null && w.projectedIncome > 0 ? (w.promoCost / w.projectedIncome) * 100 : null;
        if (exp == null || Math.abs(w.promoRatio - exp) > 0.01) bad.push(`${w.label} ${w.promoRatio}≠${exp?.toFixed(2)}`);
      }
      push("promo-ratio-denominator", bad.length === 0, `[${p.label ?? k}] ${bad.join("；") || "全部合规"}`);
    }

    // 8. 窗口 end 不含今天
    {
      const bad = [];
      for (const wk of ["d7", "d30"]) {
        const w = inc.windows?.[wk];
        if (w?.end && w.end > yday) bad.push(`${w.label} end=${w.end}`);
      }
      push("window-end-excludes-today", bad.length === 0, `[${p.label ?? k}] ${bad.join("；") || `end ≤ ${yday}`}`);
    }
  }

  // 9. 项目隔离
  {
    const ok = keys.length >= 1 && !Object.hasOwn(vm, "total") && !Object.hasOwn(vm, "all") &&
      !Object.hasOwn(vm.projects ?? {}, "total");
    push("projects-isolated", ok, `projectOrder=${JSON.stringify(keys)}，无跨项目合计顶层键`);
  }

  // 10. 平台不可加
  {
    const blob = JSON.stringify(vm);
    const bad = /"combined"|"merged"|"sumBothPlatforms"|"allPlatforms"/.test(blob);
    push("platforms-not-additive", !bad, bad ? "VM 中出现疑似跨平台合计字段" : "未出现跨平台合计字段");
  }

  // 11. 曝光口径文案按项目给数
  {
    const samples = vm.caliber?.exposure?.samplesByProject ?? {};
    const bad = keys.filter((k) => !samples[k] || samples[k].platformPv == null);
    push("exposure-caliber-per-project", bad.length === 0,
      bad.length ? `缺项目曝光样本：${bad.join(", ")}` : `样本项目 ${Object.keys(samples).join(", ")}`);
  }

  return out;
}

/**
 * 断言「注入给页面的每个自检 id，模板侧都有实现」。
 * 防止 caliber.mjs 加了断言、页面忘了写，自检块静默少一条。
 */
export function assertSpecCoverage(appJs, specs = SELF_CHECK_SPECS) {
  const missing = specs.filter((s) => !appJs.includes(`"${s.id}"`) && !appJs.includes(`'${s.id}'`));
  return { ok: missing.length === 0, missing: missing.map((s) => s.id) };
}

/**
 * ⭐ 图表「窗口 → 时间维度」映射（2026-09-22 经营者要求：四个图表跟随窗口切换器）。
 *
 * ⚠️ 为什么不是所有板块都能给小时维度 —— 因为**平台的数据粒度根本不同**：
 *   · 收入 / 取消率 → 逐单带 `order_time`，**小时是我们自己分桶算的**（见 fetch-meituan-today.mjs），
 *     所以「今日」「昨日」都能给小时曲线；
 *   · 推广 / 曝光   → 平台只有**日粒度**且 T+1（推广报表次日生成、曝光平台按天结算），
 *     **没有任何小时数据**，今日/昨日窗口下只能退化成「临近趋势 + 标出所选日」。
 *   这条差异必须写在页面上，不能拿日级图冒充小时图。
 */
export const WINDOW_SERIES = {
  today: { tag: "今日 · 逐小时", dim: "hour" },
  yesterday: { tag: "昨日 · 逐小时", dim: "hour" },
  d7: { tag: "近 7 天 · 逐日", dim: "day" },
  d30: { tag: "近 30 天 · 逐日", dim: "day" },
};

/** 只有日粒度的板块（推广 / 曝光）在「今日 / 昨日」窗口下的降级说明。
 *  ⚠️ 纯文本，不带 markdown —— 它渲染在副标题里，那里不做 md 转换。 */
export const DAILY_ONLY_NOTE =
  "平台为 T+1 日粒度，无小时数据 —— 曲线为最近 7 天逐日，虚线标出所选日。";

/**
 * ⭐ 平台维度（2026-09-22 经营者要求：支持切换 全部平台 / 美团 / 闪购，默认全部平台）。
 *
 * ⛔⛔ **「全部平台」绝不等于把两个平台相加** —— 本项目铁律：
 *   美团「已取消」= orderStatus 9（仅取消）；闪购「流失订单」= 取消 + 全款退，定义更宽；
 *   且两平台门店集合不同（136 vs 307）。相加会造出一个**没有任何平台含义**的数字。
 *   ⇒ 全部平台 = **分栏并列**，不是合计。
 *
 * ⚠️ 更硬的现实：**四个趋势图只有美团有时间序列**。
 *   美团：收入/取消 30 天逐日 + 今日/昨日逐小时；曝光 30 天逐日；推广报表 + 首页实时。
 *   闪购：**只有一份近 7 天窗口的聚合**（`taobao-stores-detail-<账号>.json` 的 `kpi`），
 *        没有逐日、没有逐小时、没有曝光、没有推广。
 *   ⇒ 所以在「闪购」视图下，四个趋势板块**如实降级**：有聚合值的显示聚合值并标注口径，
 *     没接的写明「未接入」。**绝不能拿美团的曲线冒充闪购，也不能拿日级冒充小时级。**
 */
export const PLATFORM_DEFS = [
  { key: "all", label: "全部平台" },
  { key: "meituan", label: "美团" },
  { key: "shangou", label: "闪购" },
];
export const PLATFORM_DEFAULT = "all";

/** 平台维度的口径说明（进入 notes，页面必须写明不可相加）。
 *  ⭐ R20（09-24）：闪购自 2026-09-23 起已有完整序列（② 族 MDA），顶部 KPI 七卡随平台切换。
 *  ⭐ R21（同日，经营者指示）：**「全部平台」KPI 七卡 = 美团 + 闪购 合计**（取代并列展示）——
 *  取消单 = 美团取消单 + 闪购流失单（等同处理）；占比 = 消耗合计÷收入合计；ROI = 1÷占比。
 *  ⭐ R22（同日）：**四个趋势板块在「全部平台」下同样按合计口径**（预计收入 / 取消率 / 推广与 ROI /
 *  曝光人数；曝光次数暂仅美团——闪购无逐日 PV）。合计口径仅用于「全部平台」视图。 */
export const PLATFORM_NOTE =
  "**平台维度**：看板可按 全部平台 / 美团 / 闪购 切换。" +
  "⭐ R21/R22（2026-09-24 经营者指示）：**「全部平台」= 美团 + 闪购 合计** —— " +
  "KPI 七卡与四个趋势板块均按合计口径：" +
  "取消单 = 美团取消单 + 闪购流失单；推广 = 美团推广 + 闪购推广（闪购侧分品牌：品牌A=o2o 全站推广、品牌B=斗金）；" +
  "ROI = 1 ÷ 推广占比；曝光人数 = 美团 + 闪购（曝光次数暂仅美团——闪购无逐日 PV）。" +
  "闪购视图 = 闪购口径，美团视图 = 美团口径，两视图下仍不可相加。";

export const SHANGOU_NO_SERIES_NOTE =
  "闪购后台未提供逐日 / 逐小时时间序列（现有数据仅一份「近 7 天」窗口聚合），故本板块无法画趋势曲线。";

export const SHANGOU_NO_PROMO_NOTE =
  "闪购推广数据未取到。取数走斗金 BP 通路（fetch-taobao-promo.mjs，纯 Node），" +
  "需要调试浏览器 profile 里已有 .ele.me 域 cookie（先在调试浏览器里开过闪购后台才有）。";

/** ⭐ 2026-09-23（二次指示 + 第七棒 v3 页面驱动）：闪购推广 = **全部形式的推广消耗**。
 *  数据源 = 壳内「全站推广」页 Wholepromotion（eleAllSiteChain 页面原生请求响应拦截）；
 *  纯 Node 直调 BP 网关（eleChain 数据页）当日全空且被限流，已弃用。
 *  ⭐ R15（2026-09-24）：品牌A = 品牌Ao2o 供应商（单账号，镜像子账号不再求和）；品牌B = 单账号。 */
export const TB_PROMO_NOTE =
  "**闪购推广口径**：数据来自壳内「全站推广」页（eleAllSiteChain，页面原生请求拦截），**全部形式的推广消耗**；" +
  "⭐ R15（2026-09-24）：品牌A = **品牌Ao2o 供应商（单账号）**，镜像子账号（镜像子账号）不再求和（其本身无投放）；" +
  "品牌B = 单账号。" +
  "今日为 T+0 实时；近7天/近30天到昨天。" +
  "⭐ R16（2026-09-24）：闪购 ROI 改**本看板现算**，⭐ R19（同日）：**两品牌口径不同，必须区分** —— " +
  "品牌A ROI = **「眼镜店」总账号预计收入 ÷ 「品牌A（o2o）」全站推广消耗**；" +
  "品牌B ROI = **「品牌B」预计收入 ÷ 「品牌B」斗金推广消耗**" +
  "（收入均以登录节点身份取自 MDA ② 族；取数失败不展示 ROI）。" +
  "⛔ 与美团推广口径不同，**不可相加**。";
/**
 * ⭐ R18（2026-09-24）：页面上卡片说明区的**短口径**（一行）——
 *   TB_PROMO_NOTE 是口径文档全文，塞进页面说明区会把卡片撑到 8 行（真实事故），
 *   页面统一只展示这句短口径；完整口径仍保存在 caliber 与 HANDOVER。
 *   ⭐ R19（2026-09-24）：ROI 部分区分两品牌口径（经营者强调品牌A/品牌B公式不同）。
 *   ⚠️ 仍受 R18 约束：说明区固定两行（.sub min-height 38px + line-clamp 2），
 *   本句加前后缀后不得超出两行，否则会被省略号截断 —— 加字前先数一行容量。
 */
export const TB_PROMO_SHORT =
  "口径：品牌A=品牌Ao2o全站推广；品牌B=斗金推广；ROI（本看板算）品牌A=眼镜店收入÷o2o消耗、品牌B=品牌B收入÷斗金消耗";

/** ⭐ R20（2026-09-24）：闪购 KPI 七卡的口径短语（页面只读，不硬编码）。
 *  数据层 = `taobao.kpiWindows`（与美团 out.windows 同构，口径见 dashboard-model.mjs R20 注释）。 */
export const TB_KPI_NOTES = {
  incomeShort: "闪购 MDA 预计收入（今日 T+0；品牌A=o2o+镜像整树，品牌B=单账号）",
  orderFoot: "有效订单（闪购口径）",
  avgFoot: "预计收入 ÷ 有效订单",
  cancelFootSuffix: "（流失 ≠ 美团取消单）",
  promoLiveShort: "推广 T+0 实时",
  noPromoNote: "该窗口无闪购推广数据",
  promoRatioFoot: "推广消耗 ÷ 预计收入（闪购口径，与美团不同，不可相加）",
  roiFoot: "预计收入 ÷ 推广消耗（品牌A分母=o2o 全站推广；品牌B分母=斗金推广）",
  noDataNote: "闪购该窗口无 KPI 数据（未取到 MDA / 推广数据）",
};

/** ⭐ R21（2026-09-24 经营者指示）：「全部平台」KPI 七卡 = 美团 + 闪购 **合计**的口径短语。
 *  数据层 = `kpiAll`（与美团 out.windows 同构，口径见 dashboard-model.mjs R21 注释）。
 *  ⚠️ 这是经营者明确指定的管理口径：取消单 = 美团取消单 + 闪购流失订单（等同处理）。 */
export const KPI_ALL_NOTES = {
  incomeShort: "美团预计收入 + 闪购预计收入 合计",
  /** ⭐ R21b（2026-09-24 经营者指示）：订单数卡改「有效订单数」 */
  orderFoot: "美团有效订单数 + 闪购有效订单",
  cancelFoot: "（美团取消单 + 闪购流失单）÷ 合计订单数",
  avgFoot: "（美团+闪购预计收入）÷（美团+闪购有效订单）",
  promoCostFoot: "美团推广 + 闪购推广（品牌A=o2o 全站推广；品牌B=斗金）",
  promoRatioFoot: "推广消耗合计 ÷ 预计收入合计",
  roiFoot: "1 ÷ 推广占比（= 预计收入合计 ÷ 推广消耗合计）",
  noDataNote: "该窗口无合计 KPI 数据",
};

/** ⭐ R22（2026-09-24 经营者指示）：四个趋势板块在「全部平台」下的合计口径短语。 */
export const TREND_ALL_NOTES = {
  income: "全部平台 = 美团 + 闪购 预计收入合计（按时间对齐求和）",
  cancel: "取消单 = 美团取消 + 闪购流失；取消率 = 合计取消 ÷ 合计订单",
  /** ⭐ R22b：今日有双平台分时（美团实时+闪购诊断卡）可对齐求和；昨日闪购无分时消耗才退化 */
  promoHourTodayNote: "分时 = 美团实时分时 + 闪购今日诊断分时（按小时对齐求和）",
  promoHourNote: "全部平台无合计分时（闪购缺昨日分时消耗），按最近 7 天逐日展示",
  promo: "推广消耗 = 美团 + 闪购（品牌A=o2o 全站推广；品牌B=斗金）",
  roi: "ROI = 收入合计 ÷ 消耗合计",
  expo: "曝光人数 = 美团 + 闪购合计；曝光次数仅美团（闪购无逐日 PV）",
};

export const SHANGOU_NO_EXPOSURE_NOTE =
  "闪购曝光 / 流量分析接口本项目未接入（MDA 有流量接口，但尚未取数标定）。";

export const PLATFORM_ALL_NOTE =
  "图中为**美团**曲线。闪购无逐日数据、且两平台口径不同**不可叠加**，故此图不合并闪购。";

/** 装配注入给看板的 `VM.caliber`。 */
export function buildCaliber(vm) {
  const labelByProject = Object.fromEntries((vm.projectOrder ?? []).map((k) => [k, vm.projects?.[k]?.label ?? k]));
  const sourceByProject = Object.fromEntries((vm.projectOrder ?? []).map((k) => [k, vm.projects?.[k]?.income?.source ?? null]));
  return {
    income: {
      primaryField: INCOME.PRIMARY_FIELD,
      dailyField: INCOME.DAILY_FIELD,
      mustNotUse: INCOME.MUST_NOT_USE,
      algoBySource: INCOME_ALGO,
      algoUnknown: INCOME_ALGO_UNKNOWN,
      sourceByProject,
      shortBySource: Object.fromEntries(
        [...new Set(Object.values(sourceByProject))].map((s) => [s ?? "null", incomeCaliberShort(s)]),
      ),
    },
    promo: {
      formulaText: PROMO.FORMULA_TEXT,
      denominator: PROMO.DENOMINATOR,
      mustNotUse: PROMO.MUST_NOT_USE,
      costDivisor: PROMO.COST_DIVISOR,
      unavailableNote: PROMO_UNAVAILABLE_NOTE,
      /** ⭐ 2026-09-22：今日走首页实时口径；⭐ R13：ROI 口径改本看板计算，页面据此标注公式 */
      liveShort: PROMO.LIVE_SHORT,
      liveNote: PROMO_LIVE_NOTE,
      roiNote: PROMO_ROI_NOTE,
      t1Note: PROMO_T1_NOTE,
    },
    window: { excludeToday: WINDOW.EXCLUDE_TODAY, ruleText: WINDOW.RULE_TEXT, todayRuleText: WINDOW.TODAY_RULE_TEXT },
    cancelRate: CANCEL_RATE,
    exposure: {
      mode: EXPOSURE.MODE,
      api: EXPOSURE.API,
      chartApi: EXPOSURE.CHART_API,
      mustNotUse: EXPOSURE.MUST_NOT_USE,
      latestDayIsT1: EXPOSURE.LATEST_DAY_IS_T1,
      label: EXPOSURE.LABEL,
      samplesByProject: EXPOSURE.SAMPLES,
      textByProject: Object.fromEntries(
        (vm.projectOrder ?? []).map((k) => [k, exposureCaliberText(k, labelByProject[k])]),
      ),
    },
    isolation: ISOLATION,
    windowDefs: WINDOW_DEFS,
    kaLabelToKey: KA_LABEL_TO_KEY,
    /** ⭐ 图表跟随窗口：窗口 → 时间维度标签（模板只读，不再写死「近 30 天 · 逐日」）。 */
    windowSeries: WINDOW_SERIES,
    dailyOnlyNote: DAILY_ONLY_NOTE,
    /** ⭐ 平台维度（全部平台 / 美团 / 闪购）—— 模板只读，不写死标签与降级文案。 */
    platformDefs: PLATFORM_DEFS,
    platformDefault: PLATFORM_DEFAULT,
    platformNotes: {
      general: PLATFORM_NOTE,
      allNoSum: PLATFORM_ALL_NOTE,
      shangouNoSeries: SHANGOU_NO_SERIES_NOTE,
      shangouNoPromo: SHANGOU_NO_PROMO_NOTE,
      shangouNoExposure: SHANGOU_NO_EXPOSURE_NOTE,
      tbPromo: TB_PROMO_NOTE,
      tbPromoShort: TB_PROMO_SHORT,
    },
    /** ⭐ R20：闪购 KPI 七卡口径短语（顶部卡片随平台切换到「闪购」时使用） */
    tbKpi: TB_KPI_NOTES,
    /** ⭐ R21：「全部平台」= 美团 + 闪购 合计的 KPI 口径短语 */
    kpiAll: KPI_ALL_NOTES,
    /** ⭐ R22：四个趋势板块「全部平台」合计口径短语 */
    trendAll: TREND_ALL_NOTES,
  };
}
