/**
 * 看板**纯装配层**：把已落盘的原始 JSON 拼成看板用的 VM，再把 VM 注入模板。
 *
 * 为什么单独拆出来（照搬已经跑通的 `mt-income-assemble.mjs` ↔ `test-mt-income-assemble.mjs` 分工）：
 *   原先 `build-dashboard.mjs` 的 `buildProject()` 是一个 345 行的单函数，
 *   读文件 / 取数 / 派生 / 口径修正 / 顶层写盘全糊在一起，且**模块 import 时就读盘** ——
 *   结果「同一份冻结数据跑改前/改后两版代码」这件事根本做不到，
 *   而那是「结构优化没改行为」唯一可信的验收手段。
 *
 * 本文件**只做纯计算**：不读文件、不写文件、不碰 CDP、不碰 process.argv。
 * 文件 IO 与参数解析留在 `src/build-dashboard.mjs` 外壳里。
 */
import {
  WINDOW_DEFS, KA_LABEL_TO_KEY, THRESHOLDS, SELF_CHECK_SPECS, ISOLATION,
  buildCaliber, incomeCaliberNotes, promoNotes, checkInvariants, isMissingValue, normStatus,
  PROMO_LIVE_NOTE, PROMO_ROI_NOTE, PROMO_T1_NOTE, PLATFORM_NOTE,
} from "./caliber.mjs";
import { num, r2 } from "./num.mjs";

/** 合并多天的 byPoi（看板自己把日粒度并成任意窗口）。 */
export function mergeByPoi(days) {
  const m = new Map();
  for (const d of days) {
    for (const p of d.byPoi ?? []) {
      const a = m.get(p.poiId) ?? { poiId: p.poiId, poiName: p.poiName || "", orders: 0, cancel: 0, income: 0 };
      a.orders += p.orders ?? 0;
      a.cancel += p.cancel ?? 0;
      a.income += p.income ?? 0;
      if (!a.poiName && p.poiName) a.poiName = p.poiName;
      m.set(p.poiId, a);
    }
  }
  return [...m.values()]
    .map((a) => ({ ...a, rate: a.orders ? Number((a.cancel / a.orders).toFixed(4)) : 0, income: r2(a.income) }))
    .filter((a) => a.poiId && a.poiId !== "null" && a.poiId !== "?")
    .sort((a, b) => b.cancel - a.cancel || b.rate - a.rate);
}

/**
 * 装配单个项目。
 *
 * @param {{key:string,label:string,fullLabel:string}} meta
 * @param {object} inputs
 * @param {Array}  inputs.unifiedAll    `data/plan/stores-unified.json`（两项目共用，按 project 过滤）
 * @param {Array}  inputs.anomaliesAll  `data/plan/anomalies.json` 的 `.items`
 * @param {object} inputs.files         { mt, inc, ka, expo, today, tb, tbDetail }，缺失一律 `null`
 * @param {(m:string)=>void} [inputs.warn] 告警回调（外壳注入 console.warn）
 */
export function buildProjectModel(meta, inputs) {
  const { unifiedAll = [], anomaliesAll = [], files = {}, warn: warnIn } = inputs;
  const k = meta.key;
  const out = { key: k, ...meta, warnings: [] };
  const warn = (m) => {
    out.warnings.push(m);
    if (warnIn) warnIn(`   ⚠️ [${meta.label}] ${m}`);
  };

  // ── 美团医药基础数据 ──
  const mt = files.mt;
  if (mt) {
    out.dataTime = mt.panels?.overview?.latestTime?.data ?? "—";
    out.acctId = mt.ctx?.acctId ?? null;
    out.mtStores = (mt.stores ?? []).map((s) => ({
      id: String(s.id), name: s.name, city: s.city, status: s.status, restReason: s.restReason,
    }));
    out.mtStatusDist = mt.storeStatusDist ?? {};
  } else {
    warn("美团医药原始数据缺失");
    out.mtStores = [];
    out.mtStatusDist = {};
  }

  // ── 台账统一视图（本项目）──
  const uni = unifiedAll.filter((s) => s.project === k);
  const kept = uni.filter((s) => !s.duplicate);
  /**
   * 给模板用的统一门店行 —— 只留渲染需要的字段。
   * 页面还要把「近7天单量/取消率」按门店拼上来，所以这里保留两个平台的 ID。
   *
   * ⚠️ 字段名即**数据契约**：模板 `:661/:666` 曾经读 `s.mtName` / `s.live.mtStatus`（都不存在），
   *    导致门店表显示门店 ID、美团状态恒为 `—`。修的是**模板侧**，不是这里 ——
   *    `unifiedRows` 已被 `verify-dashboard.mjs` 等消费方依赖，改它牵动面更大。
   *    parity 的**VM 读集探针**现在会自动抓这类漂移（kind 恒为 undefined）。
   */
  out.unifiedRows = kept.map((s) => ({
    name: s.mtName || s.tbName || String(s.mtId || s.tbId || ""),
    city: s.city ?? "",
    kind: s.kind,
    mtId: s.mtId ?? "",
    tbId: s.tbId ?? "",
    // ⭐ R2：`#N/A` / `N/A` 这类 Excel 缺失值标记是「未知」，**不是**未营业
    mtStatus: normStatus(s.live?.mtStatus),
    offlineReason: s.offlineReason ?? "",
    planned: !!s.planned,
  }));
  out.plan = {
    total: uni.length,
    kept: kept.length,
    duplicate: uni.length - kept.length,
    byKind: kept.reduce((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {}),
    listed: kept.filter((s) => s.planned).length,
    unplanned: kept.filter((s) => !s.planned).length,
    bothPlatforms: kept.filter((s) => s.mtId && s.tbId).length,
    onlyMeituan: kept.filter((s) => s.mtId && !s.tbId).length,
    onlyEleme: kept.filter((s) => !s.mtId && s.tbId).length,
    noId: kept.filter((s) => !s.mtId && !s.tbId).length,
  };
  /**
   * ⭐ R2：`anomaly.{meituan,eleme}` 是 `import-plan.mjs` 按「状态确定未营业」算出来的。
   *   若那个「未营业」其实来自缺失值标记（`#N/A`），这条异常就是**假的** ——
   *   在这里按平台逐个复核：状态文本是缺失值标记的，该平台不算异常。
   *   全部平台都不成立的条目整条丢弃（一条「异常未营业」如果没有任何平台可确认未营业，就不该出现在列表里）。
   */
  out.anomalies = anomaliesAll
    .filter((s) => s.project === k)
    .map((s) => {
      const mtAnom = !!s.anomaly.meituan && !isMissingValue(s.live?.mtStatus);
      const tbAnom = !!s.anomaly.eleme && !isMissingValue(s.live?.tbStatus);
      return {
        name: s.mtName || s.tbName || s.mtId || s.tbId,
        city: s.city,
        platforms: [
          mtAnom ? { p: "美团", status: normStatus(s.live.mtStatus), from: s.live.mtStatusFrom } : null,
          tbAnom ? { p: "闪购", status: normStatus(s.live.tbStatus) || "无状态", from: s.live.tbStatusFrom || "无" } : null,
        ].filter(Boolean),
        planned: s.planned,
        offlineReason: s.offlineReason || "",
      };
    })
    .filter((a) => a.platforms.length > 0);

  // ── 预计收入 ──
  const inc = files.inc;
  out.income = { windows: {}, daily: [] };
  if (inc) {
    /**
     * ⚠️ 这里**不要**立刻 warn「缺窗口」。
     *    取数脚本用 `--only=today,yesterday,daily` 时，落盘的 windows 就只有这两个，
     *    d7/d30 是**下面用逐日汇总派生**出来的。
     *    先前在派生之前就告警，于是每次构建都刷两条「缺窗口」——
     *    而实际值算得好好的，是误导性日志。改成最后统一核对。
     */
    const missingLabels = [];
    for (const w of WINDOW_DEFS) {
      const r = inc.windows?.[w.key];
      if (!r) {
        missingLabels.push(w.label);
        continue;
      }
      out.income.windows[w.key] = {
        label: w.label,
        start: r.start, end: r.end,
        orderCount: r.orderCount,
        validOrderCount: r.validOrderCount,
        cancelCount: r.cancelCount,
        cancelRate: r2(r.cancelRate * 100),
        projectedIncome: r.projectedIncome,
        cancelIncome: r.cancelIncome,
        avgOrderValue: r.avgOrderValue,
        /**
         * ⭐ 用取数脚本自报的来源，别硬编码。
         *   旧版（逐单翻页）自报「接口区间查询」，新版（平台聚合）自报
         *   「manageHome/core last_N_days + order_cancel」——看板上要能一眼看出
         *   这个数字是逐单算的还是平台给的，否则对不上时无从下手。
         */
        source: r.source ?? "接口区间查询",
      };
    }
    out.income.daily = (inc.daily ?? []).map((d) => ({
      date: d.date, orderCount: d.orderCount, cancelCount: d.cancelCount,
      cancelRate: r2(d.cancelRate * 100), projectedIncome: d.projectedIncome, avgOrderValue: d.avgOrderValue,
    }));
    out.income.selfCheck = inc.selfCheck ?? null;
    out.income.officialToday = inc.officialToday ?? null;
    out.income.caliber = inc.caliber ?? "";
    /**
     * ⭐ 把取数来源透传给看板。
     *   模板据此决定「收入口径」那句短语怎么写 —— 不传的话看板会把
     *   平台聚合来的数字配上「Σ 逐单求和」的说明，等于对用户说谎。
     *   旧格式文件没有 `source` 字段 → 记为逐单口径。
     */
    out.income.source = inc.source ?? "orderlist-legacy";

    /**
     * ⭐ 近7天 / 近30天 改用**逐日汇总**，不用区间查询的结果。
     *
     * 原因：区间查询偶发短页（品牌B近30天 totalCount=5996 只回 5978），
     * 而**逐日的每一天都单独校验过 totalCount 且全部取满**，所以逐日汇总更准。
     * 两者的差会记进 crossCheck，差得多就在看板上提示，不偷偷替换。
     */
    const sumDays = (n) => {
      const ds = (inc.daily ?? []).slice(-n);
      if (ds.length < n) return null; // 逐日天数不够，别硬凑
      const acc = ds.reduce((a, d) => {
        a.orderCount += d.orderCount ?? 0;
        a.cancelCount += d.cancelCount ?? 0;
        a.projectedIncome += d.projectedIncome ?? 0;
        a.validOrderCount += d.validOrderCount ?? 0;
        return a;
      }, { orderCount: 0, cancelCount: 0, projectedIncome: 0, validOrderCount: 0 });
      return {
        label: `近${n}天`,
        start: ds[0].date,
        end: ds[ds.length - 1].date,
        orderCount: acc.orderCount,
        validOrderCount: acc.validOrderCount,
        cancelCount: acc.cancelCount,
        cancelRate: r2((acc.cancelCount / (acc.orderCount || 1)) * 100),
        projectedIncome: r2(acc.projectedIncome),
        cancelIncome: null,
        avgOrderValue: r2(acc.projectedIncome / (acc.validOrderCount || 1)),
        source: "逐日汇总",
      };
    };
    out.income.crossCheck = [];
    for (const [key, n] of [["d7", 7], ["d30", 30]]) {
      const fromDaily = sumDays(n);
      const fromQuery = out.income.windows[key];
      if (!fromDaily) {
        if (fromQuery) warn(`逐日不足 ${n} 天，${fromQuery.label}只能用区间查询结果（可能略偏低）`);
        continue;
      }
      if (fromQuery && fromQuery.orderCount !== fromDaily.orderCount) {
        const diff = fromQuery.orderCount - fromDaily.orderCount;
        out.income.crossCheck.push({
          window: fromDaily.label,
          queryOrders: fromQuery.orderCount, dailyOrders: fromDaily.orderCount, diff,
          queryIncome: fromQuery.projectedIncome, dailyIncome: fromDaily.projectedIncome,
        });
        if (warnIn) {
          warnIn(
            `   ℹ️ [${meta.label}] ${fromDaily.label} 区间查询 ${fromQuery.orderCount} 单 / 逐日汇总 ${fromDaily.orderCount} 单（差 ${diff}），已采用逐日汇总`,
          );
        }
      }
      out.income.windows[key] = fromDaily;
    }

    /**
     * 逐店（近7天 / 近30天）。
     *
     * ⚠️ 取数改造后（2026-09-21，平台聚合版）数据源变了：
     *   旧：`inc.daily[].byPoi` 每天逐店，看板自己按天合并（要 --byPoiAll，JSON 巨大）
     *   新：`inc.byPoi.d7 / inc.byPoi.d30` —— 平台 `poi/detail` 直接给窗口级逐店值
     * 旧的按天合并路径保留为**回退**，这样旧格式的 income-*.json 依然能出看板。
     */
    const legacyMerge = (n) => mergeByPoi((inc.daily ?? []).slice(-n));
    out.income.byPoiD7 = inc.byPoi?.d7?.length ? inc.byPoi.d7 : legacyMerge(7);
    out.income.byPoiD30 = inc.byPoi?.d30?.length ? inc.byPoi.d30 : legacyMerge(inc.daily?.length ?? 30);

    // 派生之后统一核对：到这里仍缺的，才是真的缺
    const stillMissing = missingLabels.filter((lab) => {
      const w = WINDOW_DEFS.find((x) => x.label === lab);
      return w && !out.income.windows[w.key];
    });
    if (stillMissing.length) warn(`预计收入最终仍缺窗口：${stillMissing.join("、")}`);
  } else {
    warn("预计收入数据缺失（未跑 fetch-meituan-income.mjs）");
  }

  // ── 推广 ──
  const ka = files.ka;
  out.ka = { windows: {}, daily: [], daily30: [], byProduct: [], realtime: null };
  /**
   * ⭐ R13（2026-09-24）：推广 ROI 口径统一改为 **预计收入 ÷ 推广消耗（本看板计算）**，
   *   弃用平台「转化 ROI」（convertEffectRoi，今日恒 null 且口径不可控）。
   *   收入来自 income 段（已在本段之前构建）：窗口用 `income.windows`、逐日用 `income.daily`。
   *   消耗为 0 或收入缺失时 ROI = null（显示「—」，不渲染假 0）。
   */
  const incWin = out.income?.windows ?? {};
  const incByDate = new Map((out.income?.daily ?? []).map((d) => [d.date, d.projectedIncome]));
  const roiByIncome = (income, cost) =>
    income != null && cost > 0 ? r2(income / cost) : null;
  if (ka) {
    const ovs = (ka.results ?? []).filter((r) => r.kind === "overview");
    for (const r of ovs) {
      const key = KA_LABEL_TO_KEY[r.label];
      if (!key) continue;
      const d = r.data ?? {};
      const cost = r2((num(d.cost) ?? 0) / 100);
      out.ka.windows[key] = {
        label: r.label,
        showCount: num(d.showCount) ?? 0,
        clickCount: num(d.clickCount) ?? 0,
        /** ⚠️ 报表金额单位是**分** */
        cost,
        cpc: r2((num(d.cpc) ?? 0) / 100),
        cpm: r2((num(d.cpm) ?? 0) / 100),
        clickRate: r2((num(d.clickRate) ?? 0) * 100),
        /** ⭐ R13：本看板口径；今日窗口报表消耗恒 0 → 恒 null（今日在 out.windows 用实时消耗算） */
        roi: roiByIncome(incWin[key]?.projectedIncome, cost),
        convertOrderAmount: r2((num(d.convertOrderAmount) ?? 0) / 100),
      };
    }
    const listRow = (ka.results ?? []).find((r) => r.kind === "list");
    out.ka.daily = (listRow?.data?.list ?? []).map((x) => {
      const cost = r2((num(x.cost) ?? 0) / 100);
      return {
        date: x.time, prodTypeName: x.prodTypeName ?? "",
        cost,
        showCount: num(x.showCount) ?? 0,
        clickCount: num(x.clickCount) ?? 0,
        /** ⭐ R13：本看板口径 = income.daily[date].projectedIncome ÷ cost */
        roi: roiByIncome(incByDate.get(String(x.time ?? "")), cost),
        convertOrderAmount: r2((num(x.convertOrderAmount) ?? 0) / 100),
      };
    })
    /**
     * ⭐ R11：ka 报表的 `list` 是**倒序**返回的（09-21 → 09-15），而同页其它逐日图
     *   （预计收入趋势、取消率趋势、曝光曲线）都是正序 —— 结果推广逐日图的 X 轴倒挂，
     *   和旁边的图对不上。这里统一按日期升序，让「同页所有逐日图一个方向」。
     *   用字符串比较即可：日期是零填充的 `YYYY-MM-DD`。
     */
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    /**
     * ⭐ 近 30 天逐日（2026-09-22 新增）：看板「近30天」窗口的推广图需要它。
     *   来源是 overview「近30天」的 `dayList`（30 条）——**不是** `kind=list` 那个
     *   「近7天明细」（只有 7 条，所以以前 30 天窗口画不出推广曲线）。
     *   ⚠️ `dayList[].time` 是 **`YYYYMMDD` 无横线**，而 `kind=list[].time` 是 `YYYY-MM-DD`，
     *      两者格式不同，这里统一成带横线，免得同页两种 X 轴标签。
     */
    const ymdDash = (s) => {
      const t = String(s ?? "").trim();
      return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t;
    };
    const d30ov = ovs.find((r) => r.label === "近30天");
    out.ka.daily30 = (d30ov?.data?.dayList ?? [])
      .map((x) => {
        const cost = r2((num(x.cost) ?? 0) / 100);
        return {
          date: ymdDash(x.time),
          cost,
          showCount: num(x.showCount) ?? 0,
          clickCount: num(x.clickCount) ?? 0,
          /** ⭐ R13：本看板口径 = income.daily[date].projectedIncome ÷ cost */
          roi: roiByIncome(incByDate.get(ymdDash(x.time)), cost),
          convertOrderAmount: r2((num(x.convertOrderAmount) ?? 0) / 100),
        };
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const d7ov = ovs.find((r) => r.label === "近7天");
    out.ka.byProduct = (d7ov?.data?.list ?? []).map((g) => {
      const rows = g.list ?? [];
      const cost = rows.reduce((s, x) => s + (num(x.cost) ?? 0), 0);
      const show = rows.reduce((s, x) => s + (num(x.showCount) ?? 0), 0);
      const conv = rows.reduce((s, x) => s + (num(x.convertOrderAmount) ?? 0), 0);
      return {
        name: g.prodTypeName ?? String(g.prodType),
        cost: r2(cost / 100), showCount: show, convertOrderAmount: r2(conv / 100),
        // ⭐ R13：产品线无「分线预计收入」，平台转化 ROI 已弃用 → 不再输出 roi 字段（渲染同步不展示）
      };
    }).filter((x) => x.cost || x.showCount);

    /**
     * ⭐ 首页实时（今日）：报表 T+1 的补救。含今日与昨日的**分时**曲线，
     *   推广图在「今日/昨日」窗口就用它画小时维度（原先只能退化成日级）。
     */
    out.ka.realtime = ka.realtimeToday ?? null;
    if (out.ka.realtime) {
      const rt = out.ka.realtime;
      out.ka.realtime = {
        source: rt.source ?? null,
        delayMin: rt.delayMin ?? 15,
        cost: num(rt.cost),
        budget: num(rt.budget),
        costRate: num(rt.costRate),
        chainRatio: num(rt.chainRatio),
        showCount: num(rt.showCount),
        clickCount: num(rt.clickCount),
        ecpm: num(rt.ecpm),
        cpc: num(rt.cpc),
        spreadingPoiNum: num(rt.spreadingPoiNum),
        costPoiNum: num(rt.costPoiNum),
        balance: num(rt.balance),
        hourly: (rt.hourly ?? []).map((x) => ({ hour: x.hour, cost: num(x.cost), showCount: num(x.showCount), clickCount: num(x.clickCount), ecpm: num(x.ecpm), cpc: num(x.cpc) })),
        hourlyYesterday: (rt.hourlyYesterday ?? []).map((x) => ({ hour: x.hour, cost: num(x.cost), showCount: num(x.showCount), clickCount: num(x.clickCount), ecpm: num(x.ecpm), cpc: num(x.cpc) })),
      };
    }
  } else {
    warn("推广数据缺失（未跑 fetch-ka.mjs）");
  }

  // ── 曝光 ──
  /**
   * ⭐ 2026-09-21 起改用**平台总口径**（经营者拍板）：
   *   旧口径是逐店 `flowPoiExposureRankingV2` 求和，与平台总曝光**不是同一个度量**，
   *   同日实测 2,526 vs 18,280（低估约 7 倍）。逐店字段因此从看板撤下，
   *   只保留总口径的窗口值 + 环比 + 逐日曲线。
   *   需要复现旧口径请跑：`node src/fetch-meituan-exposure.mjs --mode=byPoi`
   *   （落盘 exposure-bypoi-<账号>.json，不会覆盖这份）。
   */
  const expo = files.expo;
  out.exposure = expo
    ? {
        source: expo.source ?? null,
        caliber: expo.caliber ?? null,
        fetchedAt: expo.fetchedAt ?? null,
        windows: expo.windows ?? null, // {today,d7,d30} → {days,uv,pv,ringUv,ringPv,ringRateUv,ringRatePv,day}
        daily: expo.daily ?? [],       // [{date,uv,pv,ringUv,ringPv}] 逐日，末点==最新可用日
        dailyCaliber: expo.dailyCaliber ?? null,
      }
    : null;
  if (!expo) warn("曝光数据缺失（未跑 fetch-meituan-exposure.mjs）");
  else if (expo.source !== "platform-total") {
    warn(`曝光文件是旧口径（source=${expo.source ?? "?"}）—— 请重跑 fetch-meituan-exposure.mjs`);
  }
  if (expo && !(expo.daily ?? []).length) warn("曝光逐日曲线为空（面板④会退化成只有窗口值）");

  // ── 今日实时（近1小时）──
  const today = files.today;
  out.today = today
    ? {
        date: today.date, totals: today.totals, recentHour: today.recentHour,
        recent3Hour: today.recent3Hour, hourly: today.hourly, poiRank: today.poiRank,
        /**
         * ⭐ 昨日逐小时（2026-09-22 新增）：看板窗口切到「昨日」时要画小时曲线。
         *   来源与今日相同（逐单 order_time 分桶，见 fetch-meituan-today.mjs）。
         *   ✅ 实测与 income 的「昨日」平台窗口一致：品牌A 162 单/2 取消/3030.63 元、
         *      品牌B 227 单/25 取消/3493.51 元 —— 两条独立路径互证。
         */
        dateYesterday: today.dateYesterday ?? null,
        hourlyYesterday: today.hourlyYesterday ?? [],
        yesterdayTotals: today.yesterdayTotals ?? null,
        caliber: today.caliber?.recentHour ?? "",
        caliberYesterday: today.caliber?.yesterdayHourly ?? "",
      }
    : null;
  if (!today) warn("今日实时数据缺失（未跑 fetch-meituan-today.mjs）");

  /**
   * ⭐ R13（2026-09-24）：今日/昨日**分时 ROI** —— 本看板口径按小时对齐现算：
   *   · 小时收入 ← `today.hourly[].income` / `today.hourlyYesterday[].income`
   *     （逐单 order_time 分桶的预计收入，与平台窗口互证：品牌A昨日 3030.63 元）；
   *   · 小时消耗 ← `ka.realtime.hourly[].cost`（推广首页实时，两侧小时标签同为 "HH:00"）；
   *   · cost=0 或该小时无收入 → roi = null（不渲染假 0）。
   *   注意必须在 out.ka.realtime 与 out.today 都构建之后执行。
   *
   * ⭐ R13 追补（同日断点修复）：订单分桶「缺行的小时」= 该小时**没有订单**（收入 0），
   *   不是数据缺失 —— 有消耗无订单时 ROI 应为 **0** 而不是断点
   *   （如品牌A昨日 02:00 消耗 0.58 元 / 无单，原断点现画 0）。
   *   只有整个分时数据缺失（today 文件没取到）才保持全 null；
   *   cost=0 的小时 ROI = x/0 无数学意义，仍为 null（断点属口径选择，如实呈现）。
   */
  const enrichHourlyRoi = (rtRows, ordRows) => {
    if (!rtRows?.length) return;
    const hasOrd = (ordRows ?? []).length > 0;
    const incByHour = new Map((ordRows ?? []).map((x) => [x.hour, num(x.income)]));
    for (const r of rtRows) {
      const inc = hasOrd ? (incByHour.get(r.hour) ?? 0) : null;
      r.income = inc;
      r.roi = inc != null && r.cost > 0 ? r2(inc / r.cost) : null;
    }
  };
  if (out.ka.realtime && out.today) {
    enrichHourlyRoi(out.ka.realtime.hourly, out.today.hourly);
    enrichHourlyRoi(out.ka.realtime.hourlyYesterday, out.today.hourlyYesterday);
  }

  // ── 闪购 ──
  const tb = files.tb;
  const tbDetail = files.tbDetail;
  const tbStats = files.tbStats;
  const tbMda = files.tbMda;
  /** ⭐ R20：MDA 窗口聚合（today/yesterday/d7/d30），供下方 kpiWindows 使用 */
  let mdaBizWin = null;
  out.taobao = tb
    ? {
        storeCount: tb.storeCount ?? (tb.stores ?? []).length,
        cityDist: tb.cityDist ?? null,
        storeCountDetail: tbDetail?.stores?.length ?? 0,
        detailWindow: tbDetail?.window ?? null,
        kpi: tbDetail?.kpi ?? null,
        /**
         * ⭐ 闪购**近 7 天窗口聚合**（2026-09-22 新增）—— 这是闪购侧**唯一带时间含义**的数字。
         *   ⚠️ 窗口是「近7日」，与看板的 今日/昨日/近7天/近30天 **不是同一套窗口**，
         *      页面必须标成「近 7 天窗口」，不能让人误以为是当前窗口的值。
         *   ⚠️ 口径与美团不同（这里是**成交额 / 商家实收**，不是美团的「预计收入」）——
         *      所以两平台**不可相加、也不可同轴对比**。
         */
        kpiView: (() => {
          const K = tbDetail?.kpi;
          if (!K) return null;
          const orders = num(K.order_cnt);
          const invalid = num(K.invalid_order_cnt);
          return {
            window: tbDetail?.window ?? null,
            orderAmt: num(K.order_total_amt),
            merchantIncome: num(K.merchant_income),
            orderCount: orders,
            invalidCount: invalid,
            invalidRate: orders ? Number((invalid / orders).toFixed(4)) : null,
            avgOrderAmt: num(K.avg_order_total_amt),
            payAmt: num(K.pay_amt),
            subsidyRate: num(K.shop_subsidy_rate),
          };
        })(),
        stores: (tbDetail?.stores ?? []).map((s) => ({
          name: s.name, id: String(s.id), city: s.city, supplier: s.supplier,
          orders: s.orders, invalid: s.invalid, rate: r2((s.rate ?? 0) * 100),
          amt: s.amt, invalidAmt: s.invalidAmt,
          u: s.u, del: s.del, shop: s.shop, oth: s.oth, range: s.range,
        })),
      }
    : null;
  if (!tb) warn("闪购数据缺失（未跑 fetch-taobao.mjs / 未提供该账号闪购 cookie）");

  /**
   * ⭐⭐ 闪购**营业统计**（2026-09-22 新增）：今日/昨日详情 + 分时 + 逐日趋势 + 窗口聚合。
   *   来源 `fetch-taobao-stats.mjs`（protein ① 族）。
   *   ⛔ **2026-09-23 实测：① 族对品牌A与品牌B两账号全部失效**（protein 一律返回 F，
   *      与账号 nodeType 无关，疑为平台下线/权限收紧）—— 本数据源不再有新数据，
   *      闪购营业视图已由下方 **② 族 MDA**（两账号通用）接替；此处保留作历史回退。
   */
  if (tb && tbStats) {
    const S = tbStats;
    out.taobao.series = {
      source: S.source ?? null,
      ds: S.ds ?? null,
      days: S.days ?? null,
      today: S.detail?.today ?? null,
      yesterday: S.detail?.yesterday ?? null,
      hourlyToday: S.hourly?.today?.points ?? [],
      hourlyYesterday: S.hourly?.yesterday?.points ?? [],
      /**
       * ⭐ 多指标分时（成交额/预计收入/有效订单/**流失订单**）。
       *   ⚠️ 闪购把「取消单」叫**流失订单**（= 取消 + 全款退，定义比美团宽）→ 不可与美团相加。
       *   取数层已把**每个字段**的累计值差分成每小时增量。
       */
      hourlyByField: {
        today: S.hourlyByField?.today ?? {},
        yesterday: S.hourlyByField?.yesterday ?? {},
      },
      /**
       * ⭐ 曝光（闪购「曝光数据」页）：单日 + 分时 + 窗口 + 来源构成 + 逐日(7天)。
       *   ⚠️ 曝光分时**不是累计值**（数值波动），可直接画。
       */
      exposure: S.exposure ?? null,
      /** 逐日序列：{gmv:[{date,value}], expectIncome:[…], validOrderNum:[…]} */
      daily: {
        gmv: S.daily?.gmv ?? [],
        expectIncome: S.daily?.expectIncome ?? [],
        validOrderNum: S.daily?.validOrderNum ?? [],
        invalidOrderNum: S.daily?.invalidOrderNum ?? [],
      },
      /** 窗口聚合：{d7, d30}（含成交额/订单/流失单/商家实收/补贴率） */
      windows: S.windows ?? {},
      caliber: S.caliber ?? null,
    };
  } else if (tb) {
    warn("闪购营业统计缺失（未跑 fetch-taobao-stats.mjs）—— 平台切换器的闪购视图会是空的");
  }

  /**
   * ⭐⭐ 闪购 **MDA 门户族（② 族）**（2026-09-22）：`mtop.nr.mda.portal.*` + `...get*Data`。
   *   为什么关键：**② 族两个账号都能用**（① protein 族只有品牌A能用）——
   *   品牌B此前「整族失败」其实是走错了族（见 reference §6.13）。
   *   营业数据（窗口/逐日/分时）两账号都走这里；曝光（流量）② 只有品牌B能用，品牌A仍用 ①。
   */
  if (tb && tbMda) {
    const M = tbMda;
    mdaBizWin = M.bizWindows ?? null;
    out.taobao.mda = {
      source: M.source ?? null,
      family: M.family ?? null,
      ds: M.ds ?? null,
      windows: M.bizWindows ?? null,
      daily: M.bizDaily ?? null,
      hourly: M.hourBiz ?? null,
      flowWindows: M.flowWindows ?? null,
      flowDaily: M.flowDaily ?? null,
    };
  }

  /**
   * ⭐⭐ 闪购**推广**（2026-09-23 新增；同日第七棒改 v3 页面驱动）：壳内「全站推广」页 Wholepromotion。
   *   口径（经营者 2026-09-23 指示）：**全部形式的推广消耗**；
   *   ⭐ R15（2026-09-24）：品牌A = **品牌Ao2o 供应商（单账号）**，镜像子账号镜像子账号不再求和；品牌B = 单账号。
   *   数据事实（v3 实测标定）：
   *   · 数据源 = `#/pc/Wholepromotion/`（doujin iframe，bizCode=**eleAllSiteChain**）页面原生请求
   *     （Fetch.enable 响应拦截）。⛔ 纯 Node 直调 BP（eleChain 数据页）当日全空且被限流，v2 已弃用；
   *   · `windows.{today,d7,d30}` = 页面 USER_TOTAL 原生窗口汇总（今日 T+0；区间到昨天）—— **优先用它**；
   *   · `daily30[].daily` 仅当区间响应含 bizDate 逐日行时才有（页面驱动下可能缺失，窗口汇总不受影响）；
   *   · `todayHourly` 来自全站推广页今日 USER_TOTAL 的分时行（平台实时口径）；
   *   · ⛔ 与美团推广口径不同，不可相加。
   *   ⚠️ 文件缺失 → promo 为 null，页面如实降级。
   */
  const tbPromo = files.tbPromo;
  if (tb && tbPromo && !tbPromo.error) {
    const P = tbPromo;
    const daily = P.daily30?.daily ?? [];
    const sumWin = (from, to) => {
      const rows = daily.filter((x) => x.date >= from && x.date <= to);
      if (!rows.length) return null;
      const cost = rows.reduce((a, x) => a + (x.cost ?? 0), 0);
      const gmv = rows.reduce((a, x) => a + (x.orderGrossGmv1d ?? 0), 0);
      return {
        cost: r2(cost),
        impression: rows.reduce((a, x) => a + (x.impression ?? 0), 0),
        click: rows.reduce((a, x) => a + (x.click ?? 0), 0),
        orderNum: rows.reduce((a, x) => a + (x.orderNum ?? 0), 0),
        orderGrossGmv1d: r2(gmv),
        roi: cost > 0 ? r2(gmv / cost) : null,
        days: rows.length,
      };
    };
    const d7from = daily.length ? daily[Math.max(0, daily.length - 7)].date : null;
    const d30from = daily.length ? daily[0].date : null;
    const todayRow = P.todayRealtime?.daily?.[0] ?? null;
    /**
     * ⭐⭐ R16（2026-09-24 经营者指示）：闪购 ROI 改「本看板现算」，但**两品牌口径不同，必须区分**（R19 强调）：
     *   · 品牌A ROI = 「眼镜店」总账号预计收入 ÷ 「品牌A（o2o）」全站推广消耗；
     *   · 品牌B ROI = 「品牌B」预计收入 ÷ 「品牌B」斗金推广消耗。
     *   分子统一来自取数层 `incomeLogin`（登录节点身份调 MDA ② 族；今日=homepage 实时，
     *   昨日/近7/近30=biz.getMasterData；R19 起品牌B也采集，见 fetch-taobao-promo.mjs）。
     *   原 GMV 口径 `roi` 字段保留在数据层但**不再展示**；渲染一律用 `roiIncome`。
     *   incomeLogin 缺失/失败 → roiIncome = null（ROI 不展示，单轴只画消耗）。
     */
    const IL = P.incomeLogin && !P.incomeLogin.error ? P.incomeLogin : null;
    const incWinRoi = (key, cost) => {
      const inc = IL?.windows?.[key]?.expectIncome;
      return inc != null && cost > 0 ? r2(inc / cost) : null;
    };
    const incByDate = new Map((IL?.daily ?? []).map((x) => [x.date, x.income]));
    const dailyWithRoi = daily.map((x) => {
      // ⚠️ MDA 逐日是 T+1：今日行（如有）收入恒 0/缺失 → ROI 置 null（不画假 0），今日 ROI 走实时口径
      const inc = x.date === todayRow?.date ? null : (incByDate.get(x.date) ?? null);
      return { ...x, incomeLogin: inc, roiIncome: inc != null && x.cost > 0 ? r2(inc / x.cost) : null };
    });
    const incByHour = new Map((IL?.hourly?.today ?? []).map((x) => [x.hour, x.income]));
    const hourlyWithRoi = (P.todayHourly?.hourly ?? []).map((x) => {
      const inc = incByHour.get(x.hour);
      return { ...x, incomeLogin: inc ?? null, roiIncome: inc != null && x.cost > 0 ? r2(inc / x.cost) : null };
    });
    out.taobao.promo = {
      source: P.source ?? null,
      fetchedAt: P.fetchedAt ?? null,
      merchantName: P.merchantName ?? null,
      balance: P.balance ?? null,
      /** 全部形式窗口汇总：⭐ 优先页面 USER_TOTAL 原生窗口（v3 页面驱动，最准）；旧数据缺窗口时退回逐日加总 */
      windows: {
        d7: P.windows?.d7 ?? (d7from ? sumWin(d7from, daily[daily.length - 1].date) : null),
        d30: P.windows?.d30 ?? (d30from ? sumWin(d30from, daily[daily.length - 1].date) : null),
      },
      /** 全部形式逐日（页面区间响应含 bizDate 行才有；缺失时窗口汇总仍正确） */
      daily: dailyWithRoi,
      /** 今日实时（USER_DATE T+0，全部形式） */
      today: todayRow ? { date: todayRow.date, cost: todayRow.cost, impression: todayRow.impression, click: todayRow.click, roi: todayRow.roi } : null,
      /** 今日分时（全站推广页实时口径） */
      todayHourly: hourlyWithRoi,
      todayHourlyCost: P.todayHourly?.cost ?? null,
      todayHourlyCaliber: P.todayHourly?.hourly?.length ? "全站推广页实时分时" : null,
      plans: P.plans ?? null,
      /** ⭐ R16/R19：登录节点视角预计收入（品牌A=眼镜店总账号 / 品牌B=品牌B）+ 本看板 ROI（窗口级） */
      incomeLogin: IL ?? null,
      roiIncome: {
        d7: incWinRoi("d7", (P.windows?.d7 ?? (d7from ? sumWin(d7from, daily[daily.length - 1].date) : null))?.cost),
        d30: incWinRoi("d30", (P.windows?.d30 ?? (d30from ? sumWin(d30from, daily[daily.length - 1].date) : null))?.cost),
      },
      caliber: P.caliber ?? null,
    };
    if (!daily.length && !todayRow && !P.windows?.today) warn("闪购推广数据文件在，但逐日与今日都为空");
  } else if (tb && !tbPromo) {
    warn("闪购推广数据缺失（未跑 fetch-taobao-promo.mjs）—— 闪购视图的推广板块将如实降级");
  }

  /**
   * ⭐⭐ R20（2026-09-24 经营者指示）：顶部 KPI 七卡随平台切换 —— 闪购视图的数据层。
   *   与美团 `out.windows` **同构**（渲染层可同构取数），但口径全部来自闪购自己：
   *   · 预计收入 / 有效订单 / 流失单 ← MDA bizWindows（今日=T+0；昨日/近7/近30；
   *     品牌A = o2o+镜像整树求和，品牌B = 单账号 —— 与闪购趋势图同口径）；
   *   · 推广消耗/曝光/点击 ← promo（今日=T+0 实时；昨日=逐日行；近7/近30=USER_TOTAL 原生窗口；
   *     ⚠️ 品牌A页面驱动可能缺逐日行 → 「昨日」推广如实降级为 —）；
   *   · 推广占比 = 推广消耗 ÷ 预计收入 ×100；推广 ROI = 预计收入 ÷ 推广消耗
   *     （R16/R19 分品牌口径：品牌A分母 = o2o 全站推广消耗，品牌B分母 = 斗金推广消耗；
   *     分子与闪购 KPI 预计收入同源（MDA 整树=登录节点视角，已对账一致））；
   *   · 流失率 = 流失单 ÷（有效单 + 流失单）（与取消率趋势图同公式；闪购「流失」≠ 美团「取消单」）。
   *   ⛔ 与美团 KPI 口径不同、门店集合不同，绝不相加 —— 渲染层在闪购视图只读本结构。
   */
  if (tb && (mdaBizWin || out.taobao?.promo)) {
    const PRK = out.taobao?.promo ?? null;
    const kpiDaily = PRK?.daily ?? [];
    const yestDate = kpiDaily.length ? kpiDaily[kpiDaily.length - 1].date : null;
    const promoOf = (key) => {
      if (!PRK) return { cost: null, show: null, click: null, live: false };
      if (key === "today") {
        const t = PRK.today;
        return t && t.cost != null
          ? { cost: t.cost, show: t.impression ?? null, click: t.click ?? null, live: true }
          : { cost: null, show: null, click: null, live: false };
      }
      if (key === "yesterday") {
        const row = yestDate ? kpiDaily.find((x) => x.date === yestDate) : null;
        return row
          ? { cost: row.cost, show: row.impression ?? null, click: row.click ?? null, live: false }
          : { cost: null, show: null, click: null, live: false };
      }
      const w = PRK.windows?.[key] ?? null;
      return w
        ? { cost: w.cost, show: w.impression ?? null, click: w.click ?? null, live: false }
        : { cost: null, show: null, click: null, live: false };
    };
    const kpiWin = (key, label) => {
      const m = mdaBizWin?.[key] ?? null;
      const projectedIncome = m?.expectIncome ?? null;
      const valid = m?.validOrderCnt ?? null;
      const invalid = m?.invalidOrderNum ?? null;
      const pc = promoOf(key);
      const promoRatio =
        projectedIncome != null && pc.cost != null && projectedIncome > 0 ? r2((pc.cost / projectedIncome) * 100) : null;
      const promoRoi = projectedIncome != null && pc.cost != null && pc.cost > 0 ? r2(projectedIncome / pc.cost) : null;
      return {
        label,
        projectedIncome,
        orderCount: valid,
        cancelCount: invalid,
        cancelRate:
          valid != null && invalid != null && valid + invalid > 0 ? r2((invalid / (valid + invalid)) * 100) : null,
        avgOrderValue: projectedIncome != null && valid ? r2(projectedIncome / valid) : null,
        promoCost: pc.cost,
        promoShow: pc.show,
        promoClick: pc.click,
        promoLive: pc.live,
        promoUnavailable: pc.cost == null,
        promoRatio,
        promoRoi,
      };
    };
    out.taobao.kpiWindows = Object.fromEntries(WINDOW_DEFS.map((w) => [w.key, kpiWin(w.key, w.label)]));
  }

  // ════════ 派生：推广占比 + 每窗口 KPI ════════
  out.windows = {};
  for (const w of WINDOW_DEFS) {
    const i = out.income.windows[w.key];
    const a = out.ka.windows[w.key];
    const income = i?.projectedIncome ?? null;
    const cost = a?.cost ?? null;
    /**
     * ⚠️ ka 报表是 T+1，查「今日」**恒返回 0**，不是「今天没花钱」。
     * 直接把 0 渲染成「0.00 元 / 0.00%」会让人以为投放停了 ——
     * 所以要显式区分「有值且为 0」与「该窗口本来就取不到」。
     *
     * ⭐⭐ 2026-09-22：今日改用**推广首页实时接口**（`out.ka.realtime`）——
     *   报表 T+1，但首页有当下值（含今日/昨日**分时**）。有实时值就用实时值，
     *   只有实时也取不到时才退回「—」。
     *   ⭐ R13：实时口径不提供 ROI，但今日 ROI 改为**本看板现算**
     *      （实时消耗 × 今日预计收入），不再依赖平台转化字段。
     */
    const rt = out.ka.realtime;
    const useRt = w.key === "today" && !!rt && rt.cost != null;
    const promoUnavailable = w.key === "today" && !useRt && !cost && !(a?.showCount);
    /** 生效的消耗：今日有首页实时就用实时，否则用报表值；两者都没有才是 null（显示「—」） */
    const effCost = useRt ? rt.cost : promoUnavailable ? null : cost;
    out.windows[w.key] = {
      label: w.label,
      projectedIncome: income,
      orderCount: i?.orderCount ?? null,
      validOrderCount: i?.validOrderCount ?? null,
      cancelCount: i?.cancelCount ?? null,
      cancelRate: i?.cancelRate ?? null,
      avgOrderValue: i?.avgOrderValue ?? null,
      projectedIncomeSource: i?.source ?? null,
      promoCost: effCost,
      promoShow: useRt ? rt.showCount : promoUnavailable ? null : a?.showCount ?? null,
      promoClick: useRt ? rt.clickCount : promoUnavailable ? null : a?.clickCount ?? null,
      /**
       * ⭐⭐ R13（2026-09-24）：推广 ROI 统一改为**本看板口径** = 预计收入 ÷ 推广消耗。
       *   · 今日也**现算**（实时消耗 × 今日预计收入），不再是平台转化口径、不再恒 null；
       *   · 历史窗口：income（平台聚合口径）÷ ka 报表消耗；
       *   · 消耗为 0 / 收入缺失 → null（显示「—」）。
       */
      promoRoi: roiByIncome(income, effCost),
      promoClickRate: useRt ? null : promoUnavailable ? null : a?.clickRate ?? null,
      promoUnavailable,
      /** ⭐ 今日是否走**首页实时口径**（页面据此标注延迟与实时口径说明） */
      promoLive: useRt,
      promoBudget: useRt ? rt.budget : null,
      promoCostRate: useRt ? rt.costRate : null,
      promoChainRatio: useRt ? rt.chainRatio : null,
      promoNote: useRt ? PROMO_LIVE_NOTE : promoUnavailable ? PROMO_T1_NOTE : null,
      promoRoiNote: promoUnavailable ? null : PROMO_ROI_NOTE,
      /** ⭐ 用户口径：推广占比 = 推广消耗 ÷ 预计收入 */
      promoRatio: effCost !== null && income && income > 0 ? r2((effCost / income) * 100) : null,
    };
  }

  /**
   * ⭐⭐ R21（2026-09-24 经营者指示）：「全部平台」KPI 七卡 = **美团 + 闪购 合计**（取代 R20 的并列展示）。
   *   口径（经营者原话拆解，注意这是**明确指定的管理口径**——两平台指标定义本不同）：
   *   · 预计收入 = 美团预计收入 + 闪购预计收入；
   *   · 订单数 = 美团订单数 + 闪购有效订单（闪购侧只有有效订单粒度）；
   *     ⭐ R21b（同日）：KPI 卡「订单数」改显示**有效订单数** = 美团有效订单数 + 闪购有效订单
   *     （= validOrderCount 字段；取消率分母仍用合计订单数）；
   *   · 取消单 = **美团取消单 + 闪购流失订单**（经营者：两者等同处理）；
   *   · 客单价 =（美团+闪购预计收入）÷（美团+闪购有效订单）；
   *   · 推广消耗 = 美团推广消耗 + 闪购推广消耗（闪购分母分品牌：品牌A=o2o 全站推广、品牌B=斗金，见 R20）；
   *   · 推广占比 = 项目推广消耗合计 ÷ 项目预计收入合计；
   *   · ROI = 1 ÷ 推广占比（实现为 收入合计÷消耗合计 直接相除，避免舍入放大）。
   *   ⚠️ 趋势图仍为**并列展示**（不合并曲线）—— 合计仅用于本 KPI 七卡。
   *   某一侧缺失时按可得侧求和（不编数）；两侧都缺 → null（显示「—」）。
   */
  out.kpiAll = {};
  for (const w of WINDOW_DEFS) {
    const m = out.windows[w.key] ?? {};
    const t = out.taobao?.kpiWindows?.[w.key] ?? {};
    const sum = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    const income = sum(m.projectedIncome ?? null, t.projectedIncome ?? null);
    const orderCount = sum(m.orderCount ?? null, t.orderCount ?? null);
    const validCount = sum(m.validOrderCount ?? null, t.orderCount ?? null);
    const cancelCount = sum(m.cancelCount ?? null, t.cancelCount ?? null);
    const promoCost = sum(m.promoCost ?? null, t.promoCost ?? null);
    const promoRatio = promoCost != null && income != null && income > 0 ? r2((promoCost / income) * 100) : null;
    out.kpiAll[w.key] = {
      label: w.label,
      projectedIncome: income,
      orderCount,
      validOrderCount: validCount,
      cancelCount,
      cancelRate: cancelCount != null && orderCount ? r2((cancelCount / orderCount) * 100) : null,
      avgOrderValue: income != null && validCount ? r2(income / validCount) : null,
      promoCost,
      promoShow: sum(m.promoShow ?? null, t.promoShow ?? null),
      promoClick: sum(m.promoClick ?? null, t.promoClick ?? null),
      promoLive: !!(m.promoLive || t.promoLive),
      promoUnavailable: promoCost == null,
      promoRatio,
      /** ROI = 1 ÷ 推广占比（即 收入合计 ÷ 消耗合计；占比为 0 时无意义 → null） */
      promoRoi: promoRatio != null && promoRatio > 0 ? r2(income / promoCost) : null,
    };
  }

  /**
   * ⭐⭐ R22（2026-09-24 经营者指示）：四个趋势板块在「全部平台」下也按**美团 + 闪购 合计**口径。
   *   按时间标签（日期 / 小时）对齐两平台序列后逐字段求和（一侧缺失按可得侧，不编数）：
   *   · income：美团 income.daily/today.hourly[].income + 闪购 MDA expect_income（逐日/分时）；
   *   · cancel：美团取消单/订单数 + 闪购流失单/有效订单（分时有效订单为 R22 新取，见 fetch-taobao-mda）；
   *     取消率由渲染层按 合计取消 ÷ 合计订单 现算；
   *   · promo：仅日粒度 —— 美团 ka 报表逐日 cost + 闪购 promo 逐日 cost；
     *     收入分子 = 美团 income.daily.projectedIncome + 闪购 incomeLogin（R16/R19 口径）；
   *     闪购分时只有今日诊断口径，无法逐时合计 → 小时窗口由渲染层退化为最近 7 天逐日；
   *   · expo：曝光人数 = 美团 uv + 闪购 MDA flowDaily exp_user_num（按日求和）；
   *     闪购无逐日 PV → pv 字段仅美团值，渲染层如实标注「次数仅美团」。
   *   趋势图在闪购/美团视图仍各自独立（不合并），本结构只服务「全部平台」视图。
   */
  const TB_MDA = out.taobao?.mda ?? null;
  const sumNum = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  /** 按 key（date/hour）对齐两套序列并逐字段求和；输出按 key 升序（日期/小时标签字典序即可） */
  const sumBy = (key, aRows, bRows, fields) => {
    const A = new Map((aRows ?? []).map((x) => [x[key], x]));
    const B = new Map((bRows ?? []).map((x) => [x[key], x]));
    const keys = [...new Set([...A.keys(), ...B.keys()])].sort();
    return keys.map((k) => {
      const a = A.get(k) ?? {};
      const b = B.get(k) ?? {};
      const row = { [key]: k };
      for (const f of fields) row[f] = sumNum(a[f] ?? null, b[f] ?? null);
      return row;
    });
  };
  const mtIncHour = (side) =>
    ((side === "yesterday" ? out.today?.hourlyYesterday : out.today?.hourly) ?? [])
      .map((x) => ({ hour: x.hour, value: x.income }));
  const tbIncHour = (side) =>
    ((TB_MDA?.hourly?.expect_income?.[side === "yesterday" ? "previous" : "current"]) ?? [])
      .map((x) => ({ hour: x.hour, value: x.value }));
  const tbInvHour = (side) =>
    ((TB_MDA?.hourly?.invalid_order_num?.[side === "yesterday" ? "previous" : "current"]) ?? [])
      .map((x) => ({ hour: x.hour, cancel: x.value }));
  const tbValidHour = (side) =>
    ((TB_MDA?.hourly?.valid_order_cnt?.[side === "yesterday" ? "previous" : "current"]) ?? [])
      .map((x) => ({ hour: x.hour, orders: x.value }));
  const mtCancelHour = (side) =>
    ((side === "yesterday" ? out.today?.hourlyYesterday : out.today?.hourly) ?? [])
      .map((x) => ({ hour: x.hour, cancel: x.cancel, orders: x.orders }));
  const tbCancelHour = (side) => sumBy("hour", tbInvHour(side), tbValidHour(side), ["cancel", "orders"]);
  const mtIncomeDaily = (out.income.daily ?? []).map((x) => ({ date: x.date, value: x.projectedIncome }));
  const tbIncomeDaily = ((TB_MDA?.daily?.expect_income?.points) ?? []).map((x) => ({ date: x.date, value: x.value }));
  const mtCancelDaily = (out.income.daily ?? []).map((x) => ({ date: x.date, cancel: x.cancelCount, orders: x.orderCount }));
  const tbValidDaily = ((TB_MDA?.daily?.valid_order_cnt?.points) ?? []).map((x) => ({ date: x.date, orders: x.value }));
  const tbInvDaily = ((TB_MDA?.daily?.invalidOrderNum?.points) ?? []).map((x) => ({ date: x.date, cancel: x.value }));
  const tbCancelDaily = sumBy("date", tbInvDaily, tbValidDaily, ["cancel", "orders"]);
  const mtIncByDate = new Map((out.income.daily ?? []).map((x) => [x.date, x.projectedIncome]));
  const mtPromoDaily = [...(out.ka.daily ?? []), ...(out.ka.daily30 ?? [])]
    .map((x) => ({ date: x.date, cost: x.cost, income: mtIncByDate.get(x.date) ?? null }));
  const tbPromoDaily = ((out.taobao?.promo?.daily) ?? []).map((x) => ({ date: x.date, cost: x.cost, income: x.incomeLogin }));
  // ⭐ R22b（2026-09-24 经营者指示）：今日分时可以双平台对齐求和 —— 美团首页实时分时（R13 已enrich收入）
  //   + 闪购「数据诊断」卡今日分时（todayHourly，含 incomeLogin）。昨日闪购无分时消耗 → 昨日仍退逐日。
  //   ⚠️ 两侧小时标签格式不同（美团 "HH:00"，闪购 0..23 数字）—— 归一化成 "HH:00" 再求和，
  //   否则按标签并集会翻倍成 48 个点（实测踩过）。
  const hh00 = (h) => `${String(Number(h)).padStart(2, "0")}:00`;
  const mtPromoHour = ((out.ka?.realtime?.hourly) ?? []).map((x) => ({ hour: x.hour, cost: x.cost, income: x.income }));
  const tbPromoHour = ((out.taobao?.promo?.todayHourly) ?? []).map((x) => ({ hour: hh00(x.hour), cost: x.cost, income: x.incomeLogin }));
  const mtExpoDaily = ((out.exposure?.daily) ?? []).map((x) => ({ date: x.date, uv: x.uv, pv: x.pv }));
  const tbExpoDailyUv = ((TB_MDA?.flowDaily?.exp_user_num?.points) ?? []).map((x) => ({ date: x.date, uv: x.value }));
  // ⚠️ 渲染层不得直读 p.taobao.mda（parity fixture 裁掉 taobao 重载荷 → 字段名漂移误报），
  //   闪购流量窗口/最新日 UV 一并放进 trendAll.expo.flow。
  const tbFlow = TB_MDA?.flowWindows ?? null;
  out.trendAll = {
    income: {
      hourly: {
        today: sumBy("hour", mtIncHour("today"), tbIncHour("today"), ["value"]),
        yesterday: sumBy("hour", mtIncHour("yesterday"), tbIncHour("yesterday"), ["value"]),
      },
      daily: sumBy("date", mtIncomeDaily, tbIncomeDaily, ["value"]),
    },
    cancel: {
      hourly: {
        today: sumBy("hour", mtCancelHour("today"), tbCancelHour("today"), ["cancel", "orders"]),
        yesterday: sumBy("hour", mtCancelHour("yesterday"), tbCancelHour("yesterday"), ["cancel", "orders"]),
      },
      daily: sumBy("date", mtCancelDaily, tbCancelDaily, ["cancel", "orders"]),
    },
    promo: {
      daily: sumBy("date", mtPromoDaily, tbPromoDaily, ["cost", "income"]),
      /** ⭐ R22b：今日分时合计（美团实时 + 闪购诊断卡，按小时对齐求和）；昨日闪购无分时消耗 → 恒空 */
      hourly: {
        today: sumBy("hour", mtPromoHour, tbPromoHour, ["cost", "income"]),
        yesterday: [],
      },
    },
    expo: {
      daily: sumBy("date", mtExpoDaily, tbExpoDailyUv, ["uv", "pv"]),
      /** 闪购流量窗口（expUvAll/expPvAll）与最新日 UV —— 供曝光卡合计小表；无 MDA 流量数据时为 null */
      flow: tbFlow
        ? {
            d7: { uv: tbFlow.d7?.expUvAll ?? null, pv: tbFlow.d7?.expPvAll ?? null },
            d30: { uv: tbFlow.d30?.expUvAll ?? null, pv: tbFlow.d30?.expPvAll ?? null },
            lastUv: tbExpoDailyUv.length ? tbExpoDailyUv[tbExpoDailyUv.length - 1].uv : null,
          }
        : null,
    },
  };

  // ── 高取消门店（近7天 / 近30天）──
  const topCancel = (arr, minOrders) =>
    arr
      .filter((x) => x.orders >= minOrders && x.cancel > 0)
      .sort((a, b) => b.rate - a.rate || b.cancel - a.cancel)
      .slice(0, 30);
  out.highCancelD7 = topCancel(out.income.byPoiD7 ?? [], 5);
  out.highCancelD30 = topCancel(out.income.byPoiD30 ?? [], 20);

  // ── 门店营业状态分布（美团接口口径）──
  out.storeChart = Object.entries(out.mtStatusDist).map(([name, value]) => ({ name, value }));

  return out;
}

/**
 * 组装完整 VM（含口径真相源与全局说明）。
 *
 * @param {object} o
 * @param {Array<object>} o.projects 已装配的项目对象（保持顺序）
 * @param {string} o.generatedAt
 * @param {(m:string)=>void} [o.warnInfo] 非告警信息（如 crossCheck 提示）的回调
 */
export function buildDashboardVm({ projects, generatedAt, projectMetas, warnInfo }) {
  const byKey = Object.fromEntries(projects.map((p) => [p.key, p]));
  // ── 全局提示（诚实标注缺口）──
  //
  // ⚠️ 口径说明**一律由 src/lib/caliber.mjs 生成**，不再在这里写死字符串。
  //    2026-09-21 的事故：收入已从「逐单求和」换成「平台聚合」，而这段 notes[0] 忘了改，
  //    于是 KPI 徽标说「平台 multiProjectedIncome」、下面的口径说明说「Σ 逐单求和」——
  //    同一页上自相矛盾，且用户会照着错的说明去理解数字。
  //    现在按各项目自报的 `income.source` 生成：来源不同时**分别写清**。
  const notes = [];
  const sourceByProject = Object.fromEntries(projectMetas.map((p) => [p.key, byKey[p.key].income.source ?? null]));
  const labelByProject = Object.fromEntries(projectMetas.map((p) => [p.key, p.label]));
  notes.push(incomeCaliberNotes(sourceByProject, labelByProject));
  notes.push(promoNotes());
  notes.push(ISOLATION.PROJECT_NOTE);
  // ⚠️ 2026-09-22：经营者移除了「② 异常未营业门店明细」板块，故不再输出 ANOMALY_NOTE ——
  //    否则页面会为一块已经不显示的指标写口径说明（常量本身保留在 caliber.ISOLATION 里留档）。
  notes.push(ISOLATION.RECENT_HOUR_NOTE);
  notes.push(ISOLATION.PLATFORM_NOTE);
  notes.push(PLATFORM_NOTE);
  for (const meta of projectMetas) {
    const w = byKey[meta.key].warnings;
    if (w.length) notes.push(`**${meta.label} 数据缺口**：${w.join("；")}。`);
  }
  void warnInfo;

  return {
    generatedAt,
    projectOrder: projectMetas.map((p) => p.key),
    projects: byKey,
    notes,
    /**
     * ⭐ 口径的**单一真相源**（来自 src/lib/caliber.mjs），注入给看板只读。
     *   模板不再自己写「推广消耗 ÷ 预计收入」这类字符串，也不再把阈值写死 ——
     *   否则口径一改、文案没跟，就又是 notes[0] 那种自相矛盾。
     */
    caliber: buildCaliber({ projectOrder: projectMetas.map((p) => p.key), projects: byKey }),
    thresholds: THRESHOLDS,
    selfCheckSpecs: SELF_CHECK_SPECS,
    /**
     * 口径不变量的**构建期**结论（与页面自检块共用同一份 id 语义）。
     * 注入原因：其中「VM 内无 undefined/NaN」与「平台不可加」这两条必须遍历整份 VM，
     * 而页面侧若对 VM 做 `JSON.stringify` 会**把读集探针淹掉**（每个字段都变成"被读过"），
     * parity 的「读集对照」就失效了。所以这两条在构建期算好、页面直接展示；
     * 其余断言页面侧**自己再算一遍并要求与构建期结论一致**（不一致就红）。
     */
    selfCheck: verifyCaliber({
      generatedAt, projectOrder: projectMetas.map((p) => p.key), projects: byKey, notes,
      caliber: buildCaliber({ projectOrder: projectMetas.map((p) => p.key), projects: byKey }),
    }),
  };
}

/** 口径不变量自检（与看板页面内自检块用**同一份 id 语义**）。 */
export function verifyCaliber(vm) {
  return checkInvariants(vm);
}

/**
 * 把 VM 与内联 echarts 注入模板，得到自包含单文件 HTML。
 * 模板契约（不许破坏）：`<!--ECHARTS-->` 与数据占位符各一处，产物恰好两个内联 `<script>`。
 *
 * ⚠️ 一律用**函数式替换**（`replace(x, () => y)`），不用字符串式替换。
 *    字符串式替换会把替换文本里的 `$&` / `` $` `` / `$'` / `$1` 当**替换模式**展开 ——
 *    echarts.min.js 里满是 `$`，一旦命中就会静默改坏内联脚本且很难察觉。
 */
export function assembleDashboardHtml({ template, echartsJs, vm, appJs = null, dataPlaceholder }) {
  const ph = dataPlaceholder ?? "/*__" + "DATA__*/";
  const APP_PH = "/*__" + "APP__*/";

  let html = template.replace("<!--ECHARTS-->", () => `<script>${echartsJs}</script>`);

  if (appJs != null) {
    // 方案 T：模板骨架只放 `/*__APP__*/`，应用脚本来自 `src/template/app/*.js` 分片拼接。
    // VM 仍然通过数据占位符注入到应用脚本内部（模板与分片共用同一个占位符）。
    if (!appJs.includes(ph)) throw new Error("拼接后的应用脚本里找不到数据占位符，VM 注入点丢了");
    const filled = appJs.replace(ph, () => JSON.stringify(vm));
    if (!html.includes(APP_PH)) throw new Error("模板里找不到应用脚本占位符 `/*__APP__*/`");
    html = html.replace(APP_PH, () => filled);
  } else {
    if (!html.includes(ph)) throw new Error("模板里找不到数据占位符，VM 注入点丢了");
    html = html.replace(ph, () => JSON.stringify(vm));
  }

  if (!html.includes("const VM = ")) throw new Error("注入后仍找不到 `const VM = `，模板契约被破坏");
  return html;
}
