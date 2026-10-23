/**
 * 数据新鲜度报告：每个数据源「多久没更新了」，以及**它本来能有多新**。
 *   node src/freshness.mjs [--warn-hours=N]
 *
 * 回答的问题：**看板数据是多久更新一次？**
 *   答案分两层，必须分开说，否则会误导：
 *   ① 看板**不会自动更新** —— 没有计划任务，没有任何常驻进程。
 *      所有数据只在**有人触发刷新**时才更新（按钮 / refresh.cmd / 单个 fetch 脚本）。
 *      所以「多久更新一次」实际等于「你多久刷一次」。
 *   ② 平台侧**各数据源的原生粒度不同** —— 即使你刚刷完，有些数也只能到昨天：
 *      · 美团预计收入：平台窗口 `last_N_days` **截止昨天**；今日走官方实时汇总
 *      · 门店曝光：**T+1**（数据日期 = 昨天）
 *      · 推广 ka：**T+1**（今日恒 0，不是没投放）
 *      · 今日实时 / 近1小时取消：**实时**，越勤刷越准
 *   所以本脚本按「原生粒度」给出各自的告警阈值，而不是一个统一数字。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const OVERRIDE = Number(arg("warn-hours", "0")) || null;

/**
 * 每类数据的**原生粒度**与建议刷新间隔（小时）。
 * `warn` = 超过这个时长就值得提醒（不是「坏了」，是「该刷了」）。
 */
const CADENCE = {
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
};

/** 旧命名的孤儿文件（不参与看板），只在末尾提示一次 */
const ORPHANS = new Set(["meituan.json", "taobao.json", "ka.json", "taobao-stores-detail.json"]);

const ACCOUNTS = [
  { key: "quanyi", label: "品牌A" },
  { key: "yifeng", label: "品牌B" },
];

const now = Date.now();
const hours = (ms) => ms / 3600000;
const fmtAge = (h) => (h < 1 ? `${Math.round(h * 60)} 分钟` : h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`);

/** 从任何一份原始文件里尽量取出它自称的「数据日期」 */
function dataDateOf(file) {
  try {
    const j = JSON.parse(readFileSync(join(RAW, file), "utf8"));
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

let files;
try {
  files = readdirSync(RAW).filter((f) => f.endsWith(".json")).sort();
} catch {
  console.error(`读不到 ${RAW}`);
  process.exit(1);
}

console.log("");
console.log("  数据新鲜度报告");
console.log(`  ${new Date().toLocaleString("zh-CN")}`);
console.log("");
console.log("  ⚠️ 前提：**看板不会自动更新**。没有计划任务、没有常驻刷新进程。");
console.log("     所有数据只在有人触发刷新时才变 —— 按钮 / refresh.cmd / 单个 fetch 脚本。");
console.log("");

let stale = 0;
let missing = 0;

for (const acct of ACCOUNTS) {
  console.log(`  ════════ ${acct.label} ════════`);
  const rows = [];
  for (const [stem, c] of Object.entries(CADENCE)) {
    const file = `${stem}-${acct.key}.json`;
    if (!existsSync(join(RAW, file))) { rows.push({ stem, c, file, missing: true }); continue; }
    const st = statSync(join(RAW, file));
    let fetchedAt = null;
    try { fetchedAt = JSON.parse(readFileSync(join(RAW, file), "utf8")).fetchedAt ?? null; } catch { /* ignore */ }
    const t = fetchedAt ? new Date(fetchedAt) : st.mtime;
    rows.push({ stem, c, file, age: hours(now - t), t, detail: dataDateOf(file) });
  }

  for (const r of rows) {
    if (r.missing) {
      missing++;
      console.log(`    ⬜ ${r.c.label.padEnd(30)} 缺文件（${r.file}）`);
      continue;
    }
    const warnAt = OVERRIDE ?? r.c.warn;
    const bad = r.age > warnAt;
    if (bad) stale++;
    const icon = bad ? "🟡" : "✅";
    console.log(`    ${icon} ${r.c.label.padEnd(30)} ${fmtAge(r.age).padStart(9)} 前   （原生：${r.c.native}）`);
    if (r.detail) console.log(`         ${r.detail}`);
    if (bad) console.log(`         ↳ 超过建议间隔 ${warnAt}h，建议刷一次`);
  }
  console.log("");
}

const orphanFiles = files.filter((f) => ORPHANS.has(f));
if (orphanFiles.length) {
  console.log("  ── 旧命名的孤儿文件（不参与看板，可删） ──");
  for (const f of orphanFiles) {
    const h = hours(now - statSync(join(RAW, f)).mtimeMs);
    console.log(`    · ${f.padEnd(34)} ${fmtAge(h)} 未动`);
  }
  console.log("");
}

console.log("  ── 一句话结论 ──");
console.log(`     ${stale === 0 && missing === 0 ? "所有数据都在建议间隔内。" : `有 ${stale} 项超过建议间隔${missing ? `，${missing} 项缺文件` : ""}。`}`);
console.log("     要更新：双击桌面「看板」→ 点页面里的「刷新数据」；或双击「刷新数据」（纯命令行）。");
console.log("");
