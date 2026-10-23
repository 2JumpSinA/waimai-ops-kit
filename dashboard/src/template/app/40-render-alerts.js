/* ══════ 分片 40-render-alerts.js · 渲染：顶部严重提示 ══════ */
/* ── 严重提示（取消率异常、数据缺口）── */
function drawAlerts() {
  const p = proj();
  const out = [];
  const T = VM.thresholds;
  const w7 = p.windows.d7, wt = p.windows.today;
  // 项目间对比：取消率显著偏高
  const other = VM.projectOrder.filter((k) => k !== CUR_PROJ).map((k) => VM.projects[k]);
  for (const o of other) {
    const ow = o.windows.d7;
    if (w7?.cancelRate != null && ow?.cancelRate != null && w7.cancelRate > ow.cancelRate * T.cancelRateAlertFactor && w7.cancelRate > T.cancelRateAlertFloor) {
      out.push(`<b>取消率异常</b>：${esc(p.label)} 近 7 天取消率 <b>${fmt(w7.cancelRate)}%</b>，
        是 ${esc(o.label)}（${fmt(ow.cancelRate)}%）的 ${fmt(w7.cancelRate / (ow.cancelRate || 1), 1)} 倍。建议优先排查。</br>`);
    }
  }
  /**
   * ✅ 已核实（2026-09-22，用 `_recon/struct/frozen` 冻结数据复算）：
   *   这条**不是**缺陷，**不需要**改。
   *   · `&&` 左假即短路 —— `selfCheck` 为 `null` 时右侧 `null !== 0` **根本不会被求值`，
   *     所以不会出现「selfCheck 缺失 → 弹出假红警」。
   *   · 真实数据里 `income-{quanyi,yifeng}.json` 的 `selfCheck` 都是**对象**且
   *     `projectedIncomeDiff === 0`，判据求值为 `false` → 不弹警。
   *   · 唯一需要注意的边界：若某天 `projectedIncomeDiff` 真的非 0，这里会如实报警（这是期望行为）。
   *   （一度被当成 bug 提出来，复核后撤回；保留这段注释以免下次又被重复怀疑。）
   */
  if (p.income.selfCheck && p.income.selfCheck.projectedIncomeDiff !== 0) {
    out.push(`<b>收入口径自校验未通过</b>：本脚本 Σ预计收入与官方 settleIncome 差 ${p.income.selfCheck.projectedIncomeDiff} 元，需复查。</br>`);
  }
  // 曝光现在是平台总口径（单账号全量），缺了就是整个面板④没数
  const noExpo = !p.exposure?.windows?.today;
  if (noExpo) out.push(`<b>曝光数据缺失</b>：本项目的平台总曝光未取到，「大盘曝光变化」为空。</br>`);
  $("alerts").innerHTML = out.length ? `<div class="alert">${out.join("")}</div>` : "";
}

