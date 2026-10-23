/**
 * 播报**轻指标**纯函数层：从已装配好的看板 VM 里挑出「值得进群播报」的少数几个数。
 *
 *   pickMiniMetrics(vm, projectKey, winKey) → { project, window, metrics:{...}, notes:{...} }
 *
 * 为什么单独一层（待办 ③）：
 *   BalanceAlert 的群播报现在只有「推广余额」。经营者要的是**余额 + 今日经营**同一条消息，
 *   但群消息不能变成长报表 —— 所以只挑 4 个 + 口径脚注，其余一律不进播报。
 *
 * ⛔ 硬约束（违反即错，全部在本文件里加固）：
 *   1. **不包含成交额**。收入一律取 `kpiAll[win].projectedIncome`（美团 = multiProjectedIncome 平台聚合，
 *      闪购 = expectIncome），`multiDealAmount` 列在 `caliber.INCOME.MUST_NOT_USE` 里，**不得出现在产物中**。
 *      「不出现」是两条保证合起来给的：① 本文件只白名单挑字段（绝不透传 kpiAll 整对象）；
 *      ② 导出壳写盘前再扫一遍 `MUST_NOT_USE` 的字段名，命中就抛错。
 *   2. **旧数据必须带日期戳，且不出环比**。`kpiAll` 是「美团 ∪ 闪购」的合计，某些窗口只到昨天
 *      （income.windows 里 d7/d30 通常为空，退化成 income.daily 的最近 7/30 天）。
 *      如果播报里写「今日 ¥291」，实际却是昨天的数，人就会照这个数去判断今天要不要加推广。
 *      所以每个指标都带自己的 `dataDate`，并且导出的 `stale` 由导出壳按「北京时间今天」现算
 *      —— 本文件**不碰时钟**，保证纯函数可离线单测（与 dashboard-model.mjs 同一分工）。
 *   3. **绝不拿两个不同日期的数算环比/环比率**。本层不输出任何 chainRatio 字段。
 *
 * 本文件只做纯计算：不读文件、不写文件、不碰 CDP、不碰 process.argv、不读当前时间。
 *
 * 口径文案一律来自 `caliber.KPI_ALL_NOTES`（单一真相源）——这里不写死任何口径句子，
 * 否则口径一改、播报没跟，又是一次「同一条消息里两套说法」。
 */
import { INCOME, KPI_ALL_NOTES, PROJECTS, WINDOW_DEFS } from "./caliber.mjs";

/** 播报用的四个指标：key → 取值字段（白名单，永不透传 kpiAll 整对象） */
export const MINI_METRIC_FIELDS = {
  projectedIncome: "projectedIncome",
  validOrderCount: "validOrderCount",
  cancelRate: "cancelRate",
  promoCost: "promoCost",
};

/** 每个指标对应的口径脚注（全部取自 KPI_ALL_NOTES） */
export const MINI_METRIC_FOOTNOTES = {
  projectedIncome: KPI_ALL_NOTES.incomeShort,
  validOrderCount: KPI_ALL_NOTES.orderFoot,
  cancelRate: KPI_ALL_NOTES.cancelFoot,
  promoCost: KPI_ALL_NOTES.promoCostFoot,
};

/** 指标展示名（播报里的小标题用） */
export const MINI_METRIC_LABELS = {
  projectedIncome: "预计收入",
  validOrderCount: "有效订单",
  cancelRate: "取消率",
  promoCost: "推广消耗",
};

/** 与 dashboard-model.mjs 里 `sum` 同语义：两侧都缺才是 null，否则按可得侧求和（不编数） */
const sumOrNull = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

/**
 * 逐日切片求和（与看板窗口逻辑一致：取「含 endDate 且往前 span 个自然日」的切片，
 * 该切片里一个点都没有 → 一个字段都不给，宁可没有也不拿别的区间充数）。
 *
 * @param {{today:string|null, daily:Array<{date:string}>}} side 某一侧的逐日数据
 * @param {number} span 天数
 * @returns {{start:string|null, end:string|null, n:number, sum:(f:string)=>number|null}}
 */
function dailySlice(side, span) {
  const daily = (side?.daily ?? []).filter((r) => r && typeof r.date === "string");
  const end = typeof side?.today === "string" ? side.today : null;
  if (!daily.length || !end) return { start: null, end: null, n: 0, sum: () => null };
  const keep = new Set();
  for (let i = 0; i < span; i += 1) keep.add(shiftDate(end, -i));
  const rows = daily
    .filter((r) => keep.has(r.date))
    .sort((a, b) => String(a.date).localeCompare(String(b.date))); // 不依赖上游顺序
  return {
    start: rows.length ? rows[0].date : null,
    end: rows.length ? rows[rows.length - 1].date : null,
    n: rows.length,
    sum: (f) => (rows.length ? rows.reduce((s, r) => s + (typeof r[f] === "number" ? r[f] : 0), 0) : null),
  };
}

/** `YYYY-MM-DD` 平移 n 天（只看日期字符串，按 UTC 算，避免本机时区把日期挪一天） */
export function shiftDate(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 逐日派生指标（与 `kpiAll` **同一套公式**，见 dashboard-model.mjs R21）：
 *   取消率 = 取消单 ÷ 合计订单 ×100（百分数，不是小数）
 *   客单价 = 收入 ÷ 有效订单
 *   推广占比 = 消耗 ÷ 收入 ×100；ROI = 收入 ÷ 消耗
 */
function deriveFromDaily({ income, orderCount, validOrderCount, cancelCount, promoCost }) {
  return {
    projectedIncome: r2(income),
    validOrderCount: validOrderCount,
    cancelRate: cancelCount != null && orderCount ? r2((cancelCount / orderCount) * 100) : null,
    promoCost: r2(promoCost),
    promoRatio: income != null && income > 0 && promoCost != null ? r2((promoCost / income) * 100) : null,
    promoRoi: promoCost != null && promoCost > 0 && income != null ? r2(income / promoCost) : null,
  };
}

/** 两位小数的数值规整；缺值保持 null（⛔ 绝不把 null 变成 0） */
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** 从 VM 里取某一侧（美团 / 闪购）的逐日序列 —— 只读已装配好的结构，不碰原始 JSON */
function sideFromVm(vm, projectKey) {
  const p = vm?.projects?.[projectKey];
  if (!p) return null;
  /** VM 里根本没有这个 key（测试样例 / 裁剪过的 VM）→ 视作「该侧没有逐日数据」。
   *  ⚠️ 不能默认 {} —— 否则「没有逐日序列」会被当成「序列存在但为空」，两者下游处理不同。 */
  if (!p.income) return null;
  const mt = p.income.daily ?? [];
  const tb = p.taobao?.mda?.daily ?? null;
  /** 闪购 MDA 点集 → date→value 的 Map（逐日稀疏，逐行 find 是 O(n²)） */
  const pts = (fam) => new Map(((tb?.[fam]?.points) ?? []).map((x) => [x.date, x.value]));
  const P_VALID = pts("valid_order_cnt");
  const P_INVALID = pts("invalidOrderNum");
  const P_INCOME = pts("expect_income");
  return {
    today: p.today?.date ?? null,
    daily: mt.map((r) => {
      const date = r.date;
      const tbValid = P_VALID.get(date) ?? null;
      const tbInvalid = P_INVALID.get(date) ?? null;
      const tbIncome = P_INCOME.get(date) ?? null;
      return {
        date,
        income: sumOrNull(r.projectedIncome ?? null, tbIncome),
        orderCount: sumOrNull(r.orderCount ?? null, tbValid),
        validOrderCount: sumOrNull(r.validOrderCount ?? null, tbValid),
        cancelCount: sumOrNull(r.cancelCount ?? null, tbInvalid),
        // ⚠️ 这里**只**读 promo cost：闪购 promo 逐日行常为空（页面驱动），缺就是 null，不拿别的充数
        promoCost: null,
      };
    }),
  };
}

/**
 * 挑出播报用的轻指标（纯函数）。
 *
 * @param {object} vm           buildDashboardVm() 的产物（必须有 `kpiAll`）
 * @param {string} projectKey   "quanyi" | "yifeng"
 * @param {string} winKey       "today" | "yesterday" | "d7" | "d30"
 * @returns {{
 *   project:{key:string,label:string},
 *   window:{key:string,label:string},
 *   metrics:Record<string, {
 *     key:string, label:string, value:number|null,
 *     dataDate:string|null, dataEnd:string|null, basis:string, foot:string
 *   }>,
 *   extras:{promoRatio:number|null, promoRoi:number|null, promoRatioFoot:string, promoRoiFoot:string},
 *   noData:boolean
 * }}
 */
export function pickMiniMetrics(vm, projectKey, winKey) {
  const meta = PROJECTS.find((p) => p.key === projectKey);
  if (!meta) throw new Error(`未知项目：${projectKey}（可选 ${PROJECTS.map((p) => p.key).join(" / ")}）`);
  const win = WINDOW_DEFS.find((w) => w.key === winKey);
  if (!win) throw new Error(`未知窗口：${winKey}（可选 ${WINDOW_DEFS.map((w) => w.key).join(" / ")}）`);

  /**
   * ⚠️ `kpiAll` 挂在**每个项目**的模型上（`buildProjectModel` 里装配，dashboard-model.mjs 约 803 行），
   *    **不在** `buildDashboardVm()` 返回值的顶层。VM 的结构是 `vm.projects[key] = 项目模型`，
   *    所以这里从项目模型上取 —— 别写成 `vm.kpiAll`，那会静默全 null（实测踩过）。
   *    也正因如此，「项目没这个 key → 没有 kpiAll」天然隔离了两个项目，不会互相串数。
   */
  const p = vm?.projects?.[projectKey] ?? null;
  const k = p?.kpiAll?.[winKey] ?? null;
  const side = sideFromVm(vm, projectKey);

  /**
   * 「今日 / 昨日」的 `kpiAll` 是**单日**窗口 → dataDate 就是那一天。
   * d7 / d30 是**区间** → dataDate 给「最后一天」（= 最新），dataEnd 给区间跨度；
   * 播报侧必须按区间措辞，不能写成「今日」。
   */
  let basis = "single";
  let dataDate = null;
  let dataEnd = null;
  let derived = null;

  if (winKey === "today" || winKey === "yesterday") {
    const td = side?.today ?? null;
    dataDate = winKey === "today" ? td : td ? shiftDate(td, -1) : null;
    // 昨日：kpiAll.yesterday 若为 null（income 窗口缺失），退化成逐日第 -1 天
  } else {
    basis = "range";
    const span = winKey === "d7" ? 7 : 30;
    derived = dailySlice(side, span);
    /**
     * ⚠️ 语义分工（踩过）：
     *   `dataEnd` = 区间**统计上界**（= 数据日 today，即使最后一天还没数据），
     *   `dataDate` = 区间里**实际有数的最新一天**（可能比上界旧）。
     *   播报写「10-16 ~ 10-22」时用的是上界；判断陈旧用 dataDate。
     */
    dataEnd = side?.today ?? null;
    dataDate = derived.end ?? dataEnd;
  }

  /**
   * ⚠️ 「这个数属于什么时候」必须先能回答，才允许把数报出去（硬约束 2 的落地方式）：
   *    项目没有逐日序列（side=null）或算不出 dataDate → 该窗口**一个数都不给**。
   *    理由：说不出日期的数等于没日期戳的旧数 —— 那正是「拿今天 ¥291 对昨天 ¥2530
   *    算出假告警」的起点。宁可播报里少这一块，也不给无日期的数。
   */
  const dated = dataDate != null;

  const value = (f) => {
    if (!dated) return null;
    if (k && k[f] != null) return k[f];
    // 窗口值缺失 → 只有区间窗口才用逐日切片现算（与 kpiAll 同公式）；单日窗口不给替代值
    if (derived && derived.n > 0) {
      const d = deriveFromDaily({
        income: derived.sum("income"),
        orderCount: derived.sum("orderCount"),
        validOrderCount: derived.sum("validOrderCount"),
        cancelCount: derived.sum("cancelCount"),
        promoCost: null,
      });
      return d[f] ?? null;
    }
    return null;
  };

  const metrics = {};
  for (const [key, field] of Object.entries(MINI_METRIC_FIELDS)) {
    /**
     * ⚠️ 出口统一 `r2` 规整：上游两平台相加会留下浮点尾巴
     *    （实测 `24.67 + 50.82 = 75.49000000000001`）。群里播「75.49000000000001 元」
     *    会显得机器在漏电；而多留的那几位小数对经营判断毫无意义。
     */
    const v = r2(value(field));
    metrics[key] = {
      key,
      label: MINI_METRIC_LABELS[key],
      value: v,
      dataDate: v == null ? null : dataDate,
      dataEnd: v == null ? null : dataEnd,
      basis: v == null ? null : basis,
      foot: MINI_METRIC_FOOTNOTES[key],
    };
  }

  /**
   * ⚠️ 取消率的量纲：`kpiAll.cancelRate` 是**百分数**（`(cancel/orders)*100`，见 dashboard-model R21），
   *    而逐店 `rate` 是**小数**。播报直接显示 `%`，不再乘 100 —— 这里原样透传，由单测钉死。
   */
  const noData = Object.values(metrics).every((m) => m.value == null);

  return {
    project: { key: meta.key, label: meta.label },
    window: { key: win.key, label: win.label },
    metrics,
    extras: {
      promoRatio: k?.promoRatio ?? null,
      promoRoi: k?.promoRoi ?? null,
      promoRatioFoot: KPI_ALL_NOTES.promoRatioFoot,
      promoRoiFoot: KPI_ALL_NOTES.roiFoot,
    },
    noData,
    noDataNote: noData ? KPI_ALL_NOTES.noDataNote : null,
    /** 收入口径的**唯一来源字段名**，写进产物方便人工核对（不是数值） */
    incomeField: INCOME.PRIMARY_FIELD,
  };
}
