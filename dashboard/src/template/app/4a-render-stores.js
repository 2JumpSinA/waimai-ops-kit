/* ══════ 分片 4a-render-stores.js · 渲染：全部门店表（含排序 / 筛选） ══════ */
/* ── 门店表 ── */
let STORE_SORT = { key: "name", dir: 1 };
/**
 * 城市名归一化（⭐ R10）：台账里「杭州」与「杭州市」两种写法并存（实测 9 组），
 *   原先筛选是**字面包含**比对 → 输入「杭州」会漏掉所有写成「杭州市」的门店。
 *   这里把**筛选词与门店城市两边都归一**（去「市」后缀 + 小写）再比。
 *   只影响匹配，**不改显示的原始城市名**。
 *   归一化实现与 `src/lib/caliber.mjs` 的 `normCity` 同规则（两侧必须一致，否则又会对不上）。
 */
const normCity = (v) => String(v ?? "").trim().replace(/市$/, "").toLowerCase();
function storeRows() {
  const p = proj();
  const list = (p.unifiedStores ?? []);
  const q = normCity($("storeFilter").value);
  let rows = list.filter((s) => !q || (s.name || "").toLowerCase().includes(q) || normCity(s.city).includes(q));
  const { key, dir } = STORE_SORT;
  rows = rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === "number" || typeof y === "number") return ((x ?? 0) - (y ?? 0)) * dir;
    return String(x ?? "").localeCompare(String(y ?? ""), "zh") * dir;
  });
  return rows;
}
function drawStores() {
  const rows = storeRows();
  const arrow = (k) => STORE_SORT.key === k ? (STORE_SORT.dir > 0 ? " ▲" : " ▼") : "";
  $("storeTag").textContent = `${rows.length} 家`;
  $("storeWrap").innerHTML = rows.length
    ? `<table><thead><tr>
        <th data-s="name">门店名称${arrow("name")}</th><th data-s="city">城市${arrow("city")}</th>
        <th data-s="kind">台账分类${arrow("kind")}</th>
        <th>渠道</th><th data-s="mtStatus">美团状态${arrow("mtStatus")}</th>
        <th data-s="d7orders" class="num">近7天单${arrow("d7orders")}</th>
        <th data-s="d7cancelRate" class="num">取消率${arrow("d7cancelRate")}</th>
      </tr></thead><tbody>` +
      rows.map((s) => `<tr>
        <td class="wrap">${esc(s.name)}</td><td>${esc(s.city ?? "")}</td>
        <td><span class="pill ${s.kind === "attention" ? "off" : s.kind === "normal_offline" ? "warn" : "info"}">${esc(s.kindLabel)}</span></td>
        <td>${[s.mtId ? "美团" : "", s.tbId ? "闪购" : ""].filter(Boolean).map((x) => `<span class="pill info">${x}</span>`).join(" ") || "—"}</td>
        <td>${s.mtStatus ? `<span class="pill ${/营业中/.test(s.mtStatus) ? "on" : "off"}">${esc(s.mtStatus)}</span>` : "—"}</td>
        <td class="num">${s.d7orders == null ? "—" : int(s.d7orders)}</td>
        <td class="num" ${s.d7cancelRate >= VM.thresholds.storeCancelRateBad ? 'style="color:#e8543f;font-weight:600"' : ""}>${s.d7cancelRate == null ? "—" : fmt(s.d7cancelRate) + "%"}</td>
      </tr>`).join("") + "</tbody></table>"
    : '<div class="empty">没有匹配的门店</div>';
  $("storeWrap").querySelectorAll("th[data-s]").forEach((th) => {
    th.style.cursor = "pointer";
    th.onclick = () => {
      const k = th.dataset.s;
      STORE_SORT = { key: k, dir: STORE_SORT.key === k ? -STORE_SORT.dir : 1 };
      drawStores();
    };
  });
}

