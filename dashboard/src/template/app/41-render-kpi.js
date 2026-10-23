/* ══════ 分片 41-render-kpi.js · 渲染：KPI 卡片 + 收入口径短句 ══════ */
/* ── KPI ── */
/**
 * ⭐ 收入口径的短语必须**跟着数据来源走**，而且文案本身来自 `VM.caliber`（口径单一真相源）。
 *   历史事故：这里原先硬编码「Σ 逐单 finalSettlementAmount（剔除已取消）」，
 *   而美团侧早已改为**平台聚合**（manageHome/core 的 multiProjectedIncome）——
 *   数字来自平台、说明却写逐单求和，等于对用户说谎。
 *   现在只做一件事：拿项目自报的 source 去 `VM.caliber.income.shortBySource` 里查短语。
 *
 * ⭐⭐ R20（2026-09-24 经营者指示）：KPI 七卡**随平台切换器变化**：
 *   · 闪购视图 → drawKpisShangou（数据层 `taobao.kpiWindows`，口径见 dashboard-model.mjs R20 注释）；
 * ⭐⭐ R21（同日，经营者指示）：**「全部平台」= 美团 + 闪购 合计**（取代 R20 的「美团口径+标注」）——
 *   数据层 `kpiAll`，取消单 = 美团取消单 + 闪购流失单（等同处理），ROI = 1 ÷ 推广占比；
 *   · 美团视图 → 美团口径（原样）。
 */
function incomeCaliberShort(p) {
  const c = VM.caliber.income;
  const s = p.income?.source ?? null;
  return c.shortBySource[s ?? "null"] ?? c.algoBySource[s] ?? c.algoUnknown;
}

/** 七卡统一落 DOM（各平台共用同一结构，样式/骨架不漂移） */
function emitKpiCards(items) {
  $("kpis").innerHTML = items.map((it) =>
    `<div class="card kpi"><div class="lab"><span>${it.lab}</span>${it.badge ?? ""}</div>
     <div class="val" ${it.danger ? 'style="color:#e8543f"' : ""}>${it.val}<em>${it.unit}</em></div>
     <div class="foot">${it.foot}</div></div>`).join("");
}

function drawKpis() {
  if (isShangouView()) return drawKpisShangou();
  if (CUR_PLATFORM === "all") return drawKpisAll();
  const w = win();
  const T = VM.thresholds;
  const P = VM.caliber.promo;
  const promoFoot = (fallback) => (w.promoUnavailable ? P.unavailableNote : fallback);
  const items = [
    { lab: "预计收入", val: fmt(w.projectedIncome), unit: "元", foot: "口径：" + incomeCaliberShort(proj()) },
    { lab: "订单数", val: int(w.orderCount), unit: "单", foot: `其中有效 ${int(w.validOrderCount)} 单` },
    { lab: "取消单", val: int(w.cancelCount), unit: "单",
      foot: `取消率 ${w.cancelRate == null ? "—" : fmt(w.cancelRate) + "%"}`, danger: w.cancelRate >= T.cancelRateDanger },
    { lab: "客单价", val: fmt(w.avgOrderValue), unit: "元", foot: "预计收入 ÷ 有效单数" },
    { lab: "推广消耗", val: w.promoCost == null ? "—" : fmt(w.promoCost), unit: w.promoCost == null ? "" : "元",
      foot: w.promoLive
        ? `${esc(P.liveShort)} · 曝光 ${int(w.promoShow)} · 点击 ${int(w.promoClick)}`
        : promoFoot(w.promoShow == null ? "无推广数据" : `曝光 ${int(w.promoShow)} · 点击 ${int(w.promoClick)}`) },
    { lab: "推广占比", val: w.promoRatio == null ? "—" : fmt(w.promoRatio), unit: w.promoRatio == null ? "" : "%",
      foot: promoFoot(P.formulaText),
      danger: w.promoRatio != null && w.promoRatio >= T.promoRatioWarn },
    { lab: "推广 ROI", val: w.promoRoi == null ? "—" : fmt(w.promoRoi), unit: "",
      /** ⭐ R13：口径改本看板计算（预计收入 ÷ 推广消耗），今日也现算，不再有「次日才有」 */
      foot: promoFoot(esc(P.roiNote)) },
  ];
  emitKpiCards(items);
}

/** ⭐⭐ R21：「全部平台」= 美团 + 闪购 **合计**（管理口径，经营者 2026-09-24 指示；数据层 kpiAll）。 */
function drawKpisAll() {
  const T = VM.thresholds;
  const K = VM.caliber.kpiAll ?? {};
  const w = proj().kpiAll?.[CUR_WIN] ?? null;
  if (!w || (w.projectedIncome == null && w.promoCost == null)) {
    $("kpis").innerHTML =
      `<div class="card kpi" style="grid-column:1/-1"><div class="lab"><span>全部平台 KPI</span></div>
       <div class="val">—</div><div class="foot">${esc(K.noDataNote ?? "该窗口无合计 KPI 数据")}</div></div>`;
    return;
  }
  // 每卡带「美团+闪购」小标：明示这是两平台合计的管理口径
  const badge = '<span class="kpiPlat">美团+闪购</span>';
  const items = [
    { lab: "预计收入", badge, val: fmt(w.projectedIncome), unit: "元", foot: esc(K.incomeShort ?? "") },
    // ⭐ R21b（2026-09-24 经营者指示）：订单数卡改「有效订单数」= 美团有效订单数 + 闪购有效订单
    { lab: "有效订单数", badge, val: int(w.validOrderCount), unit: "单", foot: esc(K.orderFoot ?? "") },
    { lab: "取消单", badge, val: int(w.cancelCount), unit: "单",
      foot: `取消率 ${w.cancelRate == null ? "—" : fmt(w.cancelRate) + "%"} ${esc(K.cancelFoot ?? "")}`,
      danger: w.cancelRate != null && w.cancelRate >= T.cancelRateDanger },
    { lab: "客单价", badge, val: fmt(w.avgOrderValue), unit: "元", foot: esc(K.avgFoot ?? "") },
    { lab: "推广消耗", badge, val: w.promoCost == null ? "—" : fmt(w.promoCost), unit: w.promoCost == null ? "" : "元",
      foot: w.promoCost == null
        ? esc(K.noDataNote ?? "无推广数据")
        : `曝光 ${int(w.promoShow)} · 点击 ${int(w.promoClick)} · ${esc(K.promoCostFoot ?? "")}` },
    { lab: "推广占比", badge, val: w.promoRatio == null ? "—" : fmt(w.promoRatio), unit: w.promoRatio == null ? "" : "%",
      foot: esc(K.promoRatioFoot ?? ""),
      danger: w.promoRatio != null && w.promoRatio >= T.promoRatioWarn },
    { lab: "推广 ROI", badge, val: w.promoRoi == null ? "—" : fmt(w.promoRoi), unit: "",
      foot: esc(K.roiFoot ?? "") },
  ];
  emitKpiCards(items);
}

/** ⭐⭐ R20：闪购视图的 KPI 七卡 —— 数据层 `taobao.kpiWindows[CUR_WIN]`（与美团同构、口径闪购自有）。 */
function drawKpisShangou() {
  const T = VM.thresholds;
  const K = VM.caliber.tbKpi ?? {};
  const kw = proj().taobao?.kpiWindows ?? null;
  const w = kw?.[CUR_WIN] ?? null;
  if (!w || (w.projectedIncome == null && w.promoCost == null)) {
    // 如实降级：没有编数字（例如 MDA 与推广数据都缺失时）
    $("kpis").innerHTML =
      `<div class="card kpi" style="grid-column:1/-1"><div class="lab"><span>闪购 KPI</span></div>
       <div class="val">—</div><div class="foot">${esc(K.noDataNote ?? "闪购该窗口无 KPI 数据")}</div></div>`;
    return;
  }
  const items = [
    { lab: "预计收入", val: fmt(w.projectedIncome), unit: "元", foot: "口径：" + esc(K.incomeShort ?? "") },
    { lab: "订单数", val: int(w.orderCount), unit: "单", foot: esc(K.orderFoot ?? "有效订单（闪购口径）") },
    { lab: "取消单", val: int(w.cancelCount), unit: "单",
      foot: `流失率 ${w.cancelRate == null ? "—" : fmt(w.cancelRate) + "%"}${esc(K.cancelFootSuffix ?? "")}`,
      danger: w.cancelRate != null && w.cancelRate >= T.cancelRateDanger },
    { lab: "客单价", val: fmt(w.avgOrderValue), unit: "元", foot: esc(K.avgFoot ?? "预计收入 ÷ 有效订单") },
    { lab: "推广消耗", val: w.promoCost == null ? "—" : fmt(w.promoCost), unit: w.promoCost == null ? "" : "元",
      foot: w.promoLive
        ? `${esc(K.promoLiveShort ?? "T+0 实时")} · 曝光 ${int(w.promoShow)} · 点击 ${int(w.promoClick)}`
        : w.promoCost == null
          ? esc(K.noPromoNote ?? "该窗口无闪购推广数据")
          : `曝光 ${int(w.promoShow)} · 点击 ${int(w.promoClick)}` },
    { lab: "推广占比", val: w.promoRatio == null ? "—" : fmt(w.promoRatio), unit: w.promoRatio == null ? "" : "%",
      foot: esc(K.promoRatioFoot ?? ""),
      danger: w.promoRatio != null && w.promoRatio >= T.promoRatioWarn },
    { lab: "推广 ROI", val: w.promoRoi == null ? "—" : fmt(w.promoRoi), unit: "",
      foot: esc(K.roiFoot ?? "") },
  ];
  emitKpiCards(items);
}
