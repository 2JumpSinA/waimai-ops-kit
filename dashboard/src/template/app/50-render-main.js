/* ══════ 分片 50-render-main.js · 主渲染：render() 统一调度各面板 ══════ */
/* ── 主渲染 ── */

/** ⭐ R24（2026-09-24 经营者：数据获取不稳定 → 新鲜度必须上屏）：
 *  页首数据新鲜度徽标。以**当前项目的 dataTime**（美团数据的采集时点）为基准：
 *  🟢 2h 内（ok）→ 🟡 2-6h（warn）→ 🔴 超 6h（no）。解析失败/缺失 → 中性灰。
 *  挂 60s 定时器：页面挂着不动，徽标也会随时间推移变色（陈旧是被"看出来"的，不是被"发现"的）。 */
function drawFreshBadge() {
  const el = $("freshBadge");
  const p = proj();
  const t = p.dataTime ? new Date(String(p.dataTime).replace(" ", "T")) : null;
  if (!t || isNaN(t)) { el.className = "badge"; el.textContent = "新鲜度未知"; return; }
  const ageMin = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
  const hh = Math.floor(ageMin / 60), mm = ageMin % 60;
  const ageTxt = hh >= 1 ? `${hh}h${mm ? " " + mm + "m" : ""} 前` : `${mm}m 前`;
  if (ageMin < 120)      { el.className = "badge ok";   el.textContent = `🟢 数据新鲜（${ageTxt}采集）`; }
  else if (ageMin < 360) { el.className = "badge warn"; el.textContent = `🟡 数据较旧（${ageTxt}采集）`; }
  else                   { el.className = "badge no";   el.textContent = `🔴 数据陈旧（${ageTxt}采集）`; }
}
setInterval(drawFreshBadge, 60_000);

function render() {
  const p = proj();
  $("brand").textContent = ` · ${p.fullLabel}`;
  $("dataTime").textContent = p.dataTime || "—";
  $("genAt").textContent = VM.generatedAt || "—";
  drawFreshBadge();
  $("acctBadge").textContent = `acctId ${p.acctId ?? "—"}`;
  $("storeBadge").textContent = `美团门店 ${p.mtStores.length} 家` +
    (p.taobao ? ` · 闪购 ${p.taobao.storeCount} 家` : " · 闪购未接入");
  $("caliberBadge").textContent = `收入口径：预计收入（自校验差 ${p.income.selfCheck?.projectedIncomeDiff ?? "—"} 元）`;
  // 趋势图副标题也跟数据来源走，别让「平台给的数」配着「逐单求和」的说明
  // ⭐ R22：「全部平台」= 美团 + 闪购 合计口径，页首收入口径短句随之切换
  $("incomeCaliberSub").textContent = "口径：" +
    (CUR_PLATFORM === "all" ? (VM.caliber.trendAll?.income ?? incomeCaliberShort(p)) : incomeCaliberShort(p));

  // 切换器状态（窗口 + 平台各一组，都要与各自的状态同步）
  $("projSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === CUR_PROJ));
  syncWinSegs();
  syncPlatSegs();

  drawAlerts();
  drawKpis();
  drawCancel();
  drawTrends();
  drawKa();
  drawExposure();
  drawHighCancel();
  drawStores();
  drawSelfCheck();
  drawNotes();
}

