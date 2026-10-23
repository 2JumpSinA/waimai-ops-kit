/**
 * 数据链路健康闸门：把「文件有多旧」和「步骤成功没成功」合成一个可编程的结论。
 *
 * 为什么需要它（2026-10-21 实测故障）：
 *   品牌B的美团链路自 2026-10-14 08:30 起连续 7 天全步骤失败
 *   （stores+panels / today / exposure / promotion / income-30d-daily 全部 exit 非 0），
 *   5 个 data/raw 文件停在 10-14，但：
 *     · refresh-failures-yifeng.txt 里有 7 行失败，没人读；
 *     · freshness.mjs 早就能算出售期，但它是纯打印脚本，不 exit 非 0，不进任何自动化；
 *     · 看板照常渲染，用的是一周前的旧数，没有任何提示。
 *   这个脚本就是那个「读它们、并让退出码说话」的东西。
 *
 * 用法：
 *   node src/check-gate.mjs                 # 人读报告
 *   node src/check-gate.mjs --json          # 机器读（给播报/看板消费）
 *   node src/check-gate.mjs --quiet         # 只在有问题时输出
 *   node src/check-gate.mjs --account=yifeng
 *
 * 退出码（供 .ps1 / 计划任务判定）：
 *   0 = 全部正常
 *   1 = 有告警（数据过期 / 步骤失败 1~2 次）
 *   2 = 有故障（步骤连续失败 ≥3 次 / 数据源缺失 / 过期超过 3 倍阈值）
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { surveySources, summarize, fmtAge, ACCOUNTS } from "./lib/sources.mjs";
import { summarizeAccount } from "./lib/runstate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");

/**
 * 豁免清单。没有它，闸门第一版就把两件事报成红色噪音：
 *   · income-orderlist 是「对账用」数据，本来就不需要每天更新；
 *   · 品牌B的 taobao-stores-detail / taobao-stats 是**平台侧限制**（protein 家族对该账号
 *     恒定 FAIL_SYS_SERVICE_INNER_FAULT），不是本地能修的东西。
 * 告警一旦长期挂着假阳性，人就会开始忽略它 —— 那比没有告警更糟。
 * 但豁免必须逐条写 reason，且只豁免「有记录的平台限制 / 非看板数据」，
 * 本地故障（例如品牌B整条美团链）一律不豁免。
 */
const CONFIG_PATH = join(ROOT, "src", "gate.config.json");
let gateCfg = { noGate: [], waive: [] };
try {
  if (existsSync(CONFIG_PATH)) gateCfg = { ...gateCfg, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
} catch (e) {
  console.error(`[gate] 读不了 gate.config.json（${e.message}），按无豁免运行 —— 可能出现已知噪音。`);
}
const noGateStems = new Set((gateCfg.noGate ?? []).map((x) => (typeof x === "string" ? x : x.stem)));
const waiveOf = (account, file) => (gateCfg.waive ?? []).find((w) => w.account === account && w.source === file);
/**
 * ⭐ 步骤层豁免（2026-10-21 补）。
 *
 * 原先 `waive` 只按**输出文件名**匹配。但平台侧限制体现在**步骤**上：
 * 品牌B的 `shangou-detail-yifeng` / `shangou-stats-yifeng` 两个步骤恒定 exit 2
 * （protein 家族对 nodeType=2 SUPPLIER 不可用），文件层已豁免，步骤层却还在报 🟡。
 * 结果每次刷新都挂两条永远消不掉的告警 —— 告警一多就没人看了，
 * 这跟「静默失败」是同一种病，只是一个太吵一个太安静。
 */
const waiveStepOf = (account, step) => (gateCfg.waive ?? []).find((w) => w.account === account && w.step === step);
const waived = [];


const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);
const asJson = has("json");
const quiet = has("quiet");
const onlyAccount = arg("account");

const SEV = { OK: 0, WARN: 1, FAIL: 2 };
let worst = SEV.OK;
const findings = [];

const bump = (level, finding) => {
  findings.push({ level, ...finding });
  if (SEV[level] > worst) worst = SEV[level];
};

// ── 1. 文件新鲜度 ────────────────────────────────────────────────
let survey = null;
try {
  survey = surveySources(RAW);
} catch (e) {
  bump("FAIL", { kind: "raw-dir", message: `读不到 data/raw：${e.message}` });
}

let fresh = null;
// 只统计「参与闸门」的项：豁免的和 noGate 的不进汇总，
// 否则「最旧的一项是……（对账用数据）」会把人的注意力从真故障上带走。
const gatedStale = [];
const gatedMissing = [];
if (survey) {
  fresh = summarize(survey);
  for (const s of fresh.missing) {
    if (onlyAccount && s.account !== onlyAccount) continue;
    const w = waiveOf(s.account, s.file);
    if (w) {
      waived.push({ account: s.account, source: s.file, label: s.label, kind: "missing", reason: w.reason });
      continue;
    }
    gatedMissing.push(s);
    bump("FAIL", {
      kind: "missing-source",
      account: s.account,
      accountLabel: s.accountLabel,
      source: s.file,
      label: s.label,
      message: `${s.accountLabel} · ${s.label}：文件缺失（${s.file}）`,
    });
  }
  for (const s of fresh.stale) {
    if (onlyAccount && s.account !== onlyAccount) continue;
    if (noGateStems.has(s.stem)) continue;
    const w = waiveOf(s.account, s.file);
    if (w) {
      waived.push({ account: s.account, source: s.file, label: s.label, kind: "stale", ageText: s.ageText, reason: w.reason });
      continue;
    }
    gatedStale.push(s);
    const over = s.age / s.warn;
    /**
     * `neverFail` 的源（见 sources.mjs 里 today 的注释）永不因过期判 FAIL：
     * 过期只说明「数字不够新」，不代表链路坏了；坏了由步骤层报。
     * 不加这一条，每天下午都会固定红一次，告警就失去意义。
     */
    const level = s.neverFail ? "WARN" : over >= 3 ? "FAIL" : "WARN";
    bump(level, {
      kind: "stale-source",
      account: s.account,
      accountLabel: s.accountLabel,
      source: s.file,
      label: s.label,
      ageHours: Number(s.age.toFixed(2)),
      ageText: s.ageText,
      warnHours: s.warn,
      overFactor: Number(over.toFixed(2)),
      message: `${s.accountLabel} · ${s.label}：已 ${s.ageText} 未更新（建议 ${s.warn}h，超 ${over.toFixed(1)} 倍）`,
    });
  }
}
const gatedWorst = gatedStale.slice().sort((a, b) => b.age - a.age)[0] ?? null;

// ── 2. 步骤运行状态（首次运行 state 目录可能还不存在，降级为只看文件） ──
const accounts = onlyAccount ? ACCOUNTS.filter((a) => a.key === onlyAccount) : ACCOUNTS;
const stateSummaries = accounts.map((a) => {
  const sum = summarizeAccount(ROOT, a.key);
  for (const st of sum.steps) {
    if (st.missing) continue;
    if (st.ok) continue;
    // 步骤层豁免优先：已知平台限制不该每次都喊一遍
    const wStep = waiveStepOf(a.key, st.step);
    if (wStep) {
      waived.push({ account: a.key, step: st.step, source: null, label: st.step, kind: "step-failed", reason: wStep.reason });
      continue;
    }
    const level = st.consecutiveFailures >= 3 ? "FAIL" : "WARN";
    bump(level, {
      kind: "step-failed",
      account: a.key,
      accountLabel: a.label,
      step: st.step,
      exitCode: st.exitCode,
      consecutiveFailures: st.consecutiveFailures,
      lastSuccessAt: st.lastSuccessAt,
      message:
        `${a.label} · ${st.step}：连续失败 ${st.consecutiveFailures} 次（exit ${st.exitCode}）` +
        (st.lastSuccessAt ? `，最后成功 ${new Date(st.lastSuccessAt).toLocaleString("zh-CN")}` : "，从未成功"),
      note: st.note,
    });
  }
  return { account: a.key, label: a.label, ...sum };
});

// ── 3. 输出 ─────────────────────────────────────────────────────
const payload = {
  checkedAt: new Date().toISOString(),
  worst,
  verdict: worst === SEV.FAIL ? "FAIL" : worst === SEV.WARN ? "WARN" : "OK",
  findings,
  waived,
  freshness: fresh
    ? {
        stale: gatedStale.length,
        missing: gatedMissing.length,
        waived: waived.length,
        worst: gatedWorst
          ? { file: gatedWorst.file, account: gatedWorst.account, label: gatedWorst.label, ageText: gatedWorst.ageText }
          : null,
      }
    : null,
  steps: stateSummaries.map((s) => ({
    account: s.account,
    label: s.label,
    failing: s.failing.map((f) => ({
      step: f.step,
      exitCode: f.exitCode,
      consecutiveFailures: f.consecutiveFailures,
      lastSuccessAt: f.lastSuccessAt,
    })),
  })),
};

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else if (!quiet || worst !== SEV.OK) {
  console.log("");
  console.log("  数据链路健康闸门");
  console.log(`  ${new Date().toLocaleString("zh-CN")}`);
  console.log("");

  if (worst === SEV.OK) {
    console.log("  ✅ 全部正常：数据都在建议间隔内，所有步骤上次都是成功的。");
  } else {
    const order = { FAIL: 0, WARN: 1 };
    const sorted = findings.slice().sort((a, b) => {
      const d = order[a.level] - order[b.level];
      if (d !== 0) return d;
      if (a.accountLabel !== b.accountLabel) return String(a.accountLabel).localeCompare(String(b.accountLabel), "zh");
      return String(a.label).localeCompare(String(b.label), "zh");
    });
    for (const f of sorted) {
      const icon = f.level === "FAIL" ? "🔴" : "🟡";
      console.log(`  ${icon} ${f.message}`);
      if (f.note) console.log(`       ↳ ${f.note}`);
    }
  }

  if (gatedStale.length || gatedMissing.length) {
    console.log("");
    console.log(`  ── 汇总：${gatedStale.length} 项过期、${gatedMissing.length} 项缺失（已剔除豁免项） ──`);
    if (gatedWorst) {
      console.log(`     最旧：${gatedWorst.accountLabel} · ${gatedWorst.label}（${gatedWorst.ageText}）`);
    }
  }

  if (waived.length) {
    console.log("");
    console.log(`  ── 已豁免 ${waived.length} 项（已知平台限制 / 非看板数据） ──`);
    for (const w of waived) console.log(`     · ${w.source ?? w.step}（${w.kind === "missing" ? "缺失" : w.kind === "step-failed" ? "步骤失败" : w.ageText}）`);
  }

  console.log("");
  console.log(`  退出码 ${worst}（0=正常 1=告警 2=故障）`);
  console.log("");
}

process.exit(worst);
