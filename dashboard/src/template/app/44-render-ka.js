/* ══════ 分片 44-render-ka.js · 渲染：推广消耗与 ROI（跟随窗口） ══════ */
/**
 * 数据来源按窗口分两种（**这是本板块最容易搞错的地方**）：
 *   · 历史窗口（昨日 / 近7天 / 近30天）→ **T+1 报表**（`ka.daily` / `ka.daily30`，金额原为「分」已 ÷100）
 *   · 今日 → **推广首页实时接口**（`ka.realtime`，金额本来就是「元」）
 *     ⚠️ 报表查「今日」**恒返回 0**，不是「今天没投放」—— 所以今日必须走首页实时。
 *
 * ⭐ 2026-09-22：首页实时接口自带 `todayList` / `yesterdayList` **分时**曲线，
 *    所以「今日 / 昨日」窗口能给**真小时维度**（不再降级成日级）。
 *    只有在实时接口取不到时才退化为「最近 7 天 + 虚线」并如实标注。
 * ⭐ R13（2026-09-24）：ROI 口径统一改为**预计收入 ÷ 推广消耗（本看板计算）**——
 *    · 逐日窗口：数据层 `ka.daily/daily30[].roi` 已换成 income.daily ÷ cost；
 *    · 今日/昨日分时：数据层 `ka.realtime.hourly[].roi` 已按小时对齐现算
 *      （分时收入 ← today.hourly[].income 逐单 order_time 分桶；分时消耗 ← 实时接口）；
 *    · 闪购分支：⭐ R16（2026-09-24）ROI 恢复展示（本看板现算，数据层 roiIncome），
 *      ⭐ R19（同日）**两品牌口径不同，必须区分**：
 *      品牌A = 「眼镜店」总账号预计收入 ÷ o2o 全站推广消耗；
 *      品牌B = 「品牌B」预计收入 ÷ 品牌B斗金推广消耗；
 *      原 GMV 口径（成交÷消耗）弃用。
 */
function drawKa() {
  const p = proj();
  /**
   * ⭐ 2026-09-23：闪购推广**已接入**（斗金 ISV BP 通路，fetch-taobao-promo.mjs）。
   *   口径：**全站推广**（页面数据，eleAllSiteChain）。
   *   · 品牌A = **品牌Ao2o 供应商（单账号）**（⭐ R15 2026-09-24：镜像子账号镜像子账号不再求和）；
   *   · 品牌B = 品牌B（单账号，斗金 BP USER_DATE 全部形式）；
   *   · ⛔ 与美团推广口径不同，不与美团数字混用。
   *   数据缺失时如实降级（不再写「未接入」—— 通路已打通，缺的只是数据文件）。
   */
  if (isShangouView()) {
    const PR = p.taobao?.promo ?? null;
    if (!PR || (!(PR.daily ?? []).length && !(PR.todayHourly ?? []).length)) {
      $("kaTag").textContent = "未取到";
      $("kaSub").innerHTML = esc(platNotes().shangouNoPromo);
      shangouEmpty("c-ka", "闪购：推广数据未取到", platNotes().shangouNoPromo);
      return;
    }
    const daily = PR.daily ?? [];
    const hourly = isHourWin(CUR_WIN);
    let src, labels, hit = null, note = "", isHour = false;

    if (hourly && CUR_WIN === "today" && (PR.todayHourly ?? []).length) {
      isHour = true;
      src = PR.todayHourly;
      labels = src.map((x) => x.hour);
      note = "今日分时为诊断卡口径（全站+斗金）；今日总额以 T+0 全部形式为准。";
    } else if (hourly) {
      const fb = dailyFallback(daily, p, CUR_WIN);
      src = fb.src; labels = fb.labels; hit = fb.hit;
      note = "闪购推广仅日粒度（今日分时仅诊断卡口径）。";
    } else {
      src = CUR_WIN === "d7" ? daily.slice(-7) : daily;
      labels = src.map((x) => String(x.date).slice(5));
      note = "";
    }

    $("kaTag").textContent = isHour ? "逐小时（诊断卡口径）" : hourly ? "逐日（无小时数据）" : "逐日（全部形式）";

    const w7 = PR.windows?.d7 ?? null;
    // ⭐ R18：说明区统一 ≤2 行——只放短口径（tbPromoShort），TB_PROMO_NOTE 全文不再上屏
    $("kaSub").innerHTML =
      (note ? `${esc(note)} ` : "") +
      (w7 ? `近 7 天消耗 <b>${fmt(w7.cost)}</b> 元 · 余额 <b>${fmt(PR.balance)}</b> 元。` : "") +
      ` ${esc(platNotes().tbPromoShort ?? "")}`;

    if (!src.length) { $("c-ka").innerHTML = '<div class="empty">该窗口无闪购推广数据</div>'; return; }

    /**
     * ⭐⭐ R16/R19（2026-09-24 经营者指示）：闪购 ROI 展示（本看板现算，数据层 roiIncome），
     *   两品牌口径**不同**：品牌A = 眼镜店预计收入 ÷ o2o 全站推广消耗；
     *   品牌B = 品牌B预计收入 ÷ 品牌B斗金推广消耗。
     *   逐日/分时的分子分母分别按日期/小时对齐；incomeLogin 缺失（取数失败）→ roiIncome 全 null → 单轴只画消耗。
     */
    const hasRoi = src.some((x) => x.roiIncome != null);
    const series = hasRoi
      ? [
          S("闪购推广消耗", src.map((x) => x.cost), "#2b6cf6"),
          S("ROI", src.map((x) => x.roiIncome), "#12a05c", { yAxisIndex: 1, areaStyle: { opacity: .04 } }),
        ]
      : [S("闪购推广消耗", src.map((x) => x.cost), "#2b6cf6")];

    chart("c-ka", {
      grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
      xAxis: AXIS(labels),
      yAxis: hasRoi ? [YAXIS("元"), YAXIS("ROI", { splitLine: { show: false } })] : YAXIS("元"),
      series,
    });
    return;
  }
  // ⭐ R22（2026-09-24 经营者指示）：「全部平台」= 美团 + 闪购 推广合计（数据层 trendAll.promo，仅日粒度）
  if (CUR_PLATFORM === "all") { drawKaAll(p); return; }
  const hourly = isHourWin(CUR_WIN);
  const rt = p.ka?.realtime ?? null;
  const d7 = p.ka?.daily ?? [];
  const d30 = p.ka?.daily30 ?? [];
  const all = d30.length ? d30 : d7;
  const liveShort = VM.caliber?.promo?.liveShort ?? "推广首页实时";

  /** 首页实时分时（今日用 todayList，昨日用 yesterdayList） */
  const rtHourly = hourly && rt ? (CUR_WIN === "yesterday" ? rt.hourlyYesterday : rt.hourly) : null;

  let src, labels, hit = null, note = "", isHour = false;
  if (hourly && rtHourly && rtHourly.length) {
    isHour = true;
    src = rtHourly;
    labels = rtHourly.map((x) => x.hour);
    // ⭐ R18：说明瘦身（原句含完整对齐规则说明，占 3 行）
    note = `${liveShort}。小时 ROI = 分时收入 ÷ 分时消耗（零消耗小时断开）`;
  } else if (hourly) {
    // 实时接口没取到才走这条：退化为最近 7 天 + 虚线标出所选日
    const fb = dailyFallback(all, p, CUR_WIN);
    src = fb.src; labels = fb.labels; hit = fb.hit;
    note = VM.caliber?.dailyOnlyNote ?? "";
    if (CUR_WIN === "today") note += `首页实时接口未取到，图中最新为 ${labels[labels.length - 1] ?? "—"}。`;
  } else if (CUR_WIN === "d7") {
    src = d7; labels = d7.map((x) => String(x.date).slice(5));
  } else {
    src = all; labels = all.map((x) => String(x.date).slice(5));
  }

  // 标签只说时间维度：真小时 / 逐日 / （实时缺失时）逐日并写明降级
  $("kaTag").textContent = isHour ? "逐小时" : hourly ? "逐日（无小时数据）" : "逐日";

  // 产品线拆分只挂在逐日窗口（实时口径没有小时级产品线）
  // ⭐ R18：说明瘦身——产品线只列名字与消耗，不再解释「为什么没有 ROI」
  const bp = p.ka?.byProduct ?? [];
  $("kaSub").innerHTML =
    (note ? `${esc(note)} · ` : "") +
    (!hourly && bp.length
      ? `产品线：${esc(bp.map((x) => `${x.name} ${fmt(x.cost)} 元`).join(" · "))} · `
      : "") +
    (isHour
      ? `今日消耗 ${fmt(rt?.cost)} 元 · 余额 ${fmt(rt?.balance)} 元`
      : `ROI = 预计收入 ÷ 推广消耗（本看板计算）`);

  if (!src.length) { $("c-ka").innerHTML = '<div class="empty">该窗口无推广数据</div>'; return; }

  // ⭐ R13：今日/昨日分时也画 ROI 线（rt.hourly[].roi 已在数据层按小时对齐现算）
  const series = markSel([
    S("推广消耗", src.map((x) => x.cost), "#2b6cf6"),
    S("ROI", src.map((x) => x.roi), "#12a05c", { yAxisIndex: 1, areaStyle: { opacity: .04 } }),
  ], hit);

  chart("c-ka", {
    grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
    xAxis: AXIS(labels),
    yAxis: [YAXIS("元"), YAXIS("ROI", { splitLine: { show: false } })],
    series,
  });
}

/** ⭐⭐ R22（2026-09-24 经营者指示）：「全部平台」推广 = 美团 + 闪购 合计（数据层 trendAll.promo）。
 *   ⭐ R22b：**今日**有双平台分时（美团实时分时 + 闪购今日诊断分时）→ 按小时对齐求和、画真小时；
 *   昨日闪购无分时消耗 → 退化为最近 7 天逐日并如实标注（不能拿美团分时冒充合计）。
 *   说明区遵循 R18：固定两行内，不挤占图表。 */
function drawKaAll(p) {
  const N = VM.caliber.trendAll ?? {};
  const rows = p.trendAll?.promo?.daily ?? [];
  if (!rows.length) {
    $("kaTag").textContent = "未取到";
    $("kaSub").innerHTML = "全部平台推广合计数据未取到";
    $("c-ka").innerHTML = '<div class="empty">该窗口无推广数据</div>';
    return;
  }
  const hourly = isHourWin(CUR_WIN);
  // ⭐ R22b：今日窗口且有合计分时 → 真小时；其余小时窗口（昨日）退化为最近 7 天逐日
  const hourRows = hourly ? (p.trendAll?.promo?.hourly?.[CUR_WIN === "yesterday" ? "yesterday" : "today"] ?? []) : [];
  const useHour = hourly && hourRows.some((x) => x.cost != null);
  const src = useHour
    ? hourRows
    : hourly ? rows.slice(-7) : (CUR_WIN === "d7" ? rows.slice(-7) : rows);
  $("kaTag").textContent = useHour ? "逐小时" : dimTagDailyOnly(CUR_WIN);
  const hourNote = useHour ? (N.promoHourTodayNote ?? "") : (N.promoHourNote ?? "");
  $("kaSub").innerHTML =
    (hourly ? `${esc(hourNote)} · ` : "") +
    `${esc(N.promo ?? "")}；${esc(N.roi ?? "")}`;
  if (!src.length) { $("c-ka").innerHTML = '<div class="empty">该窗口无推广数据</div>'; return; }
  const roi = (x) => (x.income != null && x.cost > 0 ? Math.round((x.income / x.cost) * 100) / 100 : null);
  const key = useHour ? "hour" : "date";
  chart("c-ka", {
    grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
    xAxis: AXIS(src.map((x) => String(x[key]).slice(useHour ? 0 : 5))),
    yAxis: [YAXIS("元"), YAXIS("ROI", { splitLine: { show: false } })],
    series: [
      S("推广消耗", src.map((x) => x.cost), "#2b6cf6"),
      S("ROI", src.map(roi), "#12a05c", { yAxisIndex: 1, areaStyle: { opacity: .04 } }),
    ],
  });
}
