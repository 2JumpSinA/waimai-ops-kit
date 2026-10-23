/* ══════ 分片 42-render-cancel.js · 渲染：① 取消单变化 ══════ */
/* ── ① 取消单变化 ── */
function drawCancel() {
  const p = proj();
  const w7 = p.windows.d7, wt = p.windows.today, wy = p.windows.yesterday;
  const t = p.today;
  const cards = [
    { k: "今日（截至 " + (p.dataTime || "—").slice(-8) + "）", n: wt?.cancelCount, r: wt?.cancelRate,
      s: `共 ${int(wt?.orderCount)} 单` },
    { k: "近 1 小时", n: t?.recentHour?.cancel, r: t ? t.recentHour.rate * 100 : null,
      s: t ? `近1小时下单 ${int(t.recentHour.orders)} 单` : "无实时数据" },
    { k: "近 7 天", n: w7?.cancelCount, r: w7?.cancelRate,
      s: `共 ${int(w7?.orderCount)} 单 · 日均 ${w7 ? fmt(w7.cancelCount / 7, 1) : "—"} 单` },
  ];
  $("cancelCards").innerHTML = cards.map((c) => {
    const bad = c.r != null && c.r >= VM.thresholds.cancelCardBad;
    return `<div class="kv" style="grid-template-columns:1fr"><div style="${bad ? "border-color:#f7c9c0;background:#fff8f6" : ""}">
      <div class="k">${esc(c.k)}</div>
      <div class="v" ${bad ? 'style="color:#e8543f"' : ""}>${int(c.n)}<span style="font-size:12px;color:#6b7691"> 单</span>
        <span style="font-size:12px;color:${bad ? "#e8543f" : "#6b7691"}"> · ${c.r == null ? "—" : fmt(c.r) + "%"}</span></div>
      <div class="k" style="margin-top:3px">${esc(c.s)}</div></div></div>`;
  }).join("");
  const peak = (p.income.daily ?? []).slice().sort((a, b) => b.cancelRate - a.cancelRate)[0];
  $("cancelTag").textContent = peak ? `近30天最高 ${peak.date} ${fmt(peak.cancelRate)}%` : "";
  const cmp = VM.projectOrder.filter((k) => k !== CUR_PROJ)
    .map((k) => `${VM.projects[k].label} 近7天 ${fmt(VM.projects[k].windows.d7?.cancelRate)}%`).join(" · ");
  $("cancelSub").innerHTML =
    `「近1小时」口径：下单时间落在近 1 小时内的订单中已取消的（平台无「取消时刻」字段，` +
    `故不等于「近1小时内发生的取消」）。对比：${esc(cmp)}。` +
    (wy ? ` 昨日 ${int(wy.cancelCount)} 单 / ${fmt(wy.cancelRate)}%。` : "");
}

