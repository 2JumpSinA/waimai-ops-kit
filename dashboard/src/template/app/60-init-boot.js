/* ══════ 分片 60-init-boot.js · 启动：拼装 unifiedStores、生成切换器、绑事件、首次 render ══════ */
/* ── 启动 ── */
(function init() {
  const KIND_LABEL = { normal_offline: "正常未营业", attention: "需关注", planned: "规划中", unplanned: "未规划", unknown: "未分类" };
  // 把台账统一视图 + 近7天门店单量/取消率拼到每个项目上（一次算好，渲染时直接用）
  // ⚠️ 2026-09-21：这里的「门店曝光」一列已撤下 —— 曝光改成平台总口径后就没有门店维度了
  //    （逐店那个接口是排行度量，与平台总曝光不是一回事，见 drawExposure 顶部注释）。
  for (const k of VM.projectOrder) {
    const p = VM.projects[k];
    const uni = (p.unifiedRows ?? []);
    const d7 = new Map((p.income.byPoiD7 ?? []).map((x) => [String(x.poiId), x]));
    p.unifiedStores = uni.map((s) => {
      const id = String(s.mtId || s.tbId || "");
      const c = d7.get(String(s.mtId)) ?? d7.get(String(s.tbId));
      /**
       * ⛔ D-1（2026-09-22 修）：原先这里读 `s.mtName || s.tbName` 与 `s.live?.mtStatus`，
       *    但 `unifiedRows`（build-dashboard 的 `buildProjectModel`）产出的字段是
       *    `name` / `mtStatus`，**没有** `mtName`/`tbName`/`live`。
       *    后果：门店表「门店名称」列显示的是**门店 ID**、「美团状态」列**恒为 `—`**、
       *    店名筛选实际在筛 ID。
       *    修在**模板侧**而不是改 build 的字段名：`unifiedRows` 已是数据契约，
       *    `verify-dashboard.mjs` 等消费方都依赖它，改生产者牵动面更大。
       *    parity 的 VM 读集探针（Proxy）现在会自动抓这类「读到的恒为 undefined」的漂移。
       */
      return {
        name: s.name || id,
        city: s.city ?? "",
        kind: s.kind,
        kindLabel: KIND_LABEL[s.kind] ?? s.kind,
        mtId: s.mtId, tbId: s.tbId,
        mtStatus: s.mtStatus ?? "",
        d7orders: c?.orders ?? null,
        d7cancelRate: c ? c.rate * 100 : null,
      };
    });
  }

  const projSeg = $("projSeg");
  for (const k of VM.projectOrder) {
    const b = document.createElement("button");
    b.dataset.k = k; b.textContent = VM.projects[k].label;
    b.onclick = () => { CUR_PROJ = k; render(); };
    projSeg.appendChild(b);
  }
  /**
   * 窗口切换器：顶部 1 个 + 四个图表卡片里各 1 个（2026-09-22 新增）。
   * 卡片内那个是为了**不用滚回页首**就能换窗口；点击后统一走 render()，
   * 由 `syncWinSegs()` 把 5 个切换器的 active 状态一起对齐。
   * 窗口列表由 build 注入的 `VM.caliber.windowDefs` 驱动 —— 单一真相源（口径集中化 P4）。
   */
  for (const id of WIN_SEG_IDS) {
    const seg = $(id);
    if (!seg) continue;
    for (const w of VM.caliber.windowDefs) {
      const b = document.createElement("button");
      b.dataset.k = w.key; b.textContent = w.label;
      b.onclick = () => { CUR_WIN = w.key; render(); };
      seg.appendChild(b);
    }
  }
  /**
   * 平台切换器：全部平台 / 美团 / 闪购（默认全部平台）—— 与窗口切换器同样的模式。
   * ⛔「全部平台」是**并列展示**，不是相加；列表同样由 `VM.caliber.platformDefs` 驱动。
   */
  for (const id of PLAT_SEG_IDS) {
    const seg = $(id);
    if (!seg) continue;
    for (const pf of VM.caliber.platformDefs) {
      const b = document.createElement("button");
      b.dataset.k = pf.key; b.textContent = pf.label;
      b.onclick = () => { CUR_PLATFORM = pf.key; render(); };
      seg.appendChild(b);
    }
  }
  $("storeFilter").addEventListener("input", drawStores);
  window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));
  render();
  initRefresh();
})();

