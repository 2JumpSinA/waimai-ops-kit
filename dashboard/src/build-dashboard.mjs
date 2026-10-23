/**
 * 生成自包含单文件看板 dashboard.html（多项目 + 项目切换器）。
 *   node src/build-dashboard.mjs [--data=<dir>] [--out=<file>] [--template=<file>] [--echarts=<file>] [--root=<dir>]
 *
 * 用户口径（经营者 2026-09-18 裁决，全部已标定；数值与文案的**单一真相源 = src/lib/caliber.mjs**）：
 *   1. 看板收入**一律用预计收入**（不是成交额）。
 *   2. **推广占比 = 推广消耗金额 ÷ 预计收入**。
 *   3. **一个看板 + 项目切换器**（品牌A ⇄ 品牌B），两项目**不汇总**。
 *   4. 异常未营业 = 台账未标注未营业原因 且 线上实际营业状态为未营业。
 *
 * 本文件只是**外壳**：解析参数 → 读文件 → 调 `src/lib/dashboard-model.mjs` 纯装配 → 注入模板 → 写盘。
 * 装配逻辑拆出去的原因见 `dashboard-model.mjs` 头部注释（一句话：可离线单测 + 可做「改前/改后同数据」对照）。
 *
 * 设计要点：
 *   - 每个数据源独立降级 —— 缺一块只降级那一块，**绝不整页白屏**
 *   - 输出自包含（echarts + 数据全部内联），双击即开、断网可用
 *   - 每个数字旁边能标出「口径/来源/覆盖家数」，宁可标注也不敢含糊
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECTS } from "./lib/caliber.mjs";
import { buildProjectModel, buildDashboardVm, verifyCaliber, assembleDashboardHtml } from "./lib/dashboard-model.mjs";

// ════════ 参数（默认值保证「不带参数跑 = 与改动前完全一致」）════════
const arg = (n, d) => {
  const hit = process.argv.find((x) => x.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(arg("root", join(SELF_DIR, "..")));
const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(0) + " KB";
const DATA_DIR = resolve(arg("data", join(ROOT, "data")));
const TPL = resolve(arg("template", join(ROOT, "src", "template", "dashboard.html")));
const APP_DIR = resolve(arg("app", join(ROOT, "src", "template", "app")));
const ECHARTS = resolve(arg("echarts", join(ROOT, "vendor", "echarts.min.js")));
const OUT = resolve(arg("out", join(ROOT, "dashboard.html")));
/** `--dry-run`：跑完整流程但不写盘。用于证明"不带参数时默认产物仍是根目录 dashboard.html"，而不真的覆盖它。 */
const DRY = process.argv.includes("--dry-run");

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

// ════════ 读盘（只有这里碰文件系统）════════
const RAW = (n) => join(DATA_DIR, "raw", n);
const unifiedAll = readJson(join(DATA_DIR, "plan", "stores-unified.json")) ?? [];
const anomaliesAll = readJson(join(DATA_DIR, "plan", "anomalies.json"))?.items ?? [];

console.log("构建看板 v2…");
console.log(`  数据目录 ${DATA_DIR}`);
console.log(`  模板     ${TPL}`);
console.log(`  产物     ${OUT}`);

const projects = [];
for (const meta of PROJECTS) {
  console.log(`\n── 项目 ${meta.label} ──`);
  projects.push(buildProjectModel(meta, {
    unifiedAll,
    anomaliesAll,
    warn: (m) => console.warn(m),
    files: {
      mt: readJson(RAW(`meituan-${meta.key}.json`)),
      inc: readJson(RAW(`income-${meta.key}.json`)),
      ka: readJson(RAW(`ka-${meta.key}.json`)),
      expo: readJson(RAW(`exposure-${meta.key}.json`)),
      today: readJson(RAW(`today-${meta.key}.json`)),
      tb: readJson(RAW(`taobao-${meta.key}.json`)),
      tbDetail: readJson(RAW(`taobao-stores-detail-${meta.key}.json`)),
      /** ⭐ 闪购营业统计（今日/昨日详情 + 分时 + 逐日趋势 + 窗口聚合）—— 平台切换器的闪购视图要它 */
      tbStats: readJson(RAW(`taobao-stats-${meta.key}.json`)),
      /** ⭐⭐ 闪购 MDA 门户族（② 族）：**两个账号共用一条通路**（protein 族只有品牌A能用） */
      tbMda: readJson(RAW(`taobao-mda-${meta.key}.json`)),
      /** ⭐⭐ 闪购推广（斗金 BP 通路，2026-09-23）：USER_DATE 全站推广口径（102301117）逐日 + 今日分时 + 余额 */
      tbPromo: readJson(RAW(`taobao-promo-${meta.key}.json`)),
    },
  }));
}

const vm = buildDashboardVm({
  projects,
  projectMetas: PROJECTS,
  generatedAt: new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium",
  }).format(new Date()),
});

/**
 * 口径不变量自检（与看板页面内自检块用**同一份 id 语义**，见 caliber.SELF_CHECK_SPECS）。
 * 这里发现的问题只进 console，不阻断构建 —— 缺一块数据不该让整页白屏。
 */
const invariantResults = verifyCaliber(vm);
const invariantFail = invariantResults.filter((r) => !r.ok);
console.log(`\n口径不变量自检：${invariantResults.length - invariantFail.length}/${invariantResults.length} 通过`);
for (const r of invariantFail) console.warn(`   ⚠️ [不变量] ${r.id} — ${r.label}：${r.detail}`);

// ════════ 组装 ════════
const tpl = readFileSync(TPL, "utf8");
const echartsJs = readFileSync(ECHARTS, "utf8");

/**
 * 方案 T：应用脚本可以按层拆到 `src/template/app/*.js`，构建时**按文件名排序**拼接成一个脚本。
 * 产物侧仍然是**单一内联 `<script>`** —— 这是产品契约：
 *   外链 .js 在 file:// 断网时失效；`type="module"` 在 file:// 下因 null origin 被 CORS 拒。
 */
function loadAppScript() {
  const APP_PH = "/*__" + "APP__*/";
  if (!tpl.includes(APP_PH)) return null;
  if (!existsSync(APP_DIR)) return null;
  const parts = readdirSync(APP_DIR).filter((n) => n.endsWith(".js")).sort();
  if (!parts.length) return null;
  const chunks = parts.map((n) => `/* ══ 分片 ${n} ══ */\n` + readFileSync(join(APP_DIR, n), "utf8"));
  console.log(`\n应用脚本分片 ${parts.length} 个（按文件名排序拼接）：`);
  for (const n of parts) console.log(`  ${n.padEnd(28)} ${(readFileSync(join(APP_DIR, n)).length + "").padStart(7)} B`);
  const joined = chunks.join("\n");
  return joined.includes("/*__" + "DATA__*/") ? joined : null;
}

const appJs = loadAppScript();
const html = assembleDashboardHtml({ template: tpl, echartsJs, vm, appJs });

if (DRY) {
  console.log(`\n🧪 --dry-run：不写盘。将写到 ${OUT}（${(Buffer.byteLength(html, "utf8") / 1024).toFixed(0)} KB）`);
} else {
  writeFileSync(OUT, html, "utf8");
  console.log(`\n✅ 已生成 ${OUT}（${kb(html)}）`);
}
for (const meta of PROJECTS) {
  const p = projects.find((x) => x.key === meta.key);
  console.log(
    `   ${meta.label.padEnd(4)} 美团门店 ${String(p.mtStores.length).padStart(4)}  台账保留 ${String(p.plan.kept).padStart(4)}  ` +
      `异常未营业 ${String(p.anomalies.length).padStart(3)}  逐日 ${String(p.income.daily.length).padStart(2)} 天  ` +
      `推广窗口 ${Object.keys(p.ka.windows).length}/4  曝光 ${p.exposure?.windows?.today ? `UV ${p.exposure.windows.today.uv} / PV ${p.exposure.windows.today.pv}` : "缺"}  闪购 ${p.taobao ? p.taobao.storeCount + " 家" : "未接入"}`,
  );
}
