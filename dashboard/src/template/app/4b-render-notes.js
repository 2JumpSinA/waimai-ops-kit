/* ══════ 分片 4b-render-notes.js · 渲染：口径与来源说明 ══════ */
/* ── 口径说明 ── */
function drawNotes() {
  $("notes").innerHTML = "<b>口径与来源说明</b><br>" +
    (VM.notes ?? []).map((n) => "· " + n.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")).join("<br>") +
    (proj().warnings?.length ? `<br>· 本项目数据缺口：${esc(proj().warnings.join("；"))}` : "");
}

