/**
 * 把看板 VM 里的**轻指标**导出成 `data/mini-metrics.json`，给播报模块读。
 *
 *   node src/export-mini-metrics.mjs [--data=<dir>] [--out=<file>] [--root=<dir>]
 *
 * 本文件只是**薄壳**（与 build-dashboard.mjs 同一分工）：
 *   读盘映射 → buildProjectModel → buildDashboardVm → pickMiniMetrics → 写盘。
 *   ⛔ 不碰 dashboard.html、不碰模板、不碰浏览器/cookie。
 *
 * 为什么另起一个壳而不是塞进 build-dashboard.mjs：
 *   1. 看板构建失败（模板/echarts 缺）不该连带播报断供，播报失败也不该拖垮看板；
 *   2. 壳里只读**原始 JSON**（data/raw/*），不读 dashboard.html，产物与页面无耦合。
 *
 * ⛔ 写盘前的最后一道闸：`INCOME.MUST_NOT_USE`（含 `multiDealAmount`）出现在产物里就抛错。
 *    正常路径不可能命中（pickMiniMetrics 只白名单挑 4 个字段），这道闸是防以后有人
 *    顺手把 kpiAll 整个塞进来，或把原始行透传出去。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INCOME, PROJECTS } from "./lib/caliber.mjs";
import { buildProjectModel, buildDashboardVm } from "./lib/dashboard-model.mjs";
import { pickMiniMetrics } from "./lib/mini-metrics.mjs";

const arg = (n, d) => {
  const hit = process.argv.find((x) => x.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(arg("root", join(SELF_DIR, "..")));
const DATA_DIR = resolve(arg("data", join(ROOT, "data")));
const OUT = resolve(arg("out", join(DATA_DIR, "mini-metrics.json")));

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** 项目 key 列表可用 `--projects=a,b` 覆盖（默认就是 caliber.PROJECTS） */
const projects = (arg("projects", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const METAS = PROJECTS.filter((p) => (projects.length ? projects.includes(p.key) : true));
if (!METAS.length) {
  console.error(`❌ --projects 里没有匹配的项目：${projects.join(",")}`);
  process.exit(2);
}

// ════════ 读盘（复刻 build-dashboard.mjs 的映射，只多不少）════════
const RAW = (n) => join(DATA_DIR, "raw", n);
const unifiedAll = readJson(join(DATA_DIR, "plan", "stores-unified.json")) ?? [];
const anomaliesAll = readJson(join(DATA_DIR, "plan", "anomalies.json"))?.items ?? [];
const models = METAS.map((meta) =>
  buildProjectModel(meta, {
    unifiedAll,
    anomaliesAll,
    warn: () => {}, // 播报不输出构建告警：stdout 只留结论行（成本纪律）
    files: {
      mt: readJson(RAW(`meituan-${meta.key}.json`)),
      inc: readJson(RAW(`income-${meta.key}.json`)),
      ka: readJson(RAW(`ka-${meta.key}.json`)),
      expo: readJson(RAW(`exposure-${meta.key}.json`)),
      today: readJson(RAW(`today-${meta.key}.json`)),
      tb: readJson(RAW(`taobao-${meta.key}.json`)),
      tbDetail: readJson(RAW(`taobao-stores-detail-${meta.key}.json`)),
      tbStats: readJson(RAW(`taobao-stats-${meta.key}.json`)),
      tbMda: readJson(RAW(`taobao-mda-${meta.key}.json`)),
      tbPromo: readJson(RAW(`taobao-promo-${meta.key}.json`)),
    },
  }),
);

const vm = buildDashboardVm({
  projects: models,
  projectMetas: METAS,
  generatedAt: new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium",
  }).format(new Date()),
});

// ════════ 挑指标 ════════
/** 播报只播「今日」—— 以后要加窗口就在这加一行，不用动看板侧任何代码 */
const WINDOWS = ["today"];
/**
 * 北京时间「今天」：**只在这里**读一次时钟（pickMiniMetrics 本身不碰时间，保证可单测）。
 * 为什么用 Asia/Shanghai 而不是本机时区：本机可能是 UTC，凌晨 0–8 点会差一天，
 * 于是「昨天的数」被当成今天 → 正是硬约束 2 要防的那种假告警。
 */
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

const payload = {
  generatedAt: new Date().toISOString(),
  /** 产物结构版本：播报侧按它判断字段是否齐（不兼容变更就加 1） */
  schema: 1,
  /** 北京时间「今天」，播报侧据此判断数据是否陈旧 */
  today,
  /** 口径真相源：播报侧要展示「不是成交额」的说明时直接引用这里（只是字段名，不是数值） */
  incomeField: INCOME.PRIMARY_FIELD,
  projects: {},
};

for (const meta of METAS) {
  const byWindow = {};
  for (const w of WINDOWS) {
    const m = pickMiniMetrics(vm, meta.key, w);
    /**
     * ⭐ 陈旧判定（硬约束 2）：每个指标的 dataDate 若早于北京时间今天，
     *   就标 stale 并给出「数据截止日」；播报侧遇到 stale **不出环比、明写日期**。
     */
    const metrics = {};
    for (const [k, v] of Object.entries(m.metrics)) {
      metrics[k] = {
        ...v,
        stale: v.dataDate != null && v.dataDate !== today,
      };
    }
    byWindow[w] = {
      label: m.window.label,
      noData: m.noData,
      noDataNote: m.noDataNote,
      metrics,
      extras: m.extras,
    };
  }
  payload.projects[meta.key] = {
    key: meta.key,
    label: meta.label,
    windows: byWindow,
    /** 该项目的**整体数据截止日** = 各指标里最晚的 dataDate（都没有 → null） */
    dataDate: (() => {
      const ds = Object.values(byWindow.today.metrics).map((x) => x.dataDate).filter(Boolean);
      return ds.length ? ds.sort().at(-1) : null;
    })(),
  };
}

// ════════ 闸 + 写盘 ════════
const text = JSON.stringify(payload, null, 2) + "\n";
const hit = INCOME.MUST_NOT_USE.filter((f) => text.includes(f));
if (hit.length) {
  console.error(`❌ 产物里出现了 MUST_NOT_USE 字段：${hit.join("、")} —— 拒绝写盘（收入必须是预计收入，不是成交额）`);
  process.exit(3);
}
mkdirSync(dirname(OUT), { recursive: true });
/** 先写临时文件再改名：播报侧读到的永远是完整文件，不会读到写了一半的 JSON */
const tmp = `${OUT}.tmp`;
writeFileSync(tmp, text, "utf8");
renameSync(tmp, OUT);

const brief = Object.values(payload.projects)
  .map((p) => {
    const m = p.windows.today.metrics;
    const fmt = (x, unit) => (x.value == null ? "—" : `${x.value}${unit}${x.stale ? `(${x.dataDate})` : ""}`);
    return `${p.label} 收入 ${fmt(m.projectedIncome, "")} / 订单 ${fmt(m.validOrderCount, "")} / 取消率 ${fmt(m.cancelRate, "%")} / 推广 ${fmt(m.promoCost, "")}`;
  })
  .join("；");
console.log(`✅ mini-metrics 已落盘  ${OUT}`);
console.log(`   今天(北京时间) ${today} · ${brief}`);
