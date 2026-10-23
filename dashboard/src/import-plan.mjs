/**
 * 把人工台账（双平台评分跟进.xlsx）导入成机器可读名单，并与实时接口交叉校对。
 *   node src/import-plan.mjs
 *
 * 依据方法论底座第十二步 / 第十六步：
 *   - 台账提供的是**接口给不了**的信息：「规划内暂未上线」vs「异常掉线」
 *   - 匹配分层：平台ID → 备用ID → 归一化店名（全角半角必须归一）
 *   - 原因白名单**必须可配置**，不能散落成 if/else 硬编码
 *   - 人工补充规则单独放一个文件，**不被导入覆盖**
 *   - 交叉校对做成导入的**副产品**，每次刷新导出就自动校验一遍
 *
 * ⚠️⚠️ 为什么全篇按**列下标**取值，不按列名：
 *   两张表的表头都有重名列 ——
 *     品牌B：[3][9][13] 都叫「店名」，[4][10] 都叫「是否上线」
 *     品牌A：[5][16]「评分」、[6][17]「30天订单」、[9][18]「营业状态」
 *   `toObjects()` 是按列名建对象的，**后者覆盖前者**。
 *   实测后果：旧版导入把「营业状态」取成了**饿了么那一列**，
 *   而 `r["营业状态.1"]` 永远 undefined（并不会自动加序号后缀）。
 *   所以这里一律用下标，列名只作注释。
 *
 * 产出（都不含凭据，可提交）：
 *   data/plan/plan-stores.json       品牌A台账（规范化）
 *   data/plan/yifeng-stores.json     品牌B台账（规范化）
 *   data/plan/stores-unified.json    台账 ∪ 接口 统一门店视图（看板数据源）
 *   data/plan/anomalies.json         异常未营业明细
 *   data/plan/known_offline.json     排除名单（机器读，勿手改）
 *   data/plan/manual_exclusions.json 人工补充（**导入不覆盖**）
 *   data/plan/import-report.md       交叉校对报告
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readXlsx } from "./lib/xlsx.mjs";
import { isMissingValue } from "./lib/caliber.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_XLSX = join(ROOT, "_recon", "xlsx", "plan.xlsx");
const OUT_DIR = join(ROOT, "data", "plan");

/**
 * 原因白名单 —— 可配置，且需要用户裁决。
 * 「正常」= 规划内未上线，不计异常；但仍计入"未营业"总数，只在剔除明细里可见。
 */
const NORMAL_REASONS = [
  "闭店", "迁址中", "搬迁中", "上线中", "无资质",
  "转单", "铺货", "暂不上线", "当前铺货，后续转单", "当地监管，转护理液门店",
  "商机失效", "上线锁", "非法人经营",
];
/** 需要关注的原因（资质/监管类）—— 与"正常"互斥，命中即计入风险 */
const ATTENTION_REASONS = [
  "医疗器械许可证过期", "执照吊销", "药品许可证即将过期", "药师注册证过期",
];

/**
 * ⭐ 列下标映射（唯一真源）。
 * `offlineReason` = 台账里**唯一**表达「为什么没营业」的那一列：
 *   品牌A →「备注」([12])      品牌B →「下线原因2」([16])
 * 而「铺货批次」/「眼镜店上线规划」是**规划处置**（打算怎么办），不是未营业原因。
 */
const COLS = {
  品牌A: {
    city: 0, code: 1, tbNameAlt: 2,
    mtId: 3, mtName: 4, mtRating: 5, mtOrders30d: 6, stockoutRate: 7, careLiquidStock: 8,
    mtStatus: 9, onlineDate: 10, mtCommentCount: 11,
    offlineReason: 12, batch: 13,
    tbId: 14, tbName: 15, tbRating: 16, tbOrders30d: 17, tbStatus: 18,
  },
  品牌B: {
    city: 0, code: 1,
    mtId: 2, mtName: 3, mtStatus: 4, rating: 5, stockoutDelta: 6, orders7d: 7,
    tbId: 8, tbName: 9, tbStatus: 10,
    planNote: 11, transferTo: 12,
    packStoreName: 13, packStoreStatus: 14, packStoreId: 15,
    offlineReason: 16, judgment: 17,
  },
};
const PROJECT_OF_SHEET = { 品牌A: "quanyi", 品牌B: "yifeng" };

/** 店名归一化：全角半角括号、连字符、空白、大小写 */
const norm = (s) =>
  String(s ?? "")
    .replace(/（/g, "(").replace(/）/g, ")")
    .replace(/[－—–]/g, "-")
    .replace(/\s+/g, "")
    .toLowerCase();

/** Excel 序列号 → YYYY-MM-DD（东八区，不用 toISOString） */
function excelDate(serial) {
  if (typeof serial !== "number" || !isFinite(serial) || serial < 20000) return serial || "";
  const ms = Math.round((serial - 25569) * 86400_000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(ms));
}

const cell = (row, i) => {
  const v = row?.[i];
  return v === undefined || v === null ? "" : String(v).trim();
};

/** 线上营业状态是否算「营业中」 */
const LIVE_OPEN = /营业中/;
const isLiveOpen = (s) => LIVE_OPEN.test(String(s ?? ""));
/**
 * 是否**确定**为未营业。
 * ⚠️ 空/缺失状态必须算「未知」，不能算未营业 ——
 *   闪购的门店节点接口压根不返回营业状态（`stores[]` 只有 name/city/nodeType…），
 *   早期版本把空状态判成未营业，一下多报出 170 多家里有 175 家是假的。
 */
const isLiveClosed = (s) => {
  const v = String(s ?? "").trim();
  // ⚠️ 缺失值标记（#N/A、N/A、空、— 等）算「未知」，不算未营业。
  //    根治于 2026-09-22（data-structure R2）：台账里 "#N/A" 曾被当成「未营业」。
  return !isMissingValue(v) && !isLiveOpen(v);
};

// ────────────────── 1. 读台账 ──────────────────
console.log("读取台账…");
const { sheets } = readXlsx(PLAN_XLSX);
const get = (n) => sheets.find((s) => s.name === n);
for (const n of ["品牌A", "品牌B"]) {
  if (!get(n)) {
    console.error(`台账缺少工作表「${n}」。现有：${sheets.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
}
const bodyRows = (s) => s.rows.slice(1).filter((r) => r && r.some((c) => String(c ?? "").trim() !== ""));

const stores = [];

for (const row of bodyRows(get("品牌A"))) {
  const C = COLS.品牌A;
  const offlineReason = cell(row, C.offlineReason);
  const batch = cell(row, C.batch);
  /** reasons 保持旧口径的并集，仅用于「分类」；offlineReason 单独留出来给「异常未营业」判定 */
  const reasons = [...new Set([offlineReason, batch].filter((x) => x && !/^[\d,]+$/.test(x)))];
  stores.push({
    sourceSheet: "品牌A",
    project: "quanyi",
    city: cell(row, C.city),
    code: cell(row, C.code),
    mtId: cell(row, C.mtId),
    mtName: cell(row, C.mtName),
    mtStatus: cell(row, C.mtStatus),
    mtRating: cell(row, C.mtRating),
    mtOrders30d: cell(row, C.mtOrders30d),
    stockoutRate: cell(row, C.stockoutRate),
    onlineDate: excelDate(row?.[C.onlineDate]),
    tbId: cell(row, C.tbId),
    tbName: cell(row, C.tbName),
    tbStatus: cell(row, C.tbStatus),
    tbOrders30d: cell(row, C.tbOrders30d),
    offlineReason,
    planNote: batch,
    judgment: "",
    reasons,
  });
}

for (const row of bodyRows(get("品牌B"))) {
  const C = COLS.品牌B;
  const offlineReason = cell(row, C.offlineReason);
  const planNote = cell(row, C.planNote);
  const judgment = cell(row, C.judgment);
  const reasons = [...new Set([planNote, offlineReason, judgment].filter(Boolean))];
  stores.push({
    sourceSheet: "品牌B",
    project: "yifeng",
    city: cell(row, C.city),
    code: cell(row, C.code),
    mtId: cell(row, C.mtId),
    mtName: cell(row, C.mtName),
    mtStatus: cell(row, C.mtStatus),
    mtRating: cell(row, C.rating),
    mtOrders30d: cell(row, C.orders7d),
    stockoutRate: cell(row, C.stockoutDelta),
    onlineDate: "",
    tbId: cell(row, C.tbId),
    tbName: cell(row, C.tbName),
    tbStatus: cell(row, C.tbStatus),
    tbOrders30d: "",
    offlineReason,
    planNote,
    judgment,
    transferTo: cell(row, C.transferTo),
    packStoreName: cell(row, C.packStoreName),
    packStoreStatus: cell(row, C.packStoreStatus),
    reasons,
  });
}

console.log(
  `  台账共 ${stores.length} 条：品牌A ${stores.filter((s) => s.project === "quanyi").length}、` +
    `品牌B ${stores.filter((s) => s.project === "yifeng").length}`,
);

// ────────────────── 2. 分类 ──────────────────
const classify = (reasons, offlineReason, judgment) => {
  const pool = [offlineReason, judgment, ...reasons].filter(Boolean);
  const hitAttention = pool.filter((x) => ATTENTION_REASONS.some((k) => x.includes(k)));
  if (hitAttention.length) return { kind: "attention", reason: [...new Set(hitAttention)].join(" + ") };
  const hitNormal = pool.filter((x) => NORMAL_REASONS.some((k) => x.includes(k)));
  if (hitNormal.length) return { kind: "normal_offline", reason: [...new Set(hitNormal)].join(" + ") };
  if (pool.length) return { kind: "unknown", reason: [...new Set(pool)].join(" + ") };
  return { kind: "planned", reason: "" };
};
for (const s of stores) Object.assign(s, classify(s.reasons, s.offlineReason, s.judgment));

const quanyi = stores.filter((s) => s.project === "quanyi");
const yifeng = stores.filter((s) => s.project === "yifeng");

/**
 * 「重复建店」识别：店名以 `-数字` 结尾（右括号前或字符串末尾）。用户确认：这类门店**剔除看板**。
 * ⚠️ 底座文档第十二步的教训：官方 19 家「重复建店」里只有 11 家带该后缀，
 * 所以这**不是完整判据**，只能作为线索。命中即剔除，但报告里要给出全量清单供人工复核。
 */
const DUP_STORE_RE = /-\d+(?=\)|$)/;
const isDup = (name) => DUP_STORE_RE.test(String(name ?? "").replace(/）\s*$/, ")"));

// ────────────────── 3. 与实时接口交叉校对 ──────────────────
const loadJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const RAW = (n) => join(ROOT, "data", "raw", n);

/** 各项目对应的实时接口快照 */
const LIVE = {
  quanyi: { mt: loadJson(RAW("meituan-quanyi.json")), tb: loadJson(RAW("taobao-quanyi.json")) },
  yifeng: { mt: loadJson(RAW("meituan-yifeng.json")), tb: loadJson(RAW("taobao-yifeng.json")) },
};

const mtOf = (p) => LIVE[p].mt?.stores ?? [];
const tbOf = (p) => LIVE[p].tb?.stores ?? [];
const tbIdOf = (s) => String(s.nodeBusinessId ?? s.id ?? "");

console.log("\n线上接口快照：");
for (const p of ["quanyi", "yifeng"]) {
  const label = p === "quanyi" ? "品牌A" : "品牌B";
  const mt = LIVE[p].mt, tb = LIVE[p].tb;
  console.log(
    `  ${label}  美团 ${mt ? mtOf(p).length + " 家" : "（无数据）"}   ` +
      `闪购 ${tb ? tbOf(p).length + " 家" : "（无数据）"}`,
  );
}

/**
 * 统一门店视图：台账 ∪ 接口，逐条给出归属与处置。
 * 用户确认的口径：
 *   - 接口有、台账无          → `unplanned` 未规划门店（保留展示，但标注）
 *   - 店名带 `-数字`          → `duplicate` 重复建店（**剔除看板**）
 *   - 台账有原因              → normal_offline / attention
 *   - 其余                    → planned
 *
 * ⭐ 异常未营业（经营者 2026-09-18 裁决）：
 *   「台账中未标注未营业原因的，线上实际营业状态是未营业的门店」
 *   → live 状态非「营业中」 且 offlineReason 为空。
 *   台账里根本没登记的门店（unplanned）也算「未标注原因」，一并纳入。
 */
const unified = [];

for (const project of ["quanyi", "yifeng"]) {
  const planRows = project === "quanyi" ? quanyi : yifeng;
  const mtStores = mtOf(project), tbStores = tbOf(project);
  const mtById = new Map(mtStores.map((s) => [String(s.id), s]));
  const tbById = new Map(tbStores.map((s) => [tbIdOf(s), s]));
  const planMtIds = new Set(planRows.map((s) => s.mtId).filter(Boolean));
  const planTbIds = new Set(planRows.map((s) => s.tbId).filter(Boolean));

  for (const s of planRows) {
    const mtLive = s.mtId ? mtById.get(s.mtId) ?? null : null;
    const tbLive = s.tbId ? tbById.get(s.tbId) ?? null : null;
    const dupMt = isDup(s.mtName), dupTb = isDup(s.tbName);
    /**
     * 状态取值优先级：接口 > 台账列。
     * `from` 记录状态到底是哪来的 —— 台账列是**人工维护**的，不等于「线上实际状态」，
     * 报告里必须能区分，否则会把台账没更新当成门店掉线。
     */
    const liveMtStatus = mtLive?.status ?? s.mtStatus ?? "";
    const tbApiStatus = tbLive?.status ?? "";
    const liveTbStatus = tbApiStatus || s.tbStatus || "";
    const mtStatusFrom = mtLive ? "接口" : s.mtStatus ? "台账" : "";
    const tbStatusFrom = tbApiStatus ? "接口" : s.tbStatus ? "台账" : "";
    const mtOffline = !!s.mtId && isLiveClosed(liveMtStatus);
    const tbOffline = !!s.tbId && isLiveClosed(liveTbStatus);
    const noReason = !s.offlineReason;
    unified.push({
      project,
      city: s.city,
      code: s.code,
      mtId: s.mtId,
      mtName: s.mtName,
      tbId: s.tbId,
      tbName: s.tbName,
      status: s.mtStatus || s.tbStatus,
      reasons: s.reasons,
      kind: s.kind,
      reason: s.reason,
      offlineReason: s.offlineReason,
      planNote: s.planNote,
      judgment: s.judgment ?? "",
      planned: true,
      duplicate: dupMt || dupTb,
      duplicateOf: dupMt ? "meituan" : dupTb ? "eleme" : "",
      live: {
        meituan: !!mtLive,
        eleme: !!tbLive,
        mtStatus: liveMtStatus,
        tbStatus: liveTbStatus,
        mtStatusFrom,
        tbStatusFrom,
      },
      /** 异常未营业：线上未营业 + 台账未写原因 */
      anomaly: {
        meituan: mtOffline && noReason,
        eleme: tbOffline && noReason,
      },
    });
  }

  // 接口有、台账没有 → unplanned（台账无记录 = 未标注原因）
  for (const s of mtStores) {
    if (planMtIds.has(String(s.id))) continue;
    const off = isLiveClosed(s.status);
    unified.push({
      project, city: s.city, code: "",
      mtId: String(s.id), mtName: s.name, tbId: "", tbName: "",
      status: s.status ?? "",
      reasons: [], kind: "unplanned", reason: "未规划（台账中无此门店）",
      offlineReason: "", planNote: "", judgment: "",
      planned: false,
      duplicate: isDup(s.name), duplicateOf: isDup(s.name) ? "meituan" : "",
      live: { meituan: true, eleme: false, mtStatus: s.status ?? "", tbStatus: "", mtStatusFrom: "接口", tbStatusFrom: "" },
      anomaly: { meituan: off, eleme: false },
    });
  }
  for (const s of tbStores) {
    if (planTbIds.has(tbIdOf(s))) continue;
    const off = isLiveClosed(s.status);
    unified.push({
      project, city: s.city, code: "",
      mtId: "", mtName: "", tbId: tbIdOf(s), tbName: s.name,
      status: s.status ?? "",
      reasons: [], kind: "unplanned", reason: "未规划（台账中无此门店）",
      offlineReason: "", planNote: "", judgment: "",
      planned: false,
      duplicate: isDup(s.name), duplicateOf: isDup(s.name) ? "eleme" : "",
      live: { meituan: false, eleme: true, mtStatus: "", tbStatus: s.status ?? "", mtStatusFrom: "", tbStatusFrom: s.status ? "接口" : "" },
      anomaly: { meituan: false, eleme: off },
    });
  }
}

const keep = unified.filter((s) => !s.duplicate);
const dropped = unified.filter((s) => s.duplicate);

/** 异常未营业明细（剔除重复建店后） */
const anomalies = keep.filter((s) => s.anomaly.meituan || s.anomaly.eleme);

// ────────────────── 4. 落盘 ──────────────────
mkdirSync(OUT_DIR, { recursive: true });
const W = (name, obj) => writeFileSync(join(OUT_DIR, name), JSON.stringify(obj, null, 2), "utf8");

W("plan-stores.json", quanyi);
W("yifeng-stores.json", yifeng);
W("stores-unified.json", unified);
W(
  "anomalies.json",
  {
    generatedAt: new Date().toISOString(),
    caliber:
      "异常未营业 = 线上营业状态非「营业中」 且 台账未标注未营业原因（品牌A取「备注」列，品牌B取「下线原因2」列）；台账未登记的门店视为未标注原因",
    count: anomalies.length,
    byProject: {
      quanyi: anomalies.filter((s) => s.project === "quanyi").length,
      yifeng: anomalies.filter((s) => s.project === "yifeng").length,
    },
    items: anomalies,
  },
);

// 排除名单（机器读）
const knownOffline = {
  generatedAt: new Date().toISOString(),
  source: "双平台评分跟进.xlsx",
  note: "由 import-plan 生成，勿手改 —— 人工补充请写 manual_exclusions.json",
  normalReasons: NORMAL_REASONS,
  attentionReasons: ATTENTION_REASONS,
  byProject: {},
};
for (const project of ["quanyi", "yifeng"]) {
  const bucket = { byMeituanId: {}, byElemeId: {}, byNormName: {} };
  for (const s of (project === "quanyi" ? quanyi : yifeng)) {
    if (s.kind === "planned") continue;
    const entry = { reason: s.reason, kind: s.kind, city: s.city, name: s.tbName || s.mtName };
    if (s.mtId) bucket.byMeituanId[s.mtId] = entry;
    if (s.tbId) bucket.byElemeId[s.tbId] = entry;
    for (const n of [s.tbName, s.mtName]) if (n) bucket.byNormName[norm(n)] = entry;
  }
  knownOffline.byProject[project] = bucket;
}
W("known_offline.json", knownOffline);

W("exclusions.json", {
  generatedAt: new Date().toISOString(),
  rule: "店名匹配 /-\\d+(?=\\)|$)/ —— 重复建店，用户确认剔除看板",
  warn: "底座文档第十二步：官方「重复建店」中约 4/10 不带该后缀，故此规则漏报率不低，仅作线索",
  count: dropped.length,
  items: dropped.map((s) => ({
    project: s.project,
    name: s.mtName || s.tbName,
    id: s.mtId || s.tbId,
    platform: s.duplicateOf,
    city: s.city,
  })),
});

const manualPath = join(OUT_DIR, "manual_exclusions.json");
if (!existsSync(manualPath)) {
  W("manual_exclusions.json", {
    _note:
      "人工补充的排除规则。导入台账**不会**覆盖本文件。查询顺序：台账ID → 人工ID → 台账店名 → 人工店名 → 正则。",
    namePatterns: [{ pattern: "-\\d+(?=\\)?$)", reason: "重复建店(-N 后缀)", enabled: true }],
    byPlatform: { meituan: { ids: {}, names: {} }, eleme: { ids: {}, names: {} } },
  });
  console.log("  已创建 manual_exclusions.json（人工补充，不会被导入覆盖）");
}

// ────────────────── 5. 报告 ──────────────────
const breakdown = (arr, key) => {
  const m = {};
  for (const s of arr) {
    const k = s[key] || "(无)";
    m[k] = (m[k] ?? 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};
const L = [];
const P = (s = "") => {
  L.push(s);
  console.log(s);
};
const projName = (p) => (p === "quanyi" ? "品牌A" : "品牌B");

for (const project of ["quanyi", "yifeng"]) {
  const rows = project === "quanyi" ? quanyi : yifeng;
  const uni = unified.filter((s) => s.project === project);
  const anom = anomalies.filter((s) => s.project === project);

  P("\n" + "═".repeat(70));
  P(`  【${projName(project)}】台账分类`);
  P("═".repeat(70));
  for (const [k, v] of breakdown(rows, "kind")) P(`  ${String(v).padStart(4)}  ${k}`);
  P("\n  按原因明细（底座第十二步：这张表要能逐条核对）：");
  for (const [k, v] of breakdown(rows.filter((s) => s.reason), "reason")) P(`    ${String(v).padStart(4)}  ${k}`);

  P("\n" + "═".repeat(70));
  P(`  【${projName(project)}】统一门店视图（台账 ∪ 接口）`);
  P("═".repeat(70));
  for (const [k, v] of breakdown(uni, "kind")) P(`  ${String(v).padStart(4)}  ${k}`);
  P(`\n  合计 ${uni.length} 条`);
  P(`  剔除（重复建店 -N）${uni.filter((s) => s.duplicate).length} 条 → 不进看板`);
  P(`  保留            ${uni.filter((s) => !s.duplicate).length} 条 → 进看板`);

  P("\n" + "═".repeat(70));
  P(`  【${projName(project)}】交叉校对：台账 vs 实时接口`);
  P("═".repeat(70));
  const hasMt = rows.filter((s) => s.mtId), hasTb = rows.filter((s) => s.tbId);
  const mtLive = new Set(mtOf(project).map((s) => String(s.id)));
  const tbLive = new Set(tbOf(project).map(tbIdOf));
  P(`  台账 ${rows.length} 条`);
  P(`     美团 台账有id ${hasMt.length} → 命中接口 ${hasMt.filter((s) => mtLive.has(s.mtId)).length}`);
  P(`     闪购 台账有id ${hasTb.length} → 命中接口 ${hasTb.filter((s) => tbLive.has(s.tbId)).length}`);
  const mtExtra = mtOf(project).filter((s) => !new Set(rows.map((x) => x.mtId)).has(String(s.id)));
  const tbExtra = tbOf(project).filter((s) => !new Set(rows.map((x) => x.tbId)).has(tbIdOf(s)));
  P(`  接口有、台账没有（未规划）：美团 ${mtExtra.length} 家，闪购 ${tbExtra.length} 家`);

  const both = rows.filter((s) => s.mtId && s.tbId && mtLive.has(s.mtId) && tbLive.has(s.tbId));
  const onlyMt = rows.filter((s) => s.mtId && !s.tbId && mtLive.has(s.mtId));
  const onlyTb = rows.filter((s) => s.tbId && !s.mtId && tbLive.has(s.tbId));
  P(`\n  渠道覆盖差异：两边都有ID且在线 ${both.length}   只美团 ${onlyMt.length}   只闪购 ${onlyTb.length}`);

  P("\n" + "═".repeat(70));
  P(`  【${projName(project)}】异常未营业（经营者口径）`);
  P("═".repeat(70));
  P(`  口径：线上非「营业中」 且 台账未写未营业原因（${project === "quanyi" ? "备注" : "下线原因2"}列为空）`);
  P(`  合计 ${anom.length} 家`);
  const bySrc = {};
  for (const s of anom) {
    if (s.anomaly.meituan) bySrc[`美团(${s.live.mtStatusFrom})`] = (bySrc[`美团(${s.live.mtStatusFrom})`] ?? 0) + 1;
    if (s.anomaly.eleme) bySrc[`闪购(${s.live.tbStatusFrom || "无状态"})`] = (bySrc[`闪购(${s.live.tbStatusFrom || "无状态"})`] ?? 0) + 1;
  }
  P(`  状态来源：${JSON.stringify(bySrc)}`);
  if (bySrc["闪购(台账)"] || bySrc["闪购(无状态)"]) {
    P(`  ⚠️ 闪购侧门店节点接口不返回营业状态，上表若标「台账」= 用的是台账人工列，**不等于线上实际状态**；`);
    P(`     标「无状态」= 两侧都没有状态，根本无从判定，严格说应列「无法判定」而非「异常」。`);
  }
  for (const s of anom) {
    const plat = [
      s.anomaly.meituan ? `美团:${s.live.mtStatus}(${s.live.mtStatusFrom})` : "",
      s.anomaly.eleme ? `闪购:${s.live.tbStatus || "无状态"}(${s.live.tbStatusFrom || "无"})` : "",
    ].filter(Boolean).join(" ");
    P(`     · [${plat}] ${s.mtName || s.tbName || s.mtId || s.tbId}  [${s.city}]  ${s.planned ? "台账已登记" : "台账未登记"}`);
  }

  const droppedP = dropped.filter((s) => s.project === project);
  P("\n" + "═".repeat(70));
  P(`  【${projName(project)}】剔除清单（重复建店）—— 请人工复核，此规则会漏报`);
  P("═".repeat(70));
  for (const s of droppedP) P(`  · [${s.duplicateOf}] ${s.mtName || s.tbName}  id=${s.mtId || s.tbId}  [${s.city}]`);
}

// ⚠️ 这里**不能**用上面那个 W() —— W 是 JSON.stringify 写 .json，
//    报告要的是纯文本，用 W 会把整篇写成一行转义串。
writeFileSync(join(OUT_DIR, "import-report.md"), L.join("\n"), "utf8");
P(`\n报告   data/plan/import-report.md`);
P(`名单   data/plan/known_offline.json`);
P(`异常   data/plan/anomalies.json`);
P(`视图   data/plan/stores-unified.json（看板数据源）`);
