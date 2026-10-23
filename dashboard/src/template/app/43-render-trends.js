/* ══════ 分片 43-render-trends.js · 渲染：预计收入 / 取消率趋势（跟随窗口 + 平台） ══════ */
/**
 * 美团侧：收入 / 取消率的**逐小时是我们自己按 order_time 分桶**得来的（不是平台报表），
 *   所以「今日」「昨日」都能给小时维度；「近7天」「近30天」给逐日（income.daily 有 30 天）。
 * 闪购侧：数据来自 ② 族 MDA（`fetch-taobao-mda.mjs`，两账号通用）——
 *   · 分时（今日/昨日）：`homepage.getCustomerHourTrendChartData`，**已由取数脚本差分成每小时增量**
 *   · 逐日（30 天）：`biz.getTrendChartData`，expect_income / invalid_order_num（品牌A = o2o+镜像子账号镜像双子账号求和）
 *   · ⭐ 2026-09-23 经营者指示：日窗口（近7/近30天）流失接 MDA 逐日 `invalid_order_num`（T+1，不含今日）
 * ⚠️ 闪购的「成交额 / 预计收入」与美团的「预计收入」**定义不同、门店集合不同，不可相加**。
 */
function trendData(p, winKey) {
  if (isHourWin(winKey)) {
    const src = winKey === "yesterday" ? (p.today?.hourlyYesterday ?? []) : (p.today?.hourly ?? []);
    return {
      dim: "hour",
      labels: src.map((x) => x.hour),
      income: src.map((x) => x.income),
      cancel: src.map((x) => x.cancel),
      rate: src.map((x) => Number(((x.rate ?? 0) * 100).toFixed(2))),
      n: src.length,
    };
  }
  const all = p.income?.daily ?? [];
  const src = winKey === "d7" ? all.slice(-7) : all;
  return {
    dim: "day",
    labels: src.map((x) => String(x.date).slice(5)),
    income: src.map((x) => x.projectedIncome),
    cancel: src.map((x) => x.cancelCount),
    rate: src.map((x) => x.cancelRate),
    n: src.length,
  };
}

/* ── 闪购视图：优先 ② 族（两账号通用），回退 ① 族（只有品牌A） ── */
function drawTrendsShangou(p) {
  /**
   * ⛔ 变量名**不能叫 `S`** —— 那会遮蔽 30-chart.js 的全局系列助手 `S()`，
   *    随后 `S("闪购 成交额", …)` 直接抛 `TypeError: S is not a function`，
   *    整个 render() 中断、后面的推广/曝光图**残留上一平台视图的 canvas**
   *    （看起来就像「拿美团数据冒充闪购」）。2026-09-22 被 verify 的平台断言抓到。
   */
  const MDA = p.taobao?.mda ?? null;     // ② 族门户：**两账号通用**（优先）
  const SER = p.taobao?.series ?? null;  // ① 族 protein：只有品牌A
  const N = platNotes();
  const rows = shangouWindowRows(p);
  $("incomeTrendTag").textContent = "预计收入";
  $("cancelTrendTag").textContent = "流失率";
  $("cancelTrendSub").textContent = "闪购口径：流失单 ÷ 订单数（≠ 美团的「取消单」）";

  if (!MDA && !SER) {
    shangouEmpty("c-income", "闪购：营业统计数据未取到", N.shangouNoSeries, rows);
    shangouEmpty("c-cancel", "闪购：营业统计数据未取到", N.shangouNoSeries, rows);
    return;
  }

  const hourly = isHourWin(CUR_WIN);
  const side = CUR_WIN === "yesterday" ? "previous" : "current";

  // ── 预计收入 ──
  let labels = [], vals = [];
  if (MDA) {
    const src2 = hourly
      ? MDA.hourly?.expect_income?.[side] ?? []
      : (CUR_WIN === "d7" ? (MDA.daily?.expect_income?.points ?? []).slice(-7) : MDA.daily?.expect_income?.points ?? []);
    labels = src2.map((x) => (hourly ? x.hour : String(x.date).slice(5)));
    vals = src2.map((x) => x.value);
  } else if (hourly && CUR_WIN === "today") {
    // ① 族回退（只有品牌A，且只有今日/昨日的分时）
    const src2 = (CUR_WIN === "yesterday" ? SER.hourlyYesterday : SER.hourlyToday) ?? [];
    labels = src2.map((x) => x.hour); vals = src2.map((x) => x.value);
  } else {
    const all = SER.daily?.expectIncome ?? [];
    const src2 = CUR_WIN === "d7" ? all.slice(-7) : all;
    labels = src2.map((x) => String(x.date).slice(5)); vals = src2.map((x) => x.value);
  }
  if (labels.length) {
    chart("c-income", {
      grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
      xAxis: AXIS(labels), yAxis: YAXIS("元"),
      series: [S("闪购 预计收入", vals, "#ff6a00")],
    });
  } else {
    clearChart("c-income", '<div class="empty" style="text-align:left">闪购该窗口无预计收入数据。</div>');
  }

  // ── 流失率 ──
  const inv = MDA?.hourly?.invalid_order_num?.[side] ?? [];
  if (hourly && inv.length) {
    const ord = new Map((MDA?.hourly?.expect_income?.[side] ?? []).map((x) => [x.hour, x.value]));
    void ord;
    const valid = MDA?.hourly?.valid_order_cnt?.[side] ?? [];
    const vm2 = new Map(valid.map((x) => [x.hour, x.value]));
    chart("c-cancel", {
      grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
      xAxis: AXIS(inv.map((x) => x.hour)),
      yAxis: [YAXIS("单数"), YAXIS("流失率 %", { splitLine: { show: false }, axisLabel: { color: "#6b7691", fontSize: 11, formatter: "{value}%" } })],
      series: [
        S("流失单", inv.map((x) => x.value), "#e8543f", { areaStyle: { opacity: .08, color: "#e8543f" } }),
        S("流失率", inv.map((x) => {
          const v = x.value ?? 0, o = vm2.get(x.hour) ?? 0, tot = v + o;
          return tot ? Number(((v / tot) * 100).toFixed(2)) : 0;
        }), "#f0a020", { yAxisIndex: 1, areaStyle: { opacity: .04 } }),
      ],
    });
  } else if (!hourly) {
    /**
     * ⭐ 2026-09-23 经营者指示：日窗口（近7/近30天）流失接 MDA 逐日序列
     *   （`biz.getTrendChartData` 的 invalid_order_num；品牌A = o2o + 镜像子账号镜像双子账号**求和**，
     *   求和已在 fetch-taobao-mda.mjs 的 sumDaily 完成）。逐日为 **T+1（不含今日）**，
     *   与窗口汇总（biz.getMasterData）同界 —— 品牌A近7天逐日合计 37 == 窗口流失 37（已对账）。
     */
    const invAll = MDA?.daily?.invalidOrderNum?.points ?? [];
    const valMap = new Map((MDA?.daily?.valid_order_cnt?.points ?? []).map((x) => [x.date, x.value]));
    const pts = CUR_WIN === "d7" ? invAll.slice(-7) : invAll;
    if (pts.length) {
      $("cancelTrendSub").textContent = "闪购口径：流失单 ÷ 订单数（≠ 美团的「取消单」）；逐日为 T+1（不含今日）";
      chart("c-cancel", {
        grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
        xAxis: AXIS(pts.map((x) => String(x.date).slice(5))),
        yAxis: [YAXIS("单数"), YAXIS("流失率 %", { splitLine: { show: false }, axisLabel: { color: "#6b7691", fontSize: 11, formatter: "{value}%" } })],
        series: [
          S("流失单", pts.map((x) => x.value), "#e8543f", { areaStyle: { opacity: .08, color: "#e8543f" } }),
          S("流失率", pts.map((x) => {
            const v = x.value ?? 0, o = valMap.get(x.date) ?? 0, tot = v + o;
            return tot ? Number(((v / tot) * 100).toFixed(2)) : 0;
          }), "#f0a020", { yAxisIndex: 1, areaStyle: { opacity: .04 } }),
        ],
      });
    } else {
      shangouEmpty(
        "c-cancel",
        "闪购：该窗口的逐日流失未取到",
        "MDA biz.getTrendChartData 未返回逐日流失（invalid_order_num）；小时窗口有逐时流失。",
        rows,
      );
    }
  } else {
    shangouEmpty(
      "c-cancel",
      "闪购：该窗口的逐时流失未取到",
      "小时窗口的流失分时（homepage.getCustomerHourTrendChartData）未返回数据。",
      rows,
    );
  }
}

/* ── 趋势图 ── */
/** ⭐⭐ R22（2026-09-24 经营者指示）：「全部平台」趋势 = 美团 + 闪购 合计（数据层 `trendAll`，口径见模型 R22 注释）。
 *   说明区遵循 R18 约束：固定两行内（.sub min-height 38px + clamp），新增口径短语不挤占图表。 */
function drawTrendsAll(p) {
  const N = VM.caliber.trendAll ?? {};
  const TA = p.trendAll ?? null;
  const hourly = isHourWin(CUR_WIN);
  $("incomeTrendTag").textContent = dimTag(CUR_WIN);
  $("cancelTrendTag").textContent = "取消率";
  $("cancelTrendSub").textContent = N.cancel ?? "";
  if (!TA || !(TA.income?.daily ?? []).length) {
    clearChart("c-income", '<div class="empty">全部平台合计数据未取到</div>');
    clearChart("c-cancel", '<div class="empty">全部平台合计数据未取到</div>');
    return;
  }
  const side = CUR_WIN === "yesterday" ? "yesterday" : "today";
  const incSrc = hourly ? TA.income.hourly[side] : (CUR_WIN === "d7" ? TA.income.daily.slice(-7) : TA.income.daily);
  const canSrc = hourly ? TA.cancel.hourly[side] : (CUR_WIN === "d7" ? TA.cancel.daily.slice(-7) : TA.cancel.daily);
  const key = hourly ? "hour" : "date";
  chart("c-income", {
    grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
    xAxis: AXIS(incSrc.map((x) => String(x[key]).slice(hourly ? 0 : 5))),
    yAxis: YAXIS("元"),
    series: [S("预计收入", incSrc.map((x) => x.value), "#2b6cf6")],
  });
  chart("c-cancel", {
    grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
    xAxis: AXIS(canSrc.map((x) => String(x[key]).slice(hourly ? 0 : 5))),
    yAxis: [YAXIS("单数"), YAXIS("取消率 %", { splitLine: { show: false }, axisLabel: { color: "#6b7691", fontSize: 11, formatter: "{value}%" } })],
    series: [
      S("取消单数", canSrc.map((x) => x.cancel), "#e8543f", { areaStyle: { opacity: .08, color: "#e8543f" } }),
      S("取消率", canSrc.map((x) => (x.cancel != null && x.orders ? Math.round((x.cancel / x.orders) * 10000) / 100 : null)), "#f0a020", { yAxisIndex: 1, areaStyle: { opacity: .04 } }),
    ],
  });
}

function drawTrends() {
  const p = proj();
  if (isShangouView()) { drawTrendsShangou(p); return; }
  // ⭐ R22（2026-09-24 经营者指示）：「全部平台」= 美团 + 闪购 合计（数据层 trendAll）
  if (CUR_PLATFORM === "all") { drawTrendsAll(p); return; }

  const s = trendData(p, CUR_WIN);
  $("incomeTrendTag").textContent = dimTag(CUR_WIN);
  $("cancelTrendTag").textContent = dimTag(CUR_WIN);
  $("cancelTrendSub").textContent = (s.dim === "hour"
    ? "逐小时：取消单数 ÷ 该小时下单数"
    : "取消单数 ÷ 当日总单数") + (allPlatformHint() ? " ⚠️ 未叠闪购" : "");

  if (!s.n) {
    clearChart("c-income", '<div class="empty">该窗口无数据</div>');
    clearChart("c-cancel", '<div class="empty">该窗口无数据</div>');
    return;
  }
  chart("c-income", {
    grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
    xAxis: AXIS(s.labels),
    yAxis: YAXIS("元"),
    series: [S("预计收入", s.income, "#2b6cf6")],
  });
  chart("c-cancel", {
    grid: GRID, tooltip: { trigger: "axis" }, legend: LEGEND,
    xAxis: AXIS(s.labels),
    yAxis: [YAXIS("单数"), YAXIS("取消率 %", { splitLine: { show: false }, axisLabel: { color: "#6b7691", fontSize: 11, formatter: "{value}%" } })],
    series: [
      S("取消单数", s.cancel, "#e8543f", { areaStyle: { opacity: .08, color: "#e8543f" } }),
      S("取消率", s.rate, "#f0a020", { yAxisIndex: 1, areaStyle: { opacity: .04 } }),
    ],
  });
}
