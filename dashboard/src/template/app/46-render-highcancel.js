/* ══════ 分片 46-render-highcancel.js · 渲染：③ 近7天高取消门店 ══════ */
/* ── ③ 高取消门店（R12：平台切换 + 城市筛选 + 表头排序 + 城市列） ── */
/** 面板本地状态（独立于页级平台切换器 CUR_PLATFORM —— 与卡片内窗口切换器同模式） */
let HC_PLATFORM = "all"; // all | meituan | shangou，默认全部平台
let HC_CITY = ""; // "" = 全部城市
let HC_SORT = { key: "rate", dir: -1 }; // 默认 = 取消率降序（与数据层原始顺序一致 → 首屏稳定）
const HC_PLATS = [
  { key: "all", label: "全部平台" },
  { key: "meituan", label: "美团" },
  { key: "shangou", label: "闪购" },
];

/** unifiedStores 的城市索引（渲染期现算，不动数据层）：
 *  ⭐ 美团 byPoi 的 poiId = 美团门店 ID → unifiedStores.mtId 精确匹配优先；
 *     匹配不上（如台账外门店）再按**归一化店名**兜底；再没有才显示「—」。
 *     归一化与门店表筛选同规则（去「市」后缀 + 小写，R10）。 */
function hcCityIndex() {
  const p = proj();
  const byId = new Map(), byName = new Map();
  for (const s of p.unifiedStores ?? []) {
    if (s.mtId != null && s.city) byId.set(String(s.mtId), s.city);
    if (s.name && s.city) byName.set(normCity(s.name), s.city);
  }
  return { byId, byName };
}
function hcCityOf(row, idx) {
  return idx.byId.get(String(row.poiId)) ?? idx.byName.get(normCity(row.poiName)) ?? null;
}

/** 美团行：highCancelD7 已由数据层按「单量≥5 且有取消、按取消率取前 30」过滤 */
function hcMeituanRows(idx) {
  return (proj().highCancelD7 ?? []).map((s) => ({
    plat: "meituan", platLabel: "美团",
    name: s.poiName || s.poiId, city: hcCityOf(s, idx),
    orders: s.orders, cancel: s.cancel, rate: s.rate, amt: s.income,
    bad: s.rate >= VM.thresholds.poiCancelRateBad,
  }));
}

/** 闪购行：`taobao.stores` = 闪购「近7日」窗口逐店（口径：取消=流失订单、金额=成交额）。
 *  与美团同门槛（单量≥5 且有取消）、同排序（取消率降序取前 30），但 ⛔ 与美团不可相加。 */
function hcShangouRows() {
  return (proj().taobao?.stores ?? [])
    .filter((s) => (s.orders ?? 0) >= 5 && (s.invalid ?? 0) > 0)
    .map((s) => ({
      plat: "shangou", platLabel: "闪购",
      name: s.name, city: s.city ?? null,
      orders: s.orders, cancel: s.invalid,
      rate: (s.rate ?? 0) / 100, // stores.rate 已是百分数（r2 保留 2 位）→ 归一回小数
      amt: s.amt,
      bad: (s.rate ?? 0) / 100 >= VM.thresholds.poiCancelRateBad,
    }))
    .sort((a, b) => b.rate - a.rate || b.cancel - a.cancel)
    .slice(0, 30);
}

/** ⭐ R23（2026-09-24 经营者指示）：「全部平台」= 同名门店跨平台**合并**（取代并列展示）——
 *  取消单 = 美团取消 + 闪购流失；取消率 = 合计取消 ÷ 合计订单（分母含两平台总单）。
 *  预计收入：合并店仅含美团（闪购逐店只有成交额，不混入口径，如实标注）。
 *  门槛与排序仍为 单量≥5、取消率降序前 30。
 *
 *  ⭐ 匹配键 v2（同日数据实测迭代）：两平台店名**主体有修饰词差异** ——
 *    美团「镜像子账号(示例分店)」vs 闪购「镜像子账号(示例分店)」，
 *    完整店名匹配 0 命中。实测（品牌A 09-24）三级匹配：
 *    ① 精确 = 城市 + 归一化品牌（去「健康药房/大药房/药房/医药/连锁」修饰词）+ 分店名（括号内去「店/药店」）→ 18/30；
 *    ② 模糊 = 同城同品牌下分店名**双向包含**且候选唯一（防「人民路 ⊆ 新人民路」误配）→ 再 +11/30；
 *    ③ 回退 = 完整店名精确匹配（覆盖无括号店名）。剩余 1 家闪购侧确无对应 → 保持美团单平台（诚实降级）。
 *    品牌B：闪购 protein 全家族账号特异性失败（nodeType=2 SUPPLIER，见 refresh-all.ps1 09-22 调查），
 *    逐店数据缺失 → 全部平台下仅展示美团榜（数据现实，非逻辑缺陷）。 */
const HC_MODS = /(健康药房|大药房|药房|医药|连锁)/g;
function hcBranchOf(name) {
  const m = String(name ?? "").match(/[（(]([^（）()]+)[)）]/);
  return m ? m[1].replace(/(药店|店)$/, "").replace(/\s+/g, "").toLowerCase() : null;
}
function hcBrandOf(name) {
  return String(name ?? "").split(/[（(]/)[0].replace(HC_MODS, "").replace(/\s+/g, "").toLowerCase();
}
function hcKey(name, city) {
  return `${String(name ?? "").replace(/\s+/g, "").toLowerCase()}|${normCity(city ?? "")}`;
}
function hcMergedRows(idx) {
  const p = proj();
  const tbAll = p.taobao?.stores ?? [];
  // ① 闪购侧索引：城市|品牌 → 门店数组（精确/模糊匹配的候选池）
  const tbByCityBrand = new Map();
  for (const s of tbAll) {
    const ck = `${normCity(s.city ?? "")}|${hcBrandOf(s.name)}`;
    if (!tbByCityBrand.has(ck)) tbByCityBrand.set(ck, []);
    tbByCityBrand.get(ck).push(s);
  }
  const mergedTb = new Set(); // 已被合并的闪购店（排除出「闪购独有」）
  const rows = [];
  for (const s of p.highCancelD7 ?? []) {
    const city = hcCityOf(s, idx);
    const branch = hcBranchOf(s.poiName);
    const brand = hcBrandOf(s.poiName);
    // ② 三级匹配（见函数头注释）
    const cands = city != null ? tbByCityBrand.get(`${normCity(city)}|${brand}`) ?? [] : [];
    let tbs = branch != null ? cands.filter((x) => hcBranchOf(x.name) === branch) : [];
    if (!tbs.length && branch != null) {
      const fuzzy = cands.filter((x) => {
        const b = hcBranchOf(x.name);
        return b && (b.includes(branch) || branch.includes(b));
      });
      if (fuzzy.length === 1) tbs = fuzzy; // 候选不唯一 → 宁可不合并（诚实降级）
    }
    if (!tbs.length && city != null) {
      const k = hcKey(s.poiName, city);
      tbs = tbAll.filter((x) => hcKey(x.name, x.city) === k);
    }
    const tbOrders = tbs.reduce((a, x) => a + (x.orders ?? 0), 0);
    const tbCancel = tbs.reduce((a, x) => a + (x.invalid ?? 0), 0);
    const orders = (s.orders ?? 0) + tbOrders;
    const cancel = (s.cancel ?? 0) + tbCancel;
    if (orders < 5 || cancel <= 0) continue;
    const rate = orders ? cancel / orders : 0;
    for (const x of tbs) mergedTb.add(x);
    rows.push({
      plat: tbs.length ? "both" : "meituan",
      platLabel: tbs.length ? "美团+闪购" : "美团",
      name: s.poiName || s.poiId, city,
      orders, cancel, rate,
      amt: s.income, // 合并店预计收入仅含美团（闪购逐店无预计收入）
      bad: rate >= VM.thresholds.poiCancelRateBad,
    });
  }
  // ③ 闪购独有门店（未被任何美团高取消榜店合并，但闪购侧有流失）
  for (const tbs of [tbAll]) {
    for (const x of tbs) {
      if (mergedTb.has(x)) continue;
      const orders = x.orders ?? 0, cancel = x.invalid ?? 0;
      if (orders < 5 || cancel <= 0) continue;
      const rate = orders ? cancel / orders : 0;
      rows.push({
        plat: "shangou", platLabel: "闪购",
        name: x.name, city: x.city ?? null,
        orders, cancel, rate,
        amt: x.amt ?? 0,
        bad: rate >= VM.thresholds.poiCancelRateBad,
      });
    }
  }
  return rows.sort((a, b) => b.rate - a.rate || b.cancel - a.cancel).slice(0, 30);
}

function drawHighCancel() {
  const p = proj();
  const idx = hcCityIndex();
  // ⭐ R23：全部平台 = 同名门店跨平台合并；美团 / 闪购视图保持各自独立（并列展示仅在这两视图的说明里已不适用）
  const allRows = HC_PLATFORM === "all" ? hcMergedRows(idx) : [...hcMeituanRows(idx), ...hcShangouRows()];

  // ① 平台过滤
  const platRows = allRows.filter((r) => HC_PLATFORM === "all" || r.plat === HC_PLATFORM);

  // ② 城市下拉（选项来自当前平台下的行 → 不会选出一个 0 行的城市）
  const cities = [...new Set(platRows.map((r) => r.city).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), "zh"));
  if (HC_CITY && !cities.some((c) => normCity(c) === normCity(HC_CITY))) HC_CITY = "";

  // ③ 城市过滤（两侧都归一化，与门店表 R10 同规则）
  let rows = platRows.filter((r) => !HC_CITY || (r.city && normCity(r.city) === normCity(HC_CITY)));

  // ④ 排序
  const { key, dir } = HC_SORT;
  rows = rows.slice().sort((a, b) => {
    if (key === "plat") return String(a.platLabel).localeCompare(String(b.platLabel), "zh") * dir;
    const x = a[key], y = b[key];
    // 数值列缺失排最后；文本列按中文拼音
    if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
    return String(x ?? "").localeCompare(String(y ?? ""), "zh") * dir;
  });

  // ⑤ 控件：平台切换段（每次重建并重绑，量小；与其它卡片内切换器同款式）
  const seg = $("hcPlatSeg");
  if (seg) {
    seg.innerHTML = "";
    for (const pf of HC_PLATS) {
      const b = document.createElement("button");
      b.dataset.k = pf.key;
      b.textContent = pf.label;
      b.classList.toggle("active", HC_PLATFORM === pf.key);
      b.onclick = () => { HC_PLATFORM = pf.key; drawHighCancel(); };
      seg.appendChild(b);
    }
  }
  const sel = $("hcCitySel");
  if (sel) {
    sel.innerHTML = '<option value="">全部城市</option>' +
      cities.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    sel.value = HC_CITY;
    sel.onchange = () => { HC_CITY = sel.value || ""; drawHighCancel(); };
  }

  // ⑥ 标题计数 + 副标题口径说明（跟当前平台走）
  $("highCancelTag").textContent = `${rows.length} 家`;
  const platNote =
    HC_PLATFORM === "shangou"
      ? "闪购：取消=流失订单、金额=成交额（近 7 日窗口；⛔ 与美团口径不同不可相加）"
      : HC_PLATFORM === "meituan"
        ? "美团：取消率 = 取消单数 ÷ 该店总单数"
        : "全部平台 = 同店跨平台合并（按城市+分店名，品牌去药房修饰）：取消单 = 美团取消 + 闪购流失；取消率 = 合计取消 ÷ 合计订单；预计收入仅含美团";
  $("highCancelSub").textContent =
    `仅列近 7 天单量 ≥ 5 且有取消的门店 · ${platNote}` + (HC_CITY ? ` · 城市：${HC_CITY}` : "");

  // ⑦ 表格
  if (!rows.length) {
    $("highCancelWrap").innerHTML =
      '<div class="empty">近 7 天无满足条件的门店（单量≥5 且有取消' +
      (HC_PLATFORM !== "all" ? `，平台=${HC_PLATS.find((x) => x.key === HC_PLATFORM)?.label ?? HC_PLATFORM}` : "") +
      (HC_CITY ? `，城市=${esc(HC_CITY)}` : "") + "）</div>";
    return;
  }
  const arrow = (k) => (HC_SORT.key === k ? (HC_SORT.dir > 0 ? " ▲" : " ▼") : "");
  const platCol = HC_PLATFORM === "all" ? `<th data-h="plat">平台${arrow("plat")}</th>` : "";
  $("highCancelWrap").innerHTML =
    `<table><thead><tr><th>门店</th>${platCol}<th data-h="city">城市${arrow("city")}</th>` +
    `<th data-h="orders" class="num">总单${arrow("orders")}</th>` +
    `<th data-h="cancel" class="num">取消${arrow("cancel")}</th>` +
    `<th data-h="rate" class="num">取消率${arrow("rate")}</th>` +
    `<th data-h="amt" class="num">预计收入${arrow("amt")}</th></tr></thead><tbody>` +
    rows
      .map((s) => {
        // 平台徽标：美团=info 灰蓝 / 闪购=warn 橙 / 合并店=both 紫（R23 新增，一眼区分三态）
        const pillCls = s.plat === "meituan" ? "info" : s.plat === "both" ? "both" : "warn";
        const pill =
          HC_PLATFORM === "all"
            ? `<td><span class="pill ${pillCls}">${s.platLabel}</span></td>`
            : "";
        return `<tr><td class="wrap">${esc(s.name)}</td>${pill}
          <td>${esc(s.city ?? "—")}</td>
          <td class="num">${int(s.orders)}</td><td class="num">${int(s.cancel)}</td>
          <td class="num" ${s.bad ? 'style="color:#e8543f;font-weight:600"' : ""}>${fmt(s.rate * 100)}%</td>
          <td class="num">${fmt(s.amt)}</td></tr>`;
      })
      .join("") +
    "</tbody></table>";

  // ⑧ 表头排序绑定（首点：数值列降序、文本列升序；再点同列切换方向）
  $("highCancelWrap")
    .querySelectorAll("th[data-h]")
    .forEach((th) => {
      th.style.cursor = "pointer";
      th.onclick = () => {
        const k = th.dataset.h;
        HC_SORT = { key: k, dir: HC_SORT.key === k ? -HC_SORT.dir : k === "city" || k === "plat" ? 1 : -1 };
        drawHighCancel();
      };
    });
}
