/**
 * 校验生成的看板 dashboard.html。
 *   node src/verify-dashboard.mjs [--static] [--port=9222] [--file=<html>] [--screenshot=<png>] [--only=<前缀>]
 *
 * 两步：
 *   ① **静态**（不需要浏览器）：抠出内联 JS 做语法检查、核对关键数据是否落进 HTML、
 *      跑口径不变量与「渲染字段可达性」断言。这一步能跑就一定要跑 ——
 *      语法错会让整页白屏，而在浏览器里只表现为「一片空白」，很容易误判成「数据没取到」。
 *   ② **动态**（需要一个开着的调试浏览器）：真打开、抓 JS 报错、断言 DOM 渲染，
 *      并**逐个切换项目 × 窗口**，确认切换器不会把页面切崩。
 *
 * 结构：断言写成**用例表**（`STATIC_CASES` / `DYNAMIC_CASES`），每条 `{id, group, label, run(ctx)}`。
 *   `run()` 返回 `{ok, detail}`（或抛异常 → 记为失败并带上错误信息）。
 *   这样用例可数、可按前缀筛（`--only=static.`），失败能定位到具体 id，
 *   而不是像原先那样散在一串 `ok(...)` 调用里、出错时只看到一行 ✅/❌。
 *
 * ⚠️ 别用字符串拼接去抠 JS —— 用 `src/lib/dashboard-html.mjs`（括号配平，唯一实现）。
 *    历史上有两份提取实现（本文件的脆弱正则 vs inspect 的配平），一处改了另一处不知道。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractScripts, extractAppJs, extractEchartsJs, extractVmBlock, checkSelfContainedStructure } from "./lib/dashboard-html.mjs";
import { checkInvariants, SELF_CHECK_SPECS } from "./lib/caliber.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const STATIC_ONLY = process.argv.includes("--static");
const PORT = Number(arg("port", "9222"));
const FILE = resolve(ROOT, arg("file", "dashboard.html"));
const SHOT = resolve(ROOT, arg("screenshot", "_recon/raw/dashboard.png"));
const ONLY = arg("only", "");

if (!existsSync(FILE)) { console.error(`⛔ 找不到 ${FILE}`); process.exit(2); }
const html = readFileSync(FILE, "utf8");
const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
console.log(`校验目标  ${FILE}`);
console.log(`          ${kb} KB / ${html.split("\n").length} 行`);

// ════════════════════════════════════════════════════════════════
// 上下文（静态阶段算一次，动态阶段复用）
// ════════════════════════════════════════════════════════════════
const scripts = extractScripts(html);
const appJs = extractAppJs(html);
const echartsInline = extractEchartsJs(html) ?? "";
let vm = null, vmError = "";
try { vm = extractVmBlock(appJs).vm; } catch (e) { vmError = e.message; }
const vendorEchartsPath = join(ROOT, "vendor", "echarts.min.js");
const vendorEcharts = existsSync(vendorEchartsPath) ? readFileSync(vendorEchartsPath, "utf8") : null;

const ctx = { html, scripts, appJs, echartsInline, vm, vmError, vendorEcharts, root: ROOT };

/** 读集探针要用渲染指纹装置；静态阶段按需 import（避免无谓地加载 `node:vm` 沙箱代码）。 */
const fingerprintMod = await import("./lib/render-fingerprint.mjs");
const injectVmMod = await import("./lib/dashboard-html.mjs");

// ════════════════════════════════════════════════════════════════
// ① 静态用例表
// ════════════════════════════════════════════════════════════════
const STATIC_CASES = [
  {
    id: "static.script-count", group: "① 静态检查", label: "内联 script 块 = 2（echarts + 应用）",
    run: (c) => ({ ok: c.scripts.length === 2, detail: `${c.scripts.length} 个，应用脚本 ${(c.appJs.length / 1024).toFixed(0)} KB` }),
  },
  {
    id: "static.self-contained", group: "① 静态检查", label: "自包含契约（无外链 js/css、无 module、占位符已替换）",
    run: (c) => { const s = checkSelfContainedStructure(c.html); return { ok: s.ok, detail: s.findings.join("；") || "无外链、占位符均已替换" }; },
  },
  {
    id: "static.syntax", group: "① 静态检查", label: "应用 JS 语法检查",
    run: (c) => { try { new Function(c.appJs); return { ok: true, detail: "" }; } catch (e) { return { ok: false, detail: e.message }; } },
  },
  {
    id: "static.echarts-integrity", group: "① 静态检查", label: "内联 echarts 与 vendor 逐字节一致",
    run: (c) => {
      if (c.vendorEcharts == null) return { ok: false, detail: "拿不到 vendor/echarts.min.js" };
      if (c.echartsInline === c.vendorEcharts) return { ok: true, detail: `${c.echartsInline.length} 字符，逐字节相同` };
      // 精确定位：`$$`/`$&`/``$` ``/`$'` 在字符串式 replace 里会被当替换模式展开
      const diffs = [];
      const n = Math.min(c.echartsInline.length, c.vendorEcharts.length);
      for (let i = 0; i < n && diffs.length < 3; i++) {
        if (c.echartsInline[i] !== c.vendorEcharts[i]) { diffs.push(`@${i} 产物 ${JSON.stringify(c.echartsInline.slice(i, i + 8))} vs vendor ${JSON.stringify(c.vendorEcharts.slice(i, i + 8))}`); break; }
      }
      return { ok: false, detail: `长度 ${c.echartsInline.length} vs ${c.vendorEcharts.length}；${diffs.join(" | ")}（很可能是字符串式 replace 的 $ 模式展开）` };
    },
  },
  {
    id: "static.vm-json", group: "① 静态检查", label: "VM 数据块可提取且是合法 JSON",
    run: (c) => ({ ok: !!c.vm, detail: c.vm ? "" : c.vmError }),
  },
  {
    id: "static.projects", group: "① 静态检查", label: "包含 2 个项目",
    run: (c) => ({ ok: c.vm?.projectOrder?.length === 2, detail: JSON.stringify(c.vm?.projectOrder) }),
  },
];

/** 逐项目的数据断言（2 项目 × N 条，展开成独立用例） */
function projectCases() {
  const out = [];
  for (const key of vm?.projectOrder ?? []) {
    const p = vm.projects[key];
    const tag = p.label;
    const add = (id, label, fn) => out.push({
      id: `static.${key}.${id}`, group: `① 静态检查 · ${tag}`, label,
      run: () => { const r = fn(p, key); return typeof r === "boolean" ? { ok: r } : r; },
    });
    add("unified", "统一门店视图非空", (x) => ({ ok: x.unifiedRows?.length > 0, detail: `${x.unifiedRows?.length} 行` }));
    add("daily", "逐日预计收入非空", (x) => ({ ok: x.income?.daily?.length > 0, detail: `${x.income?.daily?.length} 天` }));
    add("bypoi", "近7天逐店聚合非空", (x) => ({ ok: x.income?.byPoiD7?.length > 0, detail: `${x.income?.byPoiD7?.length} 家` }));
    add("ka", "推广窗口非空", (x) => ({ ok: Object.keys(x.ka?.windows ?? {}).length > 0, detail: `${Object.keys(x.ka?.windows ?? {}).length} 个` }));
    /**
     * 曝光 = 平台总口径（2026-09-21 改）。旧口径是逐店求和，与平台总曝光不是同一度量
     * （同日实测 2,526 vs 18,280），所以这里断言的是「窗口 + 逐日曲线」而不是门店数。
     */
    add("expo", "曝光数据非空（平台总口径）", (x) => {
      const ew = x.exposure?.windows ?? {}, ed = x.exposure?.daily ?? [];
      return { ok: !!ew.today?.pv, detail: ew.today ? `UV ${ew.today.uv} / PV ${ew.today.pv} · 逐日 ${ed.length} 天 · 最新日 ${ew.today.day ?? "—"}` : "无" };
    });
    add("expo-daily", "曝光逐日曲线非空", (x) => ({ ok: (x.exposure?.daily ?? []).length > 0, detail: `${(x.exposure?.daily ?? []).length} 天` }));
    // 自洽性：曲线末点必须等于「最新日」窗口值，否则说明两条接口的窗口错位了
    add("expo-last-eq-window", "曝光曲线末点 == 最新日窗口", (x) => {
      const ed = x.exposure?.daily ?? [], last = ed[ed.length - 1], ew = x.exposure?.windows?.today;
      return { ok: !!last && !!ew && last.uv === ew.uv && last.pv === ew.pv, detail: last && ew ? `曲线 ${last.date} UV ${last.uv}/PV ${last.pv} vs 窗口 UV ${ew.uv}/PV ${ew.pv}` : "" };
    });
    add("today", "今日实时数据存在", (x) => ({ ok: !!x.today }));
    for (const w of ["today", "yesterday", "d7", "d30"]) {
      add(`win-${w}`, `窗口 ${w} 预计收入有值`, (x) => {
        const y = x.windows?.[w];
        return { ok: !(y && y.projectedIncome == null), detail: y ? `${y.projectedIncome} 元 / 推广占比 ${y.promoRatio == null ? "—" : y.promoRatio + "%"}` : "" };
      });
    }
    add("selfcheck", "预计收入自校验差 = 0", (x) => ({ ok: x.income.selfCheck ? x.income.selfCheck.projectedIncomeDiff === 0 : true, detail: String(x.income.selfCheck?.projectedIncomeDiff ?? "(无 selfCheck)") }));

    /**
     * ★ D-1 回归钉子（Lead 要求）：门店表原先读 `s.mtName`/`s.live?.mtStatus`（都不存在），
     *   导致店名显示成门店 ID、美团状态恒为 `—`。这两条断言从**数据可达性**上钉住它：
     *   数据里必须真的有可读的店名与状态，且模板不得再去读那几个不存在的字段名。
     *   （更通用的机制是 `src/test-dashboard-parity.mjs` 的 VM 读集探针：读到的字段若恒为
     *     `undefined` 就直接失败 —— 那条能自动抓出**任何**同类字段名漂移。）
     */
    add("store-name-usable", "门店名可用（非纯 ID）", (x) => {
      const rows = x.unifiedRows ?? [];
      const numeric = rows.filter((s) => /^\d+$/.test(String(s.name ?? ""))).length;
      const good = rows.length - numeric;
      return { ok: rows.length > 0 && good / rows.length >= 0.9, detail: `${rows.length} 行中 ${good} 行是店名（纯数字 ID ${numeric} 行）` };
    });
    add("store-status-usable", "美团状态列不会全空", (x) => {
      const rows = x.unifiedRows ?? [];
      const withStatus = rows.filter((s) => String(s.mtStatus ?? "").trim() !== "").length;
      return { ok: withStatus > 0, detail: `${rows.length} 行中有 ${withStatus} 行带状态` };
    });
  }
  return out;
}
STATIC_CASES.push(...projectCases());

STATIC_CASES.push(
  {
    id: "static.readset-no-field-drift", group: "① 静态检查", label: "无字段名漂移：模板读到的 VM 字段都真实存在（D-1 的通用钉子）",
    run: (c) => {
      /**
       * ★ 这是 D-1 的**通用**钉子，取代了原先「源码里搜 `s.mtName`」那种子串匹配 ——
       *   子串匹配连注释里的说明文字都会命中（修好 D-1 后误报过），而且只能查我事先想到的字段名。
       *   现在用 `render-fingerprint` 的 **VM 读集探针**：把注入的 VM 包成 Proxy，
       *   跑完整渲染后看**哪些路径读到的值恒为 `undefined`** —— 那就是字段名漂移。
       *   D-1 当初正是这样被机器抓出来的（`unifiedRows[].mtName/tbName/live` 共 6 条）。
       */
      const { fingerprintApp } = fingerprintMod;
      const f = fingerprintApp({
        appJs: injectVmMod.injectVm(c.appJs, c.vm), label: "verify",
        matrix: [["品牌A", "今日"]],
        probe: true, // ⚠️ 不加这个开关，探针根本不会启动 → 读集为空 → 断言**空转通过**（踩过）
      });
      if (f.errors.length) return { ok: false, detail: `渲染期报错：${f.errors.slice(0, 2).join(" | ")}` };
      const reads = f.vmReads ?? {};
      const n = Object.keys(reads).length;
      /**
       * ⚠️ 空读集必须判**失败**，不能判通过 ——
       *    「探针什么都没看到」与「没有漂移」是两回事。第一版就漏了 `probe: true`，
       *    结果打印「读集 0 条路径，无 undefined 漂移」还标了 ✅，纯属空转。
       */
      if (n < 50) return { ok: false, detail: `读集只有 ${n} 条路径 —— 探针没正常工作，本断言空转，不可信` };
      const drift = Object.keys(reads).filter((p) => reads[p] === "undefined");
      return {
        ok: drift.length === 0,
        detail: drift.length
          ? `${drift.length} 条路径读到的恒为 undefined：${drift.slice(0, 8).join(", ")}${drift.length > 8 ? " …" : ""}`
          : `读集 ${n} 条路径，无 undefined 漂移`,
      };
    },
  },
  {
    id: "static.dirty-scan", group: "① 静态检查", label: "VM 内无 undefined/NaN 字面量（全量扫描，不截断）",
    run: (c) => {
      // ⚠️ 原先只扫 `JSON.stringify(vm).slice(0, 200000)`，而 VM JSON 有 27 万+ 字符 ——
      //    覆盖率 72.3%，盲区里正是**品牌B项目的数据主体**（见 `_recon/struct/measure-vmjson.mjs`）。
      //    这里改成**全量**。
      //    判据只能命中**字符串里**的 `undefined`/`NaN`（`JSON.stringify` 本来就把裸值丢掉/写成 null），
      //    所以它真正抓的是「`${undefined}` 漏进页面文案」这类事故。
      //    ⚠️ 必须排除 `selfCheckSpecs` / `selfCheck`：这两份是**断言清单本身**，
      //       其 label/detail 里本来就写着 "undefined/NaN" 字样（自指），扫进来必然误报。
      const { selfCheckSpecs, selfCheck, ...rest } = c.vm;
      const s = JSON.stringify(rest);
      const hit = /undefined|NaN/.test(s);
      return {
        ok: !hit,
        detail: `全量扫描 ${s.length} 字符（已排除 selfCheckSpecs/selfCheck 两份自指文案）${hit ? " —— 命中 undefined|NaN" : ""}`,
      };
    },
  },
  {
    id: "static.caliber-invariants", group: "① 静态检查", label: "口径不变量全部通过（与页面自检块同源）",
    run: (c) => {
      const res = checkInvariants(c.vm);
      const bad = res.filter((r) => !r.ok);
      return { ok: bad.length === 0, detail: `${res.length - bad.length}/${res.length} 通过${bad.length ? "；未通过：" + bad.map((b) => b.id).join(", ") : ""}` };
    },
  },
  {
    id: "static.selfcheck-spec-coverage", group: "① 静态检查", label: "每个自检 id 在模板侧都有实现",
    run: (c) => {
      const missing = SELF_CHECK_SPECS.filter((s) => !c.appJs.includes(`"${s.id}"`));
      return { ok: missing.length === 0, detail: missing.length ? `模板未实现：${missing.map((s) => s.id).join(", ")}` : `${SELF_CHECK_SPECS.length} 个 id 均有实现` };
    },
  },
  {
    id: "static.window-defs-from-vm", group: "① 静态检查", label: "窗口切换器由 VM.caliber.windowDefs 驱动（不再硬编码两份）",
    run: (c) => {
      const has = Array.isArray(c.vm?.caliber?.windowDefs) && c.vm.caliber.windowDefs.length === 4;
      const hard = /\[\s*\[\s*"today"\s*,\s*"今日"\s*\]/.test(c.appJs);
      return { ok: has && !hard, detail: has ? `VM 侧 ${c.vm.caliber.windowDefs.length} 个窗口；模板${hard ? "仍有硬编码数组" : "已无硬编码数组"}` : "VM.caliber.windowDefs 缺失" };
    },
  },
);

// ════════════════════════════════════════════════════════════════
// ② 动态用例表（需要调试浏览器；函数体在连上 CDP 后才用）
// ════════════════════════════════════════════════════════════════
const DYNAMIC_CASES = [
  { id: "dyn.echarts", group: "② 动态检查", label: "echarts 已加载", run: (c) => ({ ok: c.r.hasEcharts }) },
  { id: "dyn.kpis", group: "② 动态检查", label: "KPI 卡片", run: (c) => ({ ok: c.r.kpis >= 6, detail: `${c.r.kpis} 张` }) },
  { id: "dyn.canvas", group: "② 动态检查", label: "图表 canvas", run: (c) => ({ ok: c.r.canvases >= 4, detail: `${c.r.canvases} 个` }) },
  { id: "dyn.cancel-cards", group: "② 动态检查", label: "取消单变化三格", run: (c) => ({ ok: c.r.cancelCards === 3, detail: `${c.r.cancelCards} 格` }) },
  { id: "dyn.store-rows", group: "② 动态检查", label: "门店表", run: (c) => ({ ok: c.r.storeRows > 0, detail: `${c.r.storeRows} 行` }) },
  {
    id: "dyn.store-names-visible", group: "② 动态检查", label: "门店表首列是店名而不是 ID（D-1 钉子）",
    run: (c) => {
      const rows = c.r.storeFirstCells;
      const numeric = rows.filter((x) => /^\d+$/.test(x)).length;
      return { ok: rows.length > 0 && numeric / rows.length < 0.1, detail: `${rows.length} 行中纯数字 ID ${numeric} 行；示例 ${JSON.stringify(rows.slice(0, 3))}` };
    },
  },
  {
    id: "dyn.store-status-visible", group: "② 动态检查", label: "门店表美团状态列非全空（D-1 钉子）",
    run: (c) => {
      const rows = c.r.storeStatusCells;
      const filled = rows.filter((x) => x && x !== "—").length;
      return { ok: filled > 0, detail: `${rows.length} 行中 ${filled} 行有状态；示例 ${JSON.stringify(rows.filter((x) => x && x !== "—").slice(0, 3))}` };
    },
  },
  {
    id: "dyn.highcancel", group: "② 动态检查", label: "高取消门店表（容器存在且有行 或 显示空态）",
    run: (c) => ({ ok: c.r.highCancelRows > 0 || c.r.highCancelEmpty, detail: c.r.highCancelRows > 0 ? `${c.r.highCancelRows} 行` : c.r.highCancelEmpty ? "显示空态占位" : "既无行也无空态 —— 疑似渲染中断" }),
  },
  {
    id: "dyn.selfcheck-visible", group: "② 动态检查", label: "口径自检块已渲染且全部通过",
    run: (c) => ({ ok: c.r.selfCheckRows === c.r.selfCheckSpecs, detail: `${c.r.selfCheckRows}/${c.r.selfCheckSpecs} 行；标签「${c.r.selfCheckTag}」` }),
  },
  { id: "dyn.notes", group: "② 动态检查", label: "口径说明已渲染", run: (c) => ({ ok: c.r.notes > 200, detail: `${c.r.notes} 字符` }) },
  { id: "dyn.proj-btns", group: "② 动态检查", label: "项目切换器按钮", run: (c) => ({ ok: c.r.projBtns.length === 2, detail: JSON.stringify(c.r.projBtns) }) },
  { id: "dyn.win-btns", group: "② 动态检查", label: "窗口切换器按钮", run: (c) => ({ ok: c.r.winBtns.length === 4, detail: JSON.stringify(c.r.winBtns) }) },
];

/**
 * ⭐ 刷新控件的**降级契约**。
 *   本脚本是用 file:// 加载的，而 file:// 页面**不可能**起 Node、写磁盘、开调试端口 ——
 *   所以「点一下同步数据」在 file:// 下物理上做不到。做得到的是**诚实降级**：
 *   按钮禁用 + 明确写出为什么、以及该怎么办。
 */
DYNAMIC_CASES.push(
  { id: "dyn.refresh-btn", group: "② 动态检查 · 刷新降级契约", label: "刷新按钮存在", run: (c) => ({ ok: c.r.refreshBtn }) },
  { id: "dyn.refresh-no-cfg", group: "② 动态检查 · 刷新降级契约", label: "file:// 下没有 __DSH_REFRESH__ 配置", run: (c) => ({ ok: !c.r.hasRefreshCfg }) },
  { id: "dyn.refresh-disabled", group: "② 动态检查 · 刷新降级契约", label: "file:// 下刷新按钮禁用", run: (c) => ({ ok: c.r.refreshDisabled === true, detail: `disabled=${c.r.refreshDisabled}` }) },
  { id: "dyn.refresh-scope-hidden", group: "② 动态检查 · 刷新降级契约", label: "file:// 下范围下拉隐藏", run: (c) => ({ ok: c.r.refreshScopeHidden === true }) },
  { id: "dyn.refresh-panel-hidden", group: "② 动态检查 · 刷新降级契约", label: "file:// 下进度面板隐藏", run: (c) => ({ ok: c.r.runPanelHidden === true }) },
  { id: "dyn.refresh-hint", group: "② 动态检查 · 刷新降级契约", label: "提示里给出服务模式入口", run: (c) => ({ ok: /serve-dashboard|服务模式/.test(c.r.refreshHint), detail: c.r.refreshHint.slice(0, 90) }) },
  { id: "dyn.refresh-text", group: "② 动态检查 · 刷新降级契约", label: "按钮文案含「刷新」", run: (c) => ({ ok: c.r.refreshBtnText.includes("刷新"), detail: c.r.refreshBtnText }) },
);

// ════════════════════════════════════════════════════════════════
// 运行器
// ════════════════════════════════════════════════════════════════
let fail = 0, ran = 0;
const runCases = (cases, c, { verbose = true } = {}) => {
  let group = "";
  for (const t of cases) {
    if (ONLY && !t.id.startsWith(ONLY) && !t.group.includes(ONLY)) continue;
    if (t.group !== group) { group = t.group; if (verbose) console.log(`\n════ ${group} ════`); }
    ran++;
    let r;
    try { r = t.run(c) ?? { ok: false, detail: "run() 没有返回值" }; }
    catch (e) { r = { ok: false, detail: `抛异常：${e.message}` }; }
    if (verbose) console.log(`  ${r.ok ? "✅" : "❌"} ${t.label}${r.detail ? "  " + r.detail : ""}`);
    if (!r.ok) fail++;
  }
};

runCases(STATIC_CASES, ctx);

if (STATIC_ONLY) {
  console.log(`\n${fail ? "⛔" : "✅"} 静态检查${fail ? `失败 ${fail} 项` : "全部通过"}（${ran} 条用例）`);
  process.exit(fail ? 1 : 0);
}

// ════════ ② 动态 ════════
const { connectToPage } = await import("./lib/cdp.mjs");
console.log("\n════ ② 动态检查 ════");
let cdp;
try {
  cdp = await connectToPage(PORT);
} catch (e) {
  console.log(`  ⚠️ 连不上 ${PORT}（${e.message}），跳过动态检查`);
  console.log(`\n${fail ? "⛔" : "✅"} 静态检查${fail ? `失败 ${fail} 项` : "全部通过"}（${ran} 条用例；动态未跑）`);
  process.exit(fail ? 1 : 0);
}

const errors = [];
/**
 * ⚠️ 报错要**带上来源 url**。
 *   曾经出现过一条 `[SDK] Initialization failed: userId is required...`，
 *   而这串字符在 dashboard.html 里根本不存在 —— 只记文本就完全查不出来源。
 *   CDP 的 `Runtime.enable` 会把目标**已有的 console 缓冲重放**一遍，
 *   所以复用/新建标签页时可能捞到上一位房客的报错；有 url 才分辨得清是谁的。
 */
const srcOf = (p) => p.stackTrace?.callFrames?.[0]?.url ?? p.exceptionDetails?.url ?? "(无 url)";
cdp.on("Runtime.exceptionThrown", (p) => errors.push(`[${srcOf(p)}] ${p.exceptionDetails?.exception?.description ?? JSON.stringify(p.exceptionDetails)}`));
cdp.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error") errors.push(`[${srcOf(p)}] ` + (p.args ?? []).map((a) => a.value ?? a.description).join(" ")); });

await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1400, deviceScaleFactor: 1, mobile: false });
await cdp.send("Page.navigate", { url: pathToFileURL(FILE).href });
await new Promise((r) => setTimeout(r, 4000));

const probeExpr = `JSON.stringify({
  kpis: document.querySelectorAll('#kpis .kpi').length,
  kpiText: [...document.querySelectorAll('#kpis .kpi')].map(e=>e.innerText.replace(/\\n/g,' | ')).slice(0,8),
  canvases: document.querySelectorAll('canvas').length,
  cancelCards: document.querySelectorAll('#cancelCards .kv').length,
  highCancelRows: document.querySelectorAll('#highCancelWrap tbody tr').length,
  highCancelEmpty: !!document.querySelector('#highCancelWrap .empty'),
  expoRows: document.querySelectorAll('#expoTopWrap tbody tr').length,
  storeRows: document.querySelectorAll('#storeWrap tbody tr').length,
  storeFirstCells: [...document.querySelectorAll('#storeWrap tbody tr')].slice(0,60).map(r=>r.children[0]?.innerText?.trim() ?? ''),
  storeStatusCells: [...document.querySelectorAll('#storeWrap tbody tr')].slice(0,60).map(r=>r.children[4]?.innerText?.trim() ?? ''),
  selfCheckRows: document.querySelectorAll('#selfCheckWrap tbody tr').length,
  selfCheckTag: document.getElementById('selfCheckTag')?.innerText ?? '',
  selfCheckSpecs: (typeof VM !== 'undefined' && VM.selfCheckSpecs) ? VM.selfCheckSpecs.length : 0,
  projBtns: [...document.querySelectorAll('#projSeg button')].map(b=>b.textContent),
  winBtns: [...document.querySelectorAll('#winSeg button')].map(b=>b.textContent),
  alerts: document.querySelectorAll('#alerts .alert').length,
  notes: document.getElementById('notes').innerText.length,
  hasEcharts: typeof echarts !== 'undefined',
  bodyH: document.body.scrollHeight,
  incomeFoot: document.querySelector('#kpis .kpi')?.innerText.replace(/\\n/g,' | ') ?? '',
  incomeSub: document.getElementById('incomeCaliberSub')?.innerText ?? '',
  refreshBtn: !!document.getElementById('refreshBtn'),
  refreshDisabled: document.getElementById('refreshBtn')?.disabled ?? null,
  refreshBtnText: document.getElementById('refreshBtn')?.textContent ?? '',
  refreshHint: document.getElementById('refreshHint')?.innerText ?? '',
  refreshScopeHidden: (document.getElementById('refreshScope')?.style.display === 'none'),
  runPanelHidden: (document.getElementById('runPanel')?.style.display === 'none'),
  hasRefreshCfg: typeof window.__DSH_REFRESH__ !== 'undefined',
  curProj: document.querySelector('#projSeg button.active')?.textContent ?? '',
  /** 各图表的 X 轴（用来断言「图表跟随窗口」）*/
  chartX: (() => { const o={};
    for (const id of ["c-income","c-cancel","c-ka","c-expo"]) {
      try { const c=(typeof charts!=="undefined")?charts[id]:null;
        if(!c){o[id]=null;continue;}
        const op=c.getOption(); const d=(op.xAxis&&op.xAxis[0]&&op.xAxis[0].data)||[];
        o[id]={n:d.length,first:d[0]??null,last:d[d.length-1]??null};
      } catch(e){ o[id]={err:String(e)}; }
    } return o; })(),
  tags: {
    income: document.getElementById("incomeTrendTag")?.textContent ?? null,
    cancel: document.getElementById("cancelTrendTag")?.textContent ?? null,
    ka: document.getElementById("kaTag")?.textContent ?? null,
    expo: document.getElementById("expoTag")?.textContent ?? null,
  },
  /** 窗口切换器（顶部 1 个 + 四个图表卡片内各 1 个）——它们必须始终同状态 */
  winSegs: (() => { const o = {};
    for (const id of ["winSeg","winSegIncome","winSegCancel","winSegKa","winSegExpo"]) {
      const el = document.getElementById(id);
      o[id] = el ? { n: el.querySelectorAll("button").length, active: el.querySelector("button.active")?.textContent ?? null } : null;
    } return o; })(),
  /** 平台切换器（全部平台 / 美团 / 闪购）—— 同状态要求 */
  platSegs: (() => { const o = {};
    for (const id of ["platSeg","platSegIncome","platSegCancel","platSegKa","platSegExpo"]) {
      const el = document.getElementById(id);
      o[id] = el ? { n: el.querySelectorAll("button").length, active: el.querySelector("button.active")?.textContent ?? null } : null;
    } return o; })()
})`;
const probe = async () => JSON.parse((await cdp.send("Runtime.evaluate", { expression: probeExpr, returnByValue: true })).result.value);
const r = await probe();
const dctx = { ...ctx, r, cdp, errors };
runCases(DYNAMIC_CASES, dctx);

console.log(`  KPI: ${JSON.stringify(r.kpiText)}`);
console.log(`  页面高度 ${r.bodyH}px`);

// 逐个切换 项目 × 窗口（切换必须真的发生，否则"切换正常"是空话）
const clickAndProbe = async (segId, label) => {
  const expr = `(() => { const b=[...document.querySelectorAll('#${segId} button')].find(x=>x.textContent===${JSON.stringify(label)});
    if(!b) return 'no-button'; b.click(); return 'ok'; })()`;
  const res = (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
  if (res !== "ok") return null;
  await new Promise((rr) => setTimeout(rr, 700));
  return probe();
};
{
  let group = "② 动态检查 · 切换矩阵";
  console.log(`\n════ ${group} ════`);
  for (const proj of r.projBtns) {
    for (const winLabel of r.winBtns) {
      const before = errors.length;
      const rr = await clickAndProbe("winSeg", winLabel);
      const okSwitch = rr && rr.kpis >= 6 && rr.storeRows > 0;
      const newErr = errors.length - before;
      ran++;
      const good = okSwitch && newErr === 0;
      if (!good) fail++;
      console.log(`  ${good ? "✅" : "❌"} 切换 ${proj} × ${winLabel}` +
        (rr ? `  KPI ${rr.kpis} · 门店 ${rr.storeRows} 行 · 图 ${rr.canvases}${newErr ? ` · 新报错 ${newErr}` : ""}` : "  点不到按钮"));
    }
    const rr = await clickAndProbe("projSeg", r.projBtns.find((x) => x !== proj) ?? proj);
    ran++;
    if (!rr) fail++;
    console.log(`  ${rr ? "✅" : "❌"} 切回项目 ${proj}`);
  }
}

/**
 * ⭐ 图表必须跟随窗口切换器（2026-09-22 经营者要求）。
 *
 * 断言的是**时间维度与点数**，不是像素 —— 这才叫「验到了」：
 *   · 今日 / 昨日 → X 轴是 `HH:00`
 *     - 收入 / 取消率：点位 = 逐单 `order_time` 分桶的小时数
 *     - 推广：点位 = **推广首页实时接口**的 `todayList` / `yesterdayList` 段数
 *   · 近7天       → 点数 == 7，标签 `MM-DD`
 *   · 近30天      → 点数 == 该板块逐日数组长度，标签 `MM-DD`
 *   · 曝光 平台**只有日粒度**（T+1）→ 小时窗口下**必须**退化成日级并在 tag 里写明；
 *     推广只有在**实时分时也取不到**时才允许降级，且同样必须写明 ——
 *     否则就是拿日级图冒充小时图（对用户说谎）。
 */
{
  console.log(`\n════ ② 动态检查 · 图表跟随窗口 ════`);
  const HOUR = /^\d{2}:00$/;
  const DAY = /^\d{2}-\d{2}$/;
  const len = (a) => (a ?? []).length;
  for (const winLabel of r.winBtns) {
    const rr = await clickAndProbe("winSeg", winLabel);
    ran++;
    if (!rr) { fail++; console.log(`  ❌ 图表跟随窗口：${winLabel} 点不到按钮`); continue; }
    const key = vm.projectOrder.find((k) => vm.projects[k].label === rr.curProj) ?? vm.projectOrder[0];
    const P = vm.projects[key];
    const hourly = winLabel === "今日" || winLabel === "昨日";
    /**
     * ⭐ R22（2026-09-24）：默认视图 =「全部平台」= 美团+闪购**合计** ——
     *   点数期望改按 `trendAll` 合计序列取（小时 = 两平台并集；推广恒为日粒度，
     *   因闪购分时只有今日诊断口径，无法逐时合计）。
     */
    const TA = P.trendAll ?? null;
    const useAll = !!TA;
    const hourN = winLabel === "昨日"
      ? (useAll ? len(TA.income?.hourly?.yesterday) : len(P.today?.hourlyYesterday))
      : (useAll ? len(TA.income?.hourly?.today) : len(P.today?.hourly));
    const canHourN = winLabel === "昨日"
      ? (useAll ? len(TA.cancel?.hourly?.yesterday) : len(P.today?.hourlyYesterday))
      : (useAll ? len(TA.cancel?.hourly?.today) : len(P.today?.hourly));
    const incDailyN = useAll ? len(TA.income?.daily) : len(P.income?.daily);
    const canDailyN = useAll ? len(TA.cancel?.daily) : len(P.income?.daily);
    const dailyN = winLabel === "近7天" ? Math.min(7, incDailyN) : incDailyN;
    const canDailyN2 = winLabel === "近7天" ? Math.min(7, canDailyN) : canDailyN;
    const expoDaily = useAll ? (TA.expo?.daily ?? []) : (P.exposure?.daily ?? []);
    const expoN = winLabel === "近30天" ? len(expoDaily) : Math.min(7, len(expoDaily));

    // 推广：美团视图今日/昨日优先用首页实时分时（真小时）；全部平台今日 = 双平台分时对齐求和（R22b），
    //   昨日闪购无分时消耗 → 退化最近 7 天逐日
    const kaRt = P.ka?.realtime;
    const kaRtHour = winLabel === "昨日" ? len(kaRt?.hourlyYesterday) : len(kaRt?.hourly);
    const kaAll = len(P.ka?.daily30) ? P.ka.daily30 : P.ka?.daily ?? [];
    const kaPromoAll = useAll ? len(TA.promo?.daily ?? []) : 0;
    const kaPromoHourAll = useAll ? len(TA.promo?.hourly?.[winLabel === "昨日" ? "yesterday" : "today"] ?? []) : 0;
    const kaHourOk = useAll ? kaPromoHourAll > 0 : kaRtHour > 0;
    const kaN = useAll
      ? (kaHourOk && hourly ? kaPromoHourAll : winLabel === "近30天" ? kaPromoAll : Math.min(7, kaPromoAll))
      : hourly
        ? (kaRtHour > 0 ? kaRtHour : Math.min(7, len(kaAll)))
        : winLabel === "近7天" ? len(P.ka?.daily) : len(kaAll);
    const kaRe = kaHourOk && hourly ? HOUR : DAY;

    const checks = [
      ["c-income", hourly ? hourN : dailyN, hourly ? HOUR : DAY],
      ["c-cancel", hourly ? canHourN : canDailyN2, hourly ? HOUR : DAY],
      ["c-ka", kaN, kaRe],
      ["c-expo", expoN, DAY],
    ];
    const bad = [];
    for (const [id, wantN, re] of checks) {
      const g = rr.chartX?.[id];
      if (!g || g.n !== wantN || !re.test(String(g.first ?? ""))) {
        bad.push(`${id} 期望 ${wantN} 点 实得 ${g ? `${g.n} 点 first=${g.first}` : "读不到"}`);
      }
    }
    if (hourly) {
      // 曝光：平台确实只有日粒度 → 必须如实标注降级
      if (!String(rr.tags?.expo ?? "").includes("无小时数据")) {
        bad.push(`曝光 tag 未标注无小时数据（实为「${rr.tags?.expo}」）`);
      }
      // 推广：有合计分时（美团视图=实时 / 全部平台=双平台求和）就必须是真小时；否则必须标注降级
      if (kaHourOk) {
        if (!String(rr.tags?.ka ?? "").includes("逐小时")) bad.push(`推广有分时却未用小时维度（tag「${rr.tags?.ka}」）`);
      } else if (!String(rr.tags?.ka ?? "").includes("无小时数据")) {
        bad.push(`推广分时缺失时未标注降级（tag「${rr.tags?.ka}」）`);
      }
    }
    /**
     * ⭐ 卡片内的迷你窗口切换器（2026-09-22 新增，为免去滚回页首）：
     *   5 个切换器必须都在、各 4 个按钮、且 active 与刚点的窗口一致 ——
     *   否则用户会看到「两个地方显示不同窗口」，比没有还糟。
     */
    for (const [id, v] of Object.entries(rr.winSegs ?? {})) {
      if (!v || v.n !== 4) { bad.push(`切换器 ${id} 缺失或按钮数不为 4（${v ? v.n : "无"}）`); continue; }
      if (v.active !== winLabel) bad.push(`切换器 ${id} 高亮「${v.active}」≠ 已选「${winLabel}」`);
    }
    const good = bad.length === 0;
    if (!good) fail++;
    console.log(`  ${good ? "✅" : "❌"} ${winLabel}（${rr.curProj}）收入/取消 ${rr.chartX?.["c-income"]?.n} 点 first=${rr.chartX?.["c-income"]?.first} · 推广 ${rr.chartX?.["c-ka"]?.n} 点 · 曝光 ${rr.chartX?.["c-expo"]?.n} 点${good ? "" : `  ⛔ ${bad.join("；")}`}`);
  }
}

/**
 * ⭐ 平台切换器（全部平台 / 美团 / 闪购）—— 2026-09-22 经营者要求。
 *
 * 断言的是**「有没有拿错平台的数据」**，这是本项目最贵的一类错误：
 *   · 5 个平台切换器必须都在、各 3 键、active 与所点一致；
 *   · 「闪购」视图下，**曝光 / 推广**有没有图必须与「有没有数据」一致（都来自闪购自己的通路）——
 *     有数据没图=漏画；无数据有图=拿美团数据冒充闪购；
 *   · 「美团 / 全部平台」视图下这两张图必须存在。
 */
{
  console.log(`\n════ ② 动态检查 · 平台切换（全部平台/美团/闪购）× 两个项目 ════`);
  const PLATS = ["全部平台", "美团", "闪购"];
  for (const projLabel of r.projBtns) {
    await clickAndProbe("projSeg", projLabel);
    for (const label of PLATS) {
      const rr = await clickAndProbe("platSeg", label);
      ran++;
      if (!rr) { fail++; console.log(`  ❌ 平台切换：${projLabel} × ${label} 点不到按钮`); continue; }
      const bad = [];
      for (const [id, v] of Object.entries(rr.platSegs ?? {})) {
        if (!v || v.n !== 3) { bad.push(`切换器 ${id} 缺失或按钮数不为 3（${v ? v.n : "无"}）`); continue; }
        if (v.active !== label) bad.push(`切换器 ${id} 高亮「${v.active}」≠ 已选「${label}」`);
      }
      const shangou = label === "闪购";
      const curKey0 = vm.projectOrder.find((k) => vm.projects[k].label === rr.curProj) ?? vm.projectOrder[0];
      const tbS = vm.projects[curKey0]?.taobao?.series;
      const tbM = vm.projects[curKey0]?.taobao?.mda;
      // 推广：2026-09-23 起闪购推广**已接入**（斗金 BP 通路）——
      // 有数据就必须有图；没数据必须没图（继续专抓「拿美团数据冒充闪购」）
      const kaHasChart = !!rr.chartX?.["c-ka"];
      const hasTbPromo = !!((vm.projects[curKey0]?.taobao?.promo?.daily ?? []).length ||
        (vm.projects[curKey0]?.taobao?.promo?.todayHourly ?? []).length);
      if (shangou && hasTbPromo && !kaHasChart) bad.push("闪购有推广数据却未画图");
      if (shangou && !hasTbPromo && kaHasChart) bad.push("推广在闪购视图下仍画了图（疑似拿美团数据冒充闪购）");
      if (!shangou && !kaHasChart) bad.push(`推广在「${label}」视图下应显示图表，实际没有`);
      // 曝光：闪购**已接入**（① 品牌A / ② 品牌B）→ 有数据就必须有图
      const expoHasChart = !!rr.chartX?.["c-expo"];
      const hasTbExpo = !!(tbS?.exposure || (tbM?.flowDaily?.exp_user_num?.points ?? []).length);
      if (shangou && hasTbExpo && !expoHasChart) bad.push("闪购有曝光数据却未画图");
      if (shangou && !hasTbExpo && expoHasChart) bad.push("闪购无曝光数据却画了图（疑似拿美团顶上）");
      if (!shangou && !expoHasChart) bad.push(`曝光在「${label}」视图下应显示图表，实际没有`);
      // 收入：闪购有 **② 族**（两账号通用）或 ① 族数据就必须有图
      const hasShangouSeries = !!tbM || (tbS?.daily?.gmv ?? []).length > 0;
      const incomeHasChart = !!rr.chartX?.["c-income"];
      if (shangou && hasShangouSeries && !incomeHasChart) bad.push("闪购有营业序列却未画图");
      if (shangou && !hasShangouSeries && incomeHasChart) bad.push("闪购无序列却画了图（疑似拿美团顶上）");
      // ⭐ R20/R21（2026-09-24 经营者指示）：KPI 七卡随平台切换 —— 专抓「闪购视图还挂着美团口径」：
      //   · 闪购视图：收入卡口径必须含「闪购」（drawKpisShangou 的 tbKpi.incomeShort）；
      //   · 全部平台视图（R21 = 美团+闪购合计）：卡片必须带「美团+闪购」合计标注。
      const kpiTextAll = (rr.kpiText ?? []).join(" | ");
      if (shangou && hasShangouSeries && !kpiTextAll.includes("闪购")) {
        bad.push("闪购视图 KPI 未切换为闪购口径（疑似仍显示美团数据）");
      }
      if (label === "全部平台" && !/美团\+闪购/.test(kpiTextAll)) {
        bad.push("全部平台视图 KPI 缺「美团+闪购」合计标注");
      }

      const good = bad.length === 0;
      if (!good) fail++;
      console.log(`  ${good ? "✅" : "❌"} ${projLabel} × ${label}  收入图=${incomeHasChart ? "有" : "无"} · 推广图=${kaHasChart ? "有" : "无"} · 曝光图=${expoHasChart ? "有" : "无"}${good ? "" : `  ⛔ ${bad.join("；")}`}`);
    }
  }
  // 切回默认，避免影响后续断言
  await clickAndProbe("projSeg", vm.projects[vm.projectOrder[0]]?.label ?? "");
  await clickAndProbe("platSeg", "全部平台");
}

/**
 * ⭐ 闪购取消（流失）趋势 · 日窗口必须画 MDA 逐日流失（2026-09-23 经营者指示）。
 *   两个账号的 MDA `biz.getTrendChartData` 都有 30 天逐日流失（品牌A = o2o+镜像子账号镜像求和）——
 *   有数据就必须有图（近7天 7 点 / 近30天 30 点，标签 MM-DD）；没数据必须没图。
 */
{
  console.log(`\n════ ② 动态检查 · 闪购取消趋势（近7/近30天逐日流失）════`);
  for (const projLabel of r.projBtns) {
    await clickAndProbe("projSeg", projLabel);
    await clickAndProbe("platSeg", "闪购");
    const key = vm.projectOrder.find((k) => vm.projects[k].label === projLabel) ?? vm.projectOrder[0];
    const invN = vm.projects[key]?.taobao?.mda?.daily?.invalidOrderNum?.points?.length ?? 0;
    for (const [winLabel, wantN] of [["近7天", Math.min(7, invN)], ["近30天", invN]]) {
      const rr = await clickAndProbe("winSeg", winLabel);
      ran++;
      if (!rr) { fail++; console.log(`  ❌ ${projLabel} × 闪购 × ${winLabel} 点不到窗口按钮`); continue; }
      const g = rr.chartX?.["c-cancel"];
      const bad = [];
      if (!invN) {
        if (g) bad.push("无逐日流失数据却画了图");
      } else if (!g || g.n !== wantN || !/^\d{2}-\d{2}$/.test(String(g.first ?? ""))) {
        bad.push(`期望 ${wantN} 点逐日流失，实得 ${g ? `${g.n} 点 first=${g.first}` : "无图"}`);
      }
      const good = bad.length === 0;
      if (!good) fail++;
      console.log(`  ${good ? "✅" : "❌"} ${projLabel} × 闪购 × ${winLabel}  取消图=${g ? `${g.n} 点 first=${g.first}` : "无"}${good ? "" : `  ⛔ ${bad.join("；")}`}`);
    }
    // 还原窗口与平台，避免影响后续断言
    await clickAndProbe("winSeg", "今日");
    await clickAndProbe("platSeg", "全部平台");
  }
}

/**
 * ⭐ 口径文案必须跟随**数据来源**。
 *
 * 真实事故：美团侧收入已从「逐单翻页求和」换成「平台聚合」(manageHome/core)，
 * 但看板 KPI 卡片上那句「口径：Σ 逐单 finalSettlementAmount（剔除已取消）」是**硬编码**的 ——
 * 数字来自平台，说明却写着逐单求和，等于对用户说谎。
 *
 * 断言方式：拿 VM 里该项目自报的 `income.source` 去推期望关键词，再核对页面文案。
 * 这样不管以后换成什么取数方式，只要模板没跟上就会挂。
 */
{
  console.log(`\n════ ② 动态检查 · 口径文案跟随来源 ════`);
  for (const key of vm.projectOrder) {
    const label = vm.projects[key]?.label ?? key;
    const src = vm.projects[key]?.income?.source;
    const expect = src === "platform-aggregate" ? "平台" : "逐单";
    const rr = await clickAndProbe("projSeg", label);
    ran++;
    if (!rr) { fail++; console.log(`  ❌ 口径文案：切到 ${label}  点不到项目按钮`); continue; }
    // ⭐ R21（2026-09-24）：「全部平台」KPI = 美团+闪购合计口径，收入来源文案断言改在「美团」视图下做
    const rrMt = (await clickAndProbe("platSeg", "美团")) ?? rr;
    const hit = rrMt.incomeFoot.includes(expect);
    if (!hit) fail++;
    console.log(`  ${hit ? "✅" : "❌"} 口径文案跟随来源（${label} / source=${src}）  ` +
      (hit ? `「${rrMt.incomeFoot.slice(0, 60)}…」含「${expect}」` : `期望含「${expect}」，实际：${rrMt.incomeFoot}`));
    const hit2 = rrMt.incomeSub.includes(expect);
    ran++;
    if (!hit2) fail++;
    console.log(`  ${hit2 ? "✅" : "❌"} 趋势图副标题跟随来源（${label}）  ${rrMt.incomeSub.slice(0, 70)}`);
  }
  // 恢复默认平台，避免影响后续断言/截图
  await clickAndProbe("platSeg", "全部平台");
}

{
  ran++;
  const good = errors.length === 0;
  if (!good) fail++;
  console.log(`\n  ${good ? "✅" : "❌"} 全程无 JS 报错  ${errors.slice(0, 2).map((x) => String(x).split("\n")[0].slice(0, 160)).join(" ‖ ")}`);
}

// 截图（切换器测完，回到第一个项目）
await clickAndProbe("projSeg", r.projBtns[0]);
await clickAndProbe("winSeg", "d7");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: Math.min(r.bodyH + 60, 8000), deviceScaleFactor: 1, mobile: false });
await new Promise((rr) => setTimeout(rr, 1500));
const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
mkdirSync(dirname(SHOT), { recursive: true });
writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
console.log(`\n  截图 ${SHOT}（${(Buffer.from(shot.data, "base64").length / 1024).toFixed(0)} KB）`);

await cdp.close();
console.log(`\n${fail ? "⛔" : "✅"} 校验${fail ? `失败 ${fail} 项` : "全部通过"}（${ran} 条用例）`);
process.exit(fail ? 1 : 0);
