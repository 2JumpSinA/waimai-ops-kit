/**
 * 美团收入的**装配层**：把各接口的原始响应拼成 income-<key>.json。
 *
 * 为什么单独拆出来：
 *   取数要浏览器 + 登录，装配不需要。拆开之后装配逻辑就能用**固定样例离线单测**，
 *   不必等到登录才发现「窗口算错一天」「字符串拼成了拼接」这类问题。
 *   见 src/test-mt-income-assemble.mjs。
 *
 * 输入全是**原始响应**（未解析），输出是可直接落盘的 result 对象。
 * 本文件不碰 CDP、不碰文件系统。
 */
import { lastNDays, dayWindows, isoDate, parseCore, parseFixTimeChart, mergeDaily } from "./mt-window.mjs";

const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

/** 按天 / 按店给取消单分桶（order_time 是 **epoch 秒**） */
export function bucketCancels(rows = []) {
  const byDay = new Map();
  const byPoi = new Map();
  for (const x of rows) {
    if (x?.orderTime == null) continue;
    const day = isoDate(new Date(x.orderTime * 1000));
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    const k = String(x.poiId ?? "?");
    const a = byPoi.get(k) ?? { poiId: k, poiName: x.poiName ?? "", cancel: 0 };
    a.cancel++;
    if (!a.poiName && x.poiName) a.poiName = x.poiName;
    byPoi.set(k, a);
  }
  return { byDay, byPoi };
}

/** 用「平台订单量 + 取消单数」重建一个窗口 */
function buildWindow({ valid, cancel, income, avgPriceOverride = null, label, start, end, source }) {
  if (valid == null && cancel == null && income == null) return null;
  const v = valid ?? 0;
  const c = cancel ?? 0;
  const total = v + c;
  return {
    label, start, end,
    orderCount: total,
    validOrderCount: v,
    cancelCount: c,
    /**
     * ⛔ **量纲：这里必须是「小数」(0~1)，不是百分数。**
     *    消费方 `build-dashboard.mjs:168` 会做 `r2(r.cancelRate * 100)`。
     *    我第一版在这里写了 `* 100`，结果取消率被乘了两次 100 ——
     *    品牌B今日显示成 **1273%**。而 d7/d30 走的是 build-dashboard 自己的
     *    `sumDays`（那边产出百分数），所以只有 today/yesterday 出错，
     *    看起来「一半对一半错」，很有迷惑性。
     *
     *    ⚠️ 我的离线单测当时**没拦住**，因为断言里照抄了同一个错误量纲。
     *    现在测试改用「量纲不变量」来钉（0 ≤ cancelRate ≤ 1），不再复述实现。
     */
    cancelRate: total ? Number((c / total).toFixed(4)) : 0,
    projectedIncome: r2(income),
    cancelIncome: null,
    avgOrderValue: avgPriceOverride ?? (v ? r2((income ?? 0) / v) : null),
    source,
  };
}

/**
 * @param {object} input
 * @param {{key:string,label:string}} input.acct
 * @param {string} input.acctId
 * @param {number} [input.days]            逐日输出天数（上限 30）
 * @param {Array}  [input.cancelWindowRows] 近30天窗口的取消单明细
 * @param {number} [input.cancelWindowTotal]
 * @param {Array}  [input.cancelTodayRows]  今日取消单明细
 * @param {number} [input.cancelTodayTotal]
 * @param {object} [input.officialToday]   todayOrderSummary 的 data
 * @param {object} [input.agg]             {core7:{json},core30:{json},chart30:{json}}
 * @param {object} [input.poiDetail]       {d7:[{poiId,poiName,income,orders}], d30:[...]}
 * @param {object} [input.legacyRef]       旧的逐单结果（用于对账展示）
 * @param {Date}   [input.now]
 * @param {Set}    [input.only]
 * @param {boolean} [input.byPoiOn] 是否计算逐店。
 *   ⚠️ 必须**独立于 `only`** —— 旧脚本的逐店由 `--byPoiAll=1` 这个独立开关控制，
 *      而 refresh-all.ps1 传的是 `--only=today,yesterday,d7,d30,daily --byPoiAll=1`
 *      （`byPoi` 不在 `--only` 里）。若把逐店绑在 `only` 上，
 *      刷新流水线跑完「高取消单占比门店」会**静默变空**。这个坑经营者看不到，看板直接少一块。
 */
export function assembleIncome(input) {
  const {
    acct, acctId, days = 30,
    cancelWindowRows = [], cancelWindowTotal = null,
    cancelTodayRows = [], cancelTodayTotal = null,
    officialToday = null, agg = {}, poiDetail = {}, legacyRef = null,
    now = new Date(), only = null, byPoiOn = true,
  } = input;

  const want = (k) => !only || only.has(k);
  const log = [];
  const warnings = [];

  const dw = dayWindows(now);
  const w7 = lastNDays(7, now);
  const w30 = lastNDays(30, now);
  const todayIso = dw.today.iso;

  const cancelBuckets = bucketCancels(cancelWindowRows);
  const cancelBucketsToday = bucketCancels(cancelTodayRows);

  const hasWindowCancels = cancelWindowRows.length > 0;

  /* ── 窗口 ── */
  const windows = {};

  if (want("today")) {
    const o = officialToday ?? {};
    const valid = o.validOrderCount == null ? null : Number(o.validOrderCount);
    // 官方汇总给了 cancelOrderCount 就用它；没有则用取消单列表的条数
    const cancel = o.cancelOrderCount == null
      ? (cancelTodayRows.length || cancelTodayTotal || 0)
      : Number(o.cancelOrderCount);
    const income = o.settleIncome == null ? null : Number(o.settleIncome);
    if (valid != null || income != null) {
      windows.today = buildWindow({
        valid, cancel, income,
        label: "今日", start: todayIso, end: todayIso,
        source: "todayOrderSummary（官方今日实时汇总）",
      });
    }
  }

  for (const [key, w, coreKey, label] of [["d7", w7, "core7", "近7天"], ["d30", w30, "core30", "近30天"]]) {
    if (!want(key)) continue;
    const raw = agg[coreKey]?.json?.data;
    const p = raw ? parseCore(raw) : null;
    if (!p || p.projectedIncome == null) {
      if (p) warnings.push(`${label} core 未返回预计收入`);
      continue;
    }
    const cancel = hasWindowCancels
      ? [...cancelBuckets.byDay.entries()]
          .filter(([d]) => d >= w.isoBegin && d <= w.isoEnd)
          .reduce((a, [, n]) => a + n, 0)
      : null;
    windows[key] = buildWindow({
      valid: p.transactionVolume, cancel, income: p.projectedIncome,
      avgPriceOverride: p.avgPrice,
      label, start: w.isoBegin, end: w.isoEnd,
      source: `manageHome/core ${w.dateType} + order_cancel`,
    });
  }

  /* ── 逐日 ── */
  const chartRaw = agg.chart30?.json?.data;
  const chart = chartRaw ? parseFixTimeChart(chartRaw) : null;
  const dailyRows = chart
    ? mergeDaily({
        income: chart.projectedIncome, deal: chart.dealAmount,
        volume: chart.transactionVolume, avgPrice: chart.avgPrice,
      })
    : [];

  if (want("yesterday")) {
    const yIso = dw.yesterday.iso;
    const row = dailyRows.find((d) => d.date === yIso) ?? null;
    const cancel = hasWindowCancels ? (cancelBuckets.byDay.get(yIso) ?? 0) : null;
    windows.yesterday = buildWindow({
      valid: row?.validOrderCount ?? null,
      cancel,
      income: row?.projectedIncome ?? null,
      label: "昨日", start: yIso, end: yIso,
      source: "fixTimeChart 昨日行 + order_cancel",
    });
  }

  const daily = [];
  if (want("daily")) {
    for (const d of dailyRows.slice(-days)) {
      const cancel = cancelBuckets.byDay.get(d.date) ?? 0;
      /**
       * ⚠️ 订单量缺失时**不要**当 0：orderCount 会等于取消数 → 取消率 100%，
       *    看板上会出现「某天取消率 100%」的假告警。缺就留 null。
       */
      const v = d.validOrderCount;
      const total = v == null ? null : v + cancel;
      daily.push({
        date: d.date,
        orderCount: total,
        validOrderCount: v,
        cancelCount: cancel,
        cancelRate: total ? Number((cancel / total).toFixed(4)) : null,
        projectedIncome: r2(d.projectedIncome),
        dealAmount: r2(d.dealAmount),
        cancelIncome: null,
        avgOrderValue: r2(d.avgOrderValue),
        byPoi: null,
      });
    }
    const missing = daily.filter((d) => d.validOrderCount == null).length;
    if (missing) warnings.push(`逐日里有 ${missing} 天缺订单量（fixTimeChart 未返回该天）`);
  }

  /* ── 逐店（窗口级，供「高取消单占比门店」）── */
  /**
   * ⚠️ 这里**不看 `want(key)`** —— 逐店走的是独立的 `poi/detail` 调用，
   *    窗口参数由 `lastNDays()` 自己算，跟 `--only` 要不要 d7/d30 无关。
   *    刷新流水线的快捷模式只传 `--only=today,yesterday,daily`，
   *    若这里也要求 `want("d7")`，快捷模式就永远拿不到逐店数据。
   */
  const byPoi = {};
  for (const [key, w] of [["d7", w7], ["d30", w30]]) {
    if (!byPoiOn) break;
    const detailed = poiDetail[key];
    if (!detailed?.length) continue;
    const m = new Map();
    for (const x of detailed) {
      m.set(String(x.poiId), {
        poiId: String(x.poiId), poiName: x.poiName ?? "",
        orders: Number(x.orders ?? 0), cancel: 0, income: Number(x.income ?? 0),
      });
    }
    for (const [pid, a] of cancelBuckets.byPoi) {
      const cur = m.get(pid);
      if (cur) cur.cancel = a.cancel;
      // 平台逐店明细里没有、但确实有取消单的门店也要保留，否则高取消门店会被漏掉
      else m.set(pid, { poiId: pid, poiName: a.poiName, orders: 0, cancel: a.cancel, income: 0 });
    }
    byPoi[key] = [...m.values()]
      .map((a) => {
        const orders = (a.orders ?? 0) + (a.cancel ?? 0);
        return { ...a, orders, rate: orders ? Number((a.cancel / orders).toFixed(4)) : 0, income: r2(a.income) };
      })
      .sort((a, b) => b.cancel - a.cancel || b.rate - a.rate);
    log.push(`逐店 ${key}: ${byPoi[key].length} 家，含取消 ${byPoi[key].reduce((s, x) => s + x.cancel, 0)} 单`);
  }

  /* ── 自检 ── */
  const selfCheck = { checks: [] };
  const addCheck = (name, a, b, tol, note) => {
    if (a == null || b == null) { selfCheck.checks.push({ name, a, b, diff: null, ok: null, note }); return; }
    const diff = r2(a - b);
    selfCheck.checks.push({ name, a: r2(a), b: r2(b), diff, ok: Math.abs(diff) <= tol, tol, note });
  };

  // ⚠️ 保留旧字段名：看板模板读的是 selfCheck.projectedIncomeDiff
  selfCheck.projectedIncomeDiff =
    windows.today && officialToday
      ? r2((windows.today.projectedIncome ?? 0) - Number(officialToday.settleIncome ?? 0))
      : null;
  selfCheck.validOrderDiff =
    windows.today && officialToday
      ? Number(windows.today.validOrderCount ?? 0) - Number(officialToday.validOrderCount ?? 0)
      : null;

  // 同源两接口互校：core（窗口）应当等于 fixTimeChart（逐日）之和
  const sumDaily = (n, field) => {
    const ds = daily.slice(-n);
    if (ds.length < n) return null;
    return r2(ds.reduce((s, d) => s + (d[field] ?? 0), 0));
  };
  if (windows.d30 && daily.length >= 30) {
    addCheck("近30天 预计收入：core vs fixTimeChart 逐日", windows.d30.projectedIncome, sumDaily(30, "projectedIncome"), 1, "同源两接口，应一致");
    addCheck(
      "近30天 订单量：core vs fixTimeChart 逐日",
      windows.d30.validOrderCount,
      daily.slice(-30).reduce((s, d) => s + (d.validOrderCount ?? 0), 0),
      0, "同源两接口，应一致",
    );
  }
  if (windows.d7 && daily.length >= 7) {
    addCheck("近7天 预计收入：core vs fixTimeChart 逐日", windows.d7.projectedIncome, sumDaily(7, "projectedIncome"), 1, "同源两接口，应一致");
  }
  if (windows.today) {
    /**
     * ⚠️ 不能用 `cancelTodayRows.length || null`：今日**真的 0 单取消**时，
     *    `0 || null` 会变成 null，自检就显示成「无法判定 ◻️」——
     *    把一条本该通过的检查伪装成不确定。判据要用「是否取过」，不是条数。
     */
    const fetchedToday = input.cancelTodayFetched ?? (cancelTodayRows.length > 0 || (cancelTodayTotal ?? 0) > 0);
    addCheck(
      "今日 取消单：todayOrderSummary vs order_cancel 列表",
      windows.today.cancelCount,
      fetchedToday ? cancelTodayRows.length : null,
      0, "两条路应给同一个数",
    );
  }

  /* ── 与旧逐单基准对照 ── */
  if (legacyRef) {
    selfCheck.legacyFetchedAt = legacyRef.fetchedAt ?? null;
    selfCheck.legacyNote =
      "income-orderlist-*.json 是逐单翻页的旧实现结果（快照时点不同）。逐日对比才有意义：" +
      "平台会回溯修订历史订单，合计差零点几 % 属正常。";
    const legacyDaily = new Map((legacyRef.daily ?? []).map((d) => [d.date, d]));
    let same = 0, diffDays = 0, maxDiff = 0;
    const perDay = [];
    for (const d of daily) {
      const L = legacyDaily.get(d.date);
      if (!L) continue;
      const diff = r2((d.projectedIncome ?? 0) - (L.projectedIncome ?? 0));
      perDay.push({ date: d.date, platform: d.projectedIncome, orderlist: L.projectedIncome, diff });
      if (Math.abs(diff) < 0.01) same++;
      else { diffDays++; maxDiff = Math.max(maxDiff, Math.abs(diff)); }
    }
    selfCheck.platformVsOrderlist = {
      overlapDays: perDay.length, exactDays: same, diffDays, maxAbsDiff: r2(maxDiff), perDay,
    };
  }

  const result = {
    fetchedAt: new Date().toISOString(),
    account: { key: acct.key, label: acct.label },
    acctId,
    caliber:
      "预计收入 = 平台 manageHome/core 的 multiProjectedIncome（窗口）/ fixTimeChart（逐日）；" +
      "取消单 = 订单列表 tag=order_cancel 计数。" +
      "平台窗口 last_N_days **截止昨天、不含今天**，今日用 todayOrderSummary。",
    source: "platform-aggregate",
    statusCodes: { 8: "已完成", 4: "处理中", 9: "已取消" },
    windows,
    daily,
    byPoi,
    officialToday,
    cancelOrders: {
      window: cancelWindowRows.length, windowTotal: cancelWindowTotal,
      today: cancelTodayRows.length, todayTotal: cancelTodayTotal,
    },
    selfCheck,
    warnings,
  };

  return { result, log, warnings };
}
