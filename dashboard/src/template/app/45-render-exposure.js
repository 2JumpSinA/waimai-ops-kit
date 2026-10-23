/* ══════ 分片 45-render-exposure.js · 渲染：④ 大盘曝光（平台总口径，跟随窗口） ══════ */
/** ⭐⭐ R22（2026-09-24 经营者指示）：「全部平台」曝光 = 美团 + 闪购 合计。
 *   数据可用性：闪购 MDA flowDaily 只有**逐日曝光人数（UV）**、无逐日 PV ——
 *   所以「曝光人数」曲线 = 两平台按日求和；「曝光次数」柱 = 美团（如实标注，不编数）。
 *   说明区遵循 R18：固定两行内。窗口小表改列合计值（d7/d30 的闪购 PV 用 flowWindows 窗口值，最新日 PV 仅美团）。 */
function drawExposureAll(p) {
  const N = VM.caliber.trendAll ?? {};
  const daily = p.trendAll?.expo?.daily ?? [];
  const hourly = isHourWin(CUR_WIN);
  $("expoTag").textContent = dimTagDailyOnly(CUR_WIN);
  $("expoSub").innerHTML = esc(N.expo ?? "");
  $("expoTopSub").textContent = "窗口小表：近7/近30天为两平台合计（闪购 PV 取 MDA 流量窗口），最新日 PV 仅美团。";
  if (!daily.length) {
    $("c-expo").innerHTML = '<div class="empty">该窗口无曝光数据</div>';
    $("expoTopWrap").innerHTML = '<div class="empty">合计曝光未取到</div>';
    return;
  }
  let src, hit = null;
  if (hourly) {
    src = daily.slice(-7);
    const sel = selectedDay(p, CUR_WIN);
    const selLabel = sel ? String(sel).slice(5) : null;
    hit = selLabel && src.some((d) => String(d.date).slice(5) === selLabel) ? selLabel : null;
  } else {
    src = CUR_WIN === "d7" ? daily.slice(-7) : daily;
  }
  chart("c-expo", {
    grid: GRID, legend: LEGEND, tooltip: { trigger: "axis" },
    xAxis: AXIS(src.map((d) => String(d.date).slice(5))),
    yAxis: [YAXIS("曝光次数"), YAXIS("曝光人数", { position: "right", splitLine: { show: false } })],
    series: markSel([
      { name: "曝光次数（美团）", type: "bar", data: src.map((d) => d.pv), barMaxWidth: 12,
        itemStyle: { color: "#c9dcff", borderRadius: [3, 3, 0, 0] } },
      S("曝光人数（合计）", src.map((d) => d.uv), "#2b6cf6", { yAxisIndex: 1 }),
    ], hit),
  });
  // 窗口小表：两平台合计（美团窗口 + 闪购流量窗口；最新日闪购无窗口值 → PV 仅美团、UV 加闪购最新日）
  //   ⚠️ 只读 p.trendAll.expo.flow（parity fixture 裁掉 taobao 重载荷，渲染不得直读 p.taobao.mda）
  const e = p.exposure;
  const flow = p.trendAll?.expo?.flow ?? null;
  const flowLast = flow?.lastUv ?? null;
  const flowD7 = flow?.d7 ?? null;
  const flowD30 = flow?.d30 ?? null;
  const sumNum = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  const rows = [
    ["最新日", e?.windows?.today, flowLast],
    ["近 7 天", e?.windows?.d7, flowD7?.uv ?? null, flowD7?.pv ?? null],
    ["近 30 天", e?.windows?.d30, flowD30?.uv ?? null, flowD30?.pv ?? null],
  ].filter(([, w]) => w);
  const ring = (v) => (v === null || v === undefined) ? '<span style="color:#6b7691">—</span>'
    : `<b style="color:${v >= 0 ? "#12a06a" : "#e8543f"}">${v > 0 ? "+" : ""}${fmt(v)}%</b>`;
  $("expoTopWrap").innerHTML = rows.length
    ? `<table><thead><tr><th>窗口</th><th class="num">曝光人数（合计）</th><th class="num">曝光次数</th>
        <th class="num">人数环比</th><th class="num">次数环比</th></tr></thead><tbody>` +
      rows.map(([label, w, tbUv, tbPv]) => `<tr><td><b>${label}</b></td>
        <td class="num"><b>${int(sumNum(w.uv, tbUv ?? null))}</b></td>
        <td class="num">${int(sumNum(w.pv, tbPv ?? null))}${tbPv == null ? '<span style="color:#6b7691">（美团）</span>' : ""}</td>
        <td class="num">${ring(w.ringRateUv)}</td><td class="num">${ring(w.ringRatePv)}</td></tr>`).join("") +
      "</tbody></table>"
    : '<div class="empty">合计曝光未取到</div>';
}

/* ── ④ 曝光（平台总口径）── */
/**
 * ⭐ 口径（2026-09-21 经营者拍板改的，同时也是一次**口径修正**）：
 *   曝光改为「流量分析」页的**平台总指标**，不再逐店求和。
 *   - 窗口值 + 环比：`flowAnalysisV5/recentDays/flowTransformation`
 *     的 `FLOW_POI_EXPOSE_UV`（曝光人数）/ `FLOW_POI_EXPOSE_PV`（曝光次数）；
 *   - 逐日曲线：`.../flowTransformationChart`（`data.chart.{current,ring,date}`）。
 *   ⛔ 旧的逐店求和是**另一个度量**：同一天（2026-09-21）平台 PV 18,280，
 *      而逐店 `flowPoiExposureRankingV2` 求和只有 2,526 —— 差 7 倍，旧看板一直低估。
 *   ⚠️ 平台**最新可用日是昨天**（早上取数时今天还没出），所以标签写「最新日」而不是「今日」。
 *      该日期由后端 +8h 换算后落在 `windows.*.day`，不要在前端再算一遍。
 *
 * ⭐ 2026-09-22 经营者要求图表跟随窗口：曝光**平台只有日粒度且 T+1**，没有小时数据，
 *    所以「今日 / 昨日」窗口下退化为「最近 7 天 + 虚线标出所选日」并在副标题写明原因。
 */
function drawExposure() {
  const p = proj();
  /**
   * ⛔ 闪购的曝光 / 流量分析在**另一个微应用**里（`eb_data_analysis/exposureAnalysis`），
   *    本项目尚未取数标定 —— 如实说明，**不拿美团曝光顶上**。
   */
  if (isShangouView()) {
    /**
     * ⭐ 闪购曝光：**② 族 MDA 优先**（两账号通用、每日新鲜；品牌A是 o2o+镜像求和）——
     *   ① 族 `SER.exposure` 2026-09-23 起两账号全灭，仅作历史回退（旧快照，不新增）。
     *   ⚠️ 与美团曝光口径完全不同，**不可相加/同轴对比**。
     */
    const MDA = p.taobao?.mda ?? null;
    const EX = p.taobao?.series?.exposure ?? null;
    const flowDaily = MDA?.flowDaily?.exp_user_num?.points ?? [];
    const hasFlow = flowDaily.length > 0;
    if (!EX && !hasFlow) {
      $("expoTag").textContent = "未接入";
      $("expoSub").innerHTML = esc(platNotes().shangouNoExposure);
      $("expoTopSub").textContent = esc(platNotes().shangouNoExposure);
      shangouEmpty("c-expo", "闪购：曝光数据未取到", platNotes().shangouNoExposure);
      return;
    }
    const hourly = isHourWin(CUR_WIN);

    // ── ② 族通道（品牌B）：只有逐日 ──
    if (hasFlow) {
      const clkPts = MDA?.flowDaily?.clk_user_num?.points ?? [];
      const ordPts = MDA?.flowDaily?.place_order_user_num?.points ?? [];
      const src = CUR_WIN === "d7" ? flowDaily.slice(-7) : flowDaily;
      const clkMap = new Map(clkPts.map((x) => [x.date, x.value]));
      const ordMap = new Map(ordPts.map((x) => [x.date, x.value]));
      $("expoTag").textContent = hourly ? "逐日（无小时数据）" : dimTag(CUR_WIN);
      const w = CUR_WIN === "d7" ? MDA?.flowWindows?.d7 : MDA?.flowWindows?.d30;
      $("expoSub").innerHTML =
        `闪购曝光人次 <b>${int(w?.expPvAll)}</b> · 成交人次 <b>${int(w?.validOrderCntAll)}</b><br>` +
        // ⭐ R18：不再上屏 family 全文（原句把接口族描述整段塞进说明区，占 3 行）
        `<span style="color:#9aa4b8">门户数据（小时窗口无逐时数据，图示逐日）</span>`;
      $("expoTopSub").textContent = "闪购曝光来源与口径见 reference §6.13。";
      chart("c-expo", {
        grid: GRID, legend: LEGEND, tooltip: { trigger: "axis" },
        xAxis: AXIS(src.map((x) => String(x.date).slice(5))),
        yAxis: [YAXIS("曝光人数"), YAXIS("进店/下单", { position: "right", splitLine: { show: false } })],
        series: [
          S("曝光人数", src.map((x) => x.value), "#2b6cf6", { areaStyle: { opacity: .12 } }),
          S("进店人数", src.map((x) => clkMap.get(x.date) ?? null), "#12a05c", { yAxisIndex: 1, areaStyle: { opacity: .04 } }),
          S("下单人数", src.map((x) => ordMap.get(x.date) ?? null), "#f0a020", { yAxisIndex: 1 }),
        ],
      });
      return;
    }
    $("expoTag").textContent = hourly ? "逐小时" : dimTag(CUR_WIN);
    const sum = hourly
      ? (CUR_WIN === "yesterday" ? EX.yesterday : EX.today)
      : CUR_WIN === "d7" ? EX.windows?.d7 : EX.windows?.d30;
    $("expoSub").innerHTML =
      `闪购**曝光人数** <b>${int(sum?.expUvAll)}</b>` +
      (sum?.expPvAll != null ? ` · 曝光次数 <b>${int(sum.expPvAll)}</b>` : "") +
      (sum?.derivedFrom === "hourly-sum" ? ` <span style="color:#9aa4b8">（单日接口对昨日失败，用分时求和兜底）</span>` : "") +
      (sum?.clkUvAll != null ? ` · 进店 <b>${int(sum.clkUvAll)}</b>` : "") +
      `<br><span style="color:#9aa4b8">闪购口径（≠ 美团平台总曝光），两平台不可相加。</span>`;
    $("expoTopSub").innerHTML = `${esc(platNotes().shangouNoExposure ? "" : "")}闪购曝光来源与口径见 reference §6.11。`;

    let labels = [], uv = [], clk = [];
    if (hourly) {
      const src = (CUR_WIN === "yesterday" ? EX.hourlyYesterday : EX.hourlyToday)?.points ?? [];
      labels = src.map((x) => x.hour);
      uv = src.map((x) => x.expUv);
      clk = src.map((x) => x.clkUv);
    } else {
      const src = CUR_WIN === "d7" ? EX.daily ?? [] : EX.daily30?.length ? EX.daily30 : EX.daily ?? [];
      labels = src.map((x) => String(x.date).slice(5));
      uv = src.map((x) => x.expUv);
      clk = src.map((x) => x.clkUv);
    }
    if (!labels.length) {
      shangouEmpty("c-expo", "闪购：该窗口无曝光数据", "闪购曝光接口未返回该窗口数据。");
      return;
    }
    chart("c-expo", {
      grid: GRID, legend: LEGEND, tooltip: { trigger: "axis" },
      xAxis: AXIS(labels),
      yAxis: [YAXIS("曝光人数"), YAXIS("进店人数", { position: "right", splitLine: { show: false } })],
      series: [S("曝光人数", uv, "#2b6cf6", { areaStyle: { opacity: .12 } }), S("进店人数", clk, "#12a05c", { yAxisIndex: 1, areaStyle: { opacity: .04 } })],
    });
    return;
  }
  const e = p.exposure;
  // ⭐ R22（2026-09-24 经营者指示）：「全部平台」= 美团 + 闪购 合计（数据层 trendAll.expo）
  if (CUR_PLATFORM === "all") { drawExposureAll(p); return; }
  const W = e?.windows ?? {};
  const daily = e?.daily ?? [];
  if (!e || !W.today) {
    $("c-expo").innerHTML = '<div class="empty">未取到曝光数据</div>';
    $("expoTopWrap").innerHTML = '<div class="empty">未取到曝光数据</div>';
    $("expoTag").textContent = "未接入";
    $("expoSub").textContent = "曝光接口未取到数（跑 node src/fetch-meituan-exposure.mjs 补）。";
    $("expoTopSub").textContent = "";
    return;
  }
  const t = W.today;
  const day = esc(t.day ?? "—");
  const ring = (v) => (v === null || v === undefined) ? '<span style="color:#6b7691">—</span>'
    : `<b style="color:${v >= 0 ? "#12a06a" : "#e8543f"}">${v > 0 ? "+" : ""}${fmt(v)}%</b>`;

  const hourly = isHourWin(CUR_WIN);
  /** 卡片摘要用的窗口值：小时窗口 == 最新可用日（T+1）；日窗口取对应窗口。 */
  const sum = CUR_WIN === "d7" ? (W.d7 ?? t) : CUR_WIN === "d30" ? (W.d30 ?? t) : t;

  /**
   * ⚠️ 小时窗口下**不能**把 tag 写成「今日 · 逐小时」—— 曝光平台没有小时数据，
   *    那样写等于拿日级图冒充小时图。`dimTagDailyOnly` 会如实标注「逐日（无小时数据）」。
   *    窗口本身由卡片里的迷你切换器表示，标签不再重复窗口名。
   */
  $("expoTag").textContent = dimTagDailyOnly(CUR_WIN);
  $("expoSub").innerHTML =
    `曝光次数 <b>${int(sum.pv)}</b>（环比 ${ring(sum.ringRatePv)}） · ` +
    `曝光人数 <b>${int(sum.uv)}</b>（环比 ${ring(sum.ringRateUv)}） · ` +
    (hourly
      ? `曝光为平台 T+1 日粒度、无小时数据，最新数据日 <b>${day}</b>`
      : `${sum.days ?? 1} 天窗口，截止 <b>${esc(sum.day ?? t.day ?? "—")}</b>（平台 T+1，不含今天）`);
  /**
   * ⛔ 原先这里把「平台 18,280 vs 逐店求和 2,526」**写死成一句通用文案**，
   *    而那两个数是**品牌A** 2026-09-21 的实测值；品牌B那天的 PV 是 17,395。
   *    等于在品牌B页面上展示品牌A的数字 —— 违反「两项目不汇总、不混用」。
   *    现在文案由 `VM.caliber.exposure.textByProject[CUR_PROJ]` 按项目取，
   *    没有逐店样本的项目就不给数字对比（宁可不说，也不编）。
   */
  $("expoTopSub").innerHTML =
    VM.caliber.exposure.textByProject[CUR_PROJ] +
    `窗口由 <code>recentDays</code> 决定，均截止 <b>${day}</b>。`;

  // ── 曲线：跟随窗口 ──
  let src, labels, hit = null;
  if (hourly) {
    const fb = dailyFallback(daily, p, CUR_WIN);
    src = fb.src; labels = fb.labels; hit = fb.hit;
  } else if (CUR_WIN === "d7") {
    src = daily.slice(-7); labels = src.map((d) => String(d.date).slice(5));
  } else {
    src = daily; labels = src.map((d) => String(d.date).slice(5));
  }

  if (!src.length) {
    $("c-expo").innerHTML = '<div class="empty">该窗口无曝光数据</div>';
  } else {
    // 逐日：次数用柱（左轴），人数用线（右轴）—— 两个量纲差约 3.5 倍，同轴会压扁
    chart("c-expo", {
      grid: GRID, legend: LEGEND, tooltip: { trigger: "axis" },
      xAxis: AXIS(labels),
      yAxis: [YAXIS("曝光次数"), YAXIS("曝光人数", { position: "right", splitLine: { show: false } })],
      series: markSel([
        { name: "曝光次数", type: "bar", data: src.map((d) => d.pv), barMaxWidth: 12,
          itemStyle: { color: "#c9dcff", borderRadius: [3, 3, 0, 0] } },
        S("曝光人数", src.map((d) => d.uv), "#2b6cf6", { yAxisIndex: 1 }),
      ], hit),
    });
  }

  const rows = [
    ["最新日", W.today],
    ["近 7 天", W.d7],
    ["近 30 天", W.d30],
  ].filter(([, w]) => w);
  $("expoTopWrap").innerHTML = rows.length
    ? `<table><thead><tr><th>窗口</th><th class="num">曝光人数</th><th class="num">曝光次数</th>
        <th class="num">人数环比</th><th class="num">次数环比</th><th class="num">对比基准</th></tr></thead><tbody>` +
      rows.map(([label, w]) => `<tr><td><b>${label}</b>${w.days > 1 ? `<span style="color:#6b7691"> · ${w.days} 天</span>` : ""}</td>
        <td class="num"><b>${int(w.uv)}</b></td><td class="num"><b>${int(w.pv)}</b></td>
        <td class="num">${ring(w.ringRateUv)}</td><td class="num">${ring(w.ringRatePv)}</td>
        <td class="num">${int(w.ringUv)} 人 / ${int(w.ringPv)} 次</td></tr>`).join("") +
      "</tbody></table>"
    : '<div class="empty">平台总曝光未取到</div>';
}
