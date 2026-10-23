/**
 * 数据源清单 + 「每个源现在有多旧」的唯一计算入口。
 *
 * 为什么要独立成模块（2026-10-21）：
 *   这套 CADENCE 表原来只存在于 src/freshness.mjs 里，而 freshness 是**纯打印脚本** ——
 *   它不返回任何机器可读的东西，也不 exit 非 0，所以没有任何自动化能消费它。
 *   结果是：品牌B的美团链路连续 7 天全步骤失败、data/raw 里的 5 个文件停在
 *   2026-10-14 08:30，但看板照常渲染、没有任何地方报警。
 *   现在把「源→原生粒度→告警阈值→当前年龄」抽成纯函数，freshness（人看）与
 *   check-gate（机器判定）共用同一份口径，避免两边漂移。
 *
 * ⚠️ 阈值都是「该刷了」的提醒，不是「坏了」的判定。真正的故障判定看
 *    _recon/state/<account>/<step>.json 的 exitCode —— 两者互补，不可互相替代。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 每个数据源的原生粒度与建议刷新间隔（小时）。新增数据源必须在这里登记，否则不会被闸门看到。 */
export const CADENCE = {
  income: {
    label: "美团预计收入（窗口+逐日+逐店）",
    native: "平台窗口截止昨天；今日走官方实时汇总",
    warn: 12,
  },
  "income-orderlist": {
    label: "逐单基准（对账用，非看板数据）",
    native: "只在做口径对账时才需要重跑",
    warn: 72,
  },
  today: {
    label: "今日实时（逐小时 + 近1小时取消）",
    native: "实时 —— 越勤刷越准",
    warn: 2,
    /**
     * ⭐ neverFail（2026-10-21 补）：过期只提醒「数字不够新」，**永不判故障**。
     *
     * 原因是调度与粒度的矛盾：`today` 是实时数据，阈值 2h 是合理的提醒；但
     * R25（2026-09-28）已把定时任务改成**每天 08:30 一次**。于是每天 14:31 之后
     * 它必然涨到 3 倍以上，闸门就会**每天固定报一次 FAIL** —— 一个永远消不掉的
     * 红点，比不报更糟（人会直接学会忽略）。
     *
     * 真正的故障判定不靠这里：步骤挂了会由 `_recon/state` 的 consecutiveFailures
     * 立刻报（见模块头的分工说明）。所以这里只留 WARN，提示「下午的数字可能不是最新」。
     */
    neverFail: true,
  },
  meituan: {
    label: "美团门店清单 + 六大板块 + 营业状态",
    native: "营业状态近实时；板块指标 T+1",
    warn: 12,
  },
  exposure: {
    label: "门店曝光（逐店）",
    native: "T+1（数据日期 = 昨天）",
    warn: 24,
  },
  ka: {
    label: "推广消耗 / ROI",
    native: "T+1（今日恒 0，不是停投）",
    warn: 24,
  },
  taobao: {
    label: "淘宝闪购门店清单",
    native: "日级",
    warn: 24,
  },
  "taobao-stores-detail": {
    label: "淘宝闪购门店经营明细",
    native: "日级",
    warn: 24,
  },
  // 以下三项在原 CADENCE 表里缺失（但只要 fetch 成功就会写文件），
  // 导致它们过期时闸门完全看不见。阈值按「日级」推断，实测后按需调整。
  "taobao-promo": {
    label: "淘宝闪购推广（promo）",
    native: "日级（需浏览器 profile 里 .ele.me cookie）",
    warn: 24,
  },
  "taobao-mda": {
    label: "淘宝闪购 MDA 门户",
    native: "日级（依赖 promo 续签的 _m_h5_tk）",
    warn: 24,
  },
  "taobao-stats": {
    label: "淘宝闪购统计",
    native: "日级",
    warn: 24,
  },
};

/** 旧命名的孤儿文件（不参与看板），只在报告末尾提示。 */
export const ORPHANS = new Set(["meituan.json", "taobao.json", "ka.json", "taobao-stores-detail.json"]);

export const ACCOUNTS = [
  { key: "quanyi", label: "品牌A" },
  { key: "yifeng", label: "品牌B" },
];

const hours = (ms) => ms / 3600000;

/** 从原始文件里尽量取出它自称的「数据日期 / 来源」等，用于人读的报告。 */
export function dataDateOf(rawDir, file) {
  try {
    const j = JSON.parse(readFileSync(join(rawDir, file), "utf8"));
    const bits = [];
    if (j.dataDates) bits.push(`数据日期 ${[].concat(j.dataDates).join(",")}`);
    if (j.dataDate) bits.push(`数据日期 ${j.dataDate}`);
    if (j.window) bits.push(`窗口 ${typeof j.window === "object" ? JSON.stringify(j.window) : j.window}`);
    if (j.source) bits.push(`来源 ${j.source}`);
    if (j.selfCheck?.projectedIncomeDiff !== undefined) bits.push(`自校验差 ${j.selfCheck.projectedIncomeDiff}`);
    return bits.join(" · ");
  } catch {
    return "";
  }
}

/**
 * 扫描 rawDir，返回每个账号 × 每个数据源的年龄。
 *
 * 取时间的优先级：文件内 `fetchedAt` > 文件 mtime。
 * 为什么优先 fetchedAt：进程崩在 rename 之前、或有人手工复制旧文件覆盖时，
 * mtime 会显得很新而数据其实是旧的 —— 这正是「旧覆盖新」要防的情况。
 *
 * @returns {{accounts: Array<{key,label,sources:Array}>, orphans: Array, byName: Map<string, object>}}
 */
export function surveySources(rawDir, { now = Date.now(), warnOverride = null } = {}) {
  let files = [];
  try {
    files = readdirSync(rawDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    const e = new Error(`读不到 ${rawDir}`);
    e.code = "RAW_DIR_MISSING";
    throw e;
  }

  const byName = new Map();
  const accounts = ACCOUNTS.map((acct) => {
    const sources = Object.entries(CADENCE).map(([stem, c]) => {
      const file = `${stem}-${acct.key}.json`;
      const full = join(rawDir, file);
      const warn = warnOverride ?? c.warn;

      if (!existsSync(full)) {
        const row = { stem, file, label: c.label, native: c.native, warn, neverFail: c.neverFail === true, missing: true, age: null, stale: true };
        byName.set(file, row);
        return row;
      }

      const st = statSync(full);
      let fetchedAt = null;
      try {
        fetchedAt = JSON.parse(readFileSync(full, "utf8")).fetchedAt ?? null;
      } catch {
        /* 文件损坏时退回 mtime，并标记 unreadable，让上层能区分「旧」和「坏」 */
      }
      const t = fetchedAt ? new Date(fetchedAt) : st.mtime;
      const age = hours(now - t.getTime());

      const row = {
        stem,
        file,
        label: c.label,
        native: c.native,
        warn,
        neverFail: c.neverFail === true,
        missing: false,
        unreadable: fetchedAt === null,
        age,
        ageText: fmtAge(age),
        timestamp: t.toISOString(),
        timestampSource: fetchedAt ? "fetchedAt" : "mtime",
        stale: age > warn,
        detail: dataDateOf(rawDir, file),
      };
      byName.set(file, row);
      return row;
    });
    return { ...acct, sources };
  });

  const orphans = files
    .filter((f) => ORPHANS.has(f))
    .map((f) => ({ file: f, age: hours(now - statSync(join(rawDir, f)).mtimeMs) }));

  return { accounts, orphans, byName };
}

export function fmtAge(h) {
  if (h === null || h === undefined) return "—";
  return h < 1 ? `${Math.round(h * 60)} 分钟` : h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`;
}

/** 汇总：整份清单里有多少项过期 / 缺失，以及最严重的那一项。 */
export function summarize(result) {
  const all = result.accounts.flatMap((a) => a.sources.map((s) => ({ ...s, account: a.key, accountLabel: a.label })));
  const stale = all.filter((s) => !s.missing && s.stale);
  const missing = all.filter((s) => s.missing);
  const worst = stale
    .slice()
    .sort((a, b) => b.age - a.age)[0] ?? null;

  return { all, stale, missing, worst, ok: stale.length === 0 && missing.length === 0 };
}
