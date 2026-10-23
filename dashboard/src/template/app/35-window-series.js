/* ══════ 分片 35-window-series.js · 窗口 → 时间维度（四个图跟随「窗口」切换器） ══════ */
/**
 * ⭐ 2026-09-22 经营者要求：四个图表跟随顶部「窗口」切换器（今日 / 昨日 / 近7天 / 近30天）。
 *
 * 时间维度由 `VM.caliber.windowSeries[win].dim` 决定（口径集中在 caliber.mjs），模板**不硬编码**：
 *   · dim === "hour" → 今日 / 昨日：画**逐小时**
 *   · dim === "day"  → 近7天 / 近30天：画**逐日**
 *
 * ⚠️ 为什么有的板块给不了小时 —— 因为**平台数据粒度不同**：
 *   · 收入 / 取消率 → 逐单带 `order_time`，**小时是我们自己分桶算的**，今日与昨日都能给；
 *   · 推广 / 曝光   → 平台只有**日粒度且 T+1**，**没有任何小时数据**。
 *     它们遇到 hour 窗口时退化为「最近 7 天 + 虚线标出所选日」，并在副标题写明原因 ——
 *     **绝不能拿日级图冒充小时图**（那是在骗用户）。
 */
function seriesOf(winKey) {
  return (VM.caliber && VM.caliber.windowSeries && VM.caliber.windowSeries[winKey]) || { tag: winKey, dim: "day" };
}
function isHourWin(winKey) {
  return seriesOf(winKey).dim === "hour";
}

/** 当前窗口对应的「所选日」ISO 日期（hour 窗口用它画虚线；日窗口返回 null）。 */
function selectedDay(p, winKey) {
  if (winKey === "today") return p.today?.date ?? null;
  if (winKey === "yesterday") return p.today?.dateYesterday ?? null;
  return null;
}

/**
 * 日粒度板块（推广 / 曝光）在 hour 窗口下的降级取数：最近 7 天 + 要标出的所选日。
 * `hit` 只有在所选日真的落在这 7 天里时才有值（例如「今日」永远不在，因为平台 T+1）。
 */
function dailyFallback(rows, p, winKey) {
  const src = (rows ?? []).slice(-7);
  const labels = src.map((x) => String(x.date).slice(5));
  const sel = selectedDay(p, winKey);
  const selLabel = sel ? String(sel).slice(5) : null;
  const hit = selLabel && labels.indexOf(selLabel) >= 0 ? selLabel : null;
  return { src, labels, selLabel, hit };
}

/** 在第一个系列上画一条竖虚线，标出所选日。 */
function markSel(series, hit, text) {
  if (!hit || !series.length) return series;
  series[0].markLine = {
    silent: true, symbol: "none",
    lineStyle: { color: "#e8543f", type: "dashed", width: 1.5 },
    label: { formatter: text || "所选日", fontSize: 10, color: "#e8543f", position: "insideEndTop" },
    data: [{ xAxis: hit }],
  };
  return series;
}

/**
 * ⭐ 卡片右上角的**维度标签**（2026-09-22）。
 *   窗口本身已由旁边的迷你切换器表示，标签只负责说「时间维度」与「降级说明」，
 *   避免和图例/标题重复堆字。
 */
const dimTag = (winKey) => (seriesOf(winKey).dim === "hour" ? "逐小时" : "逐日");
/** 日粒度板块（推广/曝光）的标签：小时窗口下必须写明**无小时数据**（不许拿日级图冒充）。 */
const dimTagDailyOnly = (winKey) => (isHourWin(winKey) ? "逐日（无小时数据）" : "逐日");

/**
 * ⭐ 所有窗口切换器一起同步（顶部那个 + 四个图表卡片里的迷你切换器）。
 *
 * 为什么要在卡片里也放：顶部切换器只在页首，看图看到一半想换窗口**得滚回最上面**，
 * 很不方便。卡片内切换器点一下就地生效，四个卡片与顶部始终同状态。
 */
const WIN_SEG_IDS = ["winSeg", "winSegIncome", "winSegCancel", "winSegKa", "winSegExpo"];
function syncWinSegs() {
  for (const id of WIN_SEG_IDS) {
    const seg = $(id);
    if (!seg) continue;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === CUR_WIN));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   平台维度（全部平台 / 美团 / 闪购）—— 2026-09-22 经营者要求
   ══════════════════════════════════════════════════════════════════════ */
const PLAT_SEG_IDS = ["platSeg", "platSegIncome", "platSegCancel", "platSegKa", "platSegExpo"];
function syncPlatSegs() {
  for (const id of PLAT_SEG_IDS) {
    const seg = $(id);
    if (!seg) continue;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === CUR_PLATFORM));
  }
}
/** 平台文案全部来自 caliber（口径单一真相源） */
const platNotes = () => VM.caliber?.platformNotes ?? {};
/**
 * 「全部平台」与「美团」都画**美团**曲线 —— 闪购与美团**口径不同、门店集合不同，不可叠加**，
 * 所以「全部平台」不是把两条线画在一起，而是「美团曲线 + 明确说明未叠闪购」。
 */
const isMeituanView = () => CUR_PLATFORM === "all" || CUR_PLATFORM === "meituan";
const isShangouView = () => CUR_PLATFORM === "shangou";
/** 「全部平台」时提示「闪购未叠加」；其它情况返回空串 */
const allPlatformHint = () => (CUR_PLATFORM === "all" ? platNotes().allNoSum : "");

/** 闪购视图下的降级说明块（无序列 / 未接入时用） */
function shangouEmpty(containerId, title, note, extraRows) {
  const rows = (extraRows ?? []).length ? `<br>${extraRows.join(" · ")}` : "";
  clearChart(containerId, `<div class="empty" style="text-align:left;line-height:1.95;padding:8px 4px">
    <b>${esc(title)}</b>${rows}<br><span style="color:#9aa4b8">${esc(note)}</span></div>`);
}

/** 闪购近 7 天窗口的常用几个数（取不到就返回空数组，不编）。
 *  ⭐ 优先 ② 族 MDA（两账号通用，品牌A是 o2o+镜像双子账号求和，2026-09-23 口径）；
 *    ① 族 protein 2026-09-23 起两账号全灭，只作历史回退；最后回退 kpiView（门店明细 KPI）。 */
function shangouWindowRows(p) {
  const M = p.taobao?.mda?.windows?.d7 ?? null;
  if (M && (M.orderAmt != null || M.validOrderCnt != null)) {
    const rows = [];
    if (M.orderAmt != null) rows.push(`近7日成交额 <b>${fmt(M.orderAmt)}</b> 元`);
    if (M.validOrderCnt != null) rows.push(`订单 <b>${int(M.validOrderCnt)}</b> 单`);
    if (M.invalidOrderNum != null) {
      const rate = M.validOrderCnt ? ((M.invalidOrderNum / M.validOrderCnt) * 100).toFixed(2) : "—";
      rows.push(`流失 <b>${int(M.invalidOrderNum)}</b> 单（${rate}%）`);
    }
    return rows;
  }
  const w = p.taobao?.series?.windows?.d7 ?? p.taobao?.kpiView ?? null;
  if (!w) return [];
  const rows = [];
  const amt = w.orderTotalAmt ?? w.orderAmt;
  const cnt = w.orderCnt ?? w.orderCount;
  const inv = w.invalidOrderCnt ?? w.invalidCount;
  const inc = w.merchantIncome;
  if (amt != null) rows.push(`近7日成交额 <b>${fmt(amt)}</b> 元`);
  if (cnt != null) rows.push(`订单 <b>${int(cnt)}</b> 单`);
  if (inv != null) {
    const rate = cnt ? ((inv / cnt) * 100).toFixed(2) : "—";
    rows.push(`流失 <b>${int(inv)}</b> 单（${rate}%）`);
  }
  if (inc != null) rows.push(`商家实收 <b>${fmt(inc)}</b> 元`);
  return rows;
}
