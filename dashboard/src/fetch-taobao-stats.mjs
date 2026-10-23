/**
 * 闪购「营业统计」取数 —— 今日/昨日详情 + 分时 + 逐日趋势 + 窗口聚合。
 *   node src/fetch-taobao-stats.mjs [--account=quanyi|yifeng] [--days=30]
 *
 * ⛔⛔ **2026-09-23 起整族失效**（开源项目实测）：protein ① 族接口对**品牌A与品牌B
 *    两账号一律返回 F**，与账号 nodeType 无关（品牌A nodeType=6 / 品牌B nodeType=2 都挂），
 *    疑为平台下线或权限收紧。跑本脚本只会得到全 F、不覆盖落盘。
 *    → 闪购营业数据请用 **② 族 MDA**：`src/fetch-taobao-mda.mjs`（两账号通用，
 *      品牌A自动做 o2o+镜像双子账号求和）。本脚本保留供 ① 族复活时恢复。
 *
 * 为什么要有这个脚本（2026-09-22）：
 *   经营者指出闪购后台的「营业统计」「推广」页面**本来就有**今日实时、分时、近7日/近30日数据，
 *   而看板此前只有一份近 7 天窗口聚合。平台切换器（全部平台/美团/闪购）要做，
 *   就必须先把这些序列取回来 —— 否则闪购视图是空的。
 *
 * 通路：纯 Node / MTOP（`nrshop.ele.me`，jsv 2.7.0），签名自算，**不需要浏览器**。
 *   proteinCode 地图（2026-09-22 嗅探得出，已回填 reference §6.11）：
 *   ┌──────────┬──────────────┬────────────────────────────────────────────────┐
 *   │ SDqJ77i  │ 单日详情      │ {date, currHour} → gmv/expect_income/valid_order_num/pct/pay_amt/invalid_order_num │
 *   │ SGU1kB5  │ 分时趋势      │ {date, currHour, field:"gmv"} → [{point_hour, original_amt}]            │
 *   │ SCEDHRd  │ 逐日趋势      │ {begin_day, end_day, prd_type:"custom", date_type, chart_type, ds}     │
 *   │          │              │ → [{index_day, <归一化字段>}]（chart_type 传**中文**，服务端归一化）   │
 *   │ SC8LRHx  │ 窗口聚合      │ {begin_day, end_day, prd_type:"week", date_type, ds}                   │
 *   └──────────┴──────────────┴────────────────────────────────────────────────┘
 *
 * ⚠️ 金额量纲：闪购这些接口返回的是**元**（与门店明细一致），不要再 ÷100。
 * ⚠️ 口径与美团不同：闪购的「预计收入」= `expect_income`，美团的是 `multiProjectedIncome`；
 *    两者**定义不同、门店集合也不同，不可相加**。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { mtopCall, ensureMtopToken } from "./lib/mtop.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const STEM = acct.key === "quanyi" ? "taobao" : `taobao-${acct.key}`;
const PORT = Number(arg("port", acct.key === "quanyi" ? "9222" : "9223"));
const DAYS = Number(arg("days", "30"));
const OUT = dataPath(acct, "taobao-stats");

const GATEWAY = { host: "nrshop.ele.me", jsv: "2.7.0" };
const NS = "mtop.me.ele.newretail.data.analysis";

/** 东八区日期：YYYYMMDD / YYYY-MM-DD */
const ymd = (offset = 0) => {
  const t = new Date(Date.now() + offset * 86400_000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(t).replace(/-/g, "");
};
const dash = (s) => (s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);

let { cookies } = await loadCookieSmart({ stem: STEM, port: PORT, host: "nr.ele.me", required: ["WMSTOKEN"] });
if (!cookies._m_h5_tk) {
  console.log("[cookie] 缺 _m_h5_tk，向网关引导…");
  cookies = await ensureMtopToken(cookies, { host: "mtop.ele.me", jsv: "2.5.8" });
}

const rotated = {};
const mtop = async (api, data) => {
  const r = await mtopCall({ api, data, cookies: { ...cookies, ...rotated }, host: GATEWAY.host, jsv: GATEWAY.jsv });
  if (r.cookies?._m_h5_tk && r.cookies._m_h5_tk !== (rotated._m_h5_tk ?? cookies._m_h5_tk)) rotated._m_h5_tk = r.cookies._m_h5_tk;
  return r;
};

// ── 登录节点（protein 的 context 要 id/role）──
const nodeResp = await mtop("mtop.ele.newretail.ebai.MultiLevelMtopService.getLoginnode", {});
if (!nodeResp.ok) {
  console.error(`⛔ 取登录节点失败：${nodeResp.ret}`);
  process.exit(2);
}
const login = (nodeResp.data?.data ?? nodeResp.data)?.loginNodeInfo ?? {};
const ID = String(login.nodeId ?? "");
const ROLE = String(login.nodeType ?? "");
if (!ID) { console.error("⛔ 登录节点没有 nodeId"); process.exit(2); }
console.log(`账号 ${acct.label}（${acct.key}）  nodeId=${ID} nodeType=${ROLE}`);

/** proteinQueryForArea 的固定信封 */
async function protein(proteinCode, parameters) {
  const data = {
    context: JSON.stringify({ appName: "kbtdatacenter", userName: ROLE, userId: ID }),
    request: JSON.stringify({
      proteinCode,
      withTracker: true,
      parameters: { id: ID, role: ROLE, ...parameters },
    }),
  };
  const r = await mtop(`${NS}.proteinQueryForArea`, data);
  if (!r.ok) return { error: r.ret?.[0] ?? r.ret };
  const dd = r.data?.data;
  if (dd?.result?.success === false || dd?.success === false) return { error: `result 失败：${JSON.stringify(dd.result).slice(0, 160)}` };
  return { result: dd?.result, parameters: dd?.parameters };
}

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const DS = ymd(-1); // 数据截止日（T+1，与门店明细一致）

console.log(`窗口：ds=${DS}（数据截止日）  逐日回溯 ${DAYS} 天\n`);

// ════════ ① 单日详情：今日 / 昨日 ════════
const dayDetail = async (date) => {
  const r = await protein("SDqJ77i", { date, currHour: String(new Date().getHours()) });
  const rec = r.result?.record ?? null;
  if (!rec) return { date, error: r.error ?? "无 record" };
  return {
    date,
    gmv: num(rec.gmv),
    expectIncome: num(rec.expect_income),
    validOrderNum: num(rec.valid_order_num),
    avgOrderAmt: num(rec.pct),
    payAmt: num(rec.pay_amt),
    invalidOrderNum: num(rec.invalid_order_num),
  };
};
const todayStr = ymd(0);
const yestStr = ymd(-1);
const detailToday = await dayDetail(todayStr);
console.log(`① 今日(${dash(todayStr)})  成交额 ${detailToday.gmv ?? "—"}  预计收入 ${detailToday.expectIncome ?? "—"}  有效订单 ${detailToday.validOrderNum ?? "—"}${detailToday.error ? `  ⚠️ ${detailToday.error}` : ""}`);
const detailYesterday = await dayDetail(yestStr);
console.log(`   昨日(${dash(yestStr)})  成交额 ${detailYesterday.gmv ?? "—"}  预计收入 ${detailYesterday.expectIncome ?? "—"}  有效订单 ${detailYesterday.validOrderNum ?? "—"}${detailYesterday.error ? `  ⚠️ ${detailYesterday.error}` : ""}`);

// ════════ ② 分时趋势：今日 / 昨日 ════════
/**
 * ⚠️ 实测：`SGU1kB5` 返回的是**累计值**（cumulative），不是每小时增量 ——
 *   今日 00:00→47.8、…、16:00→3937.61（正好等于当天总成交额），单调递增。
 *   闪购页面上那个「累计 / 分时」开关印证了这一点。**没有抓到「分时」那档的参数**，
 *   所以这里**自己差分**得到每小时增量，并把原始累计值一并留存（可复核）。
 */
const hourly = async (date, field = "gmv") => {
  const r = await protein("SGU1kB5", { date, currHour: String(new Date().getHours()), field });
  const recs = r.result?.records ?? [];
  if (!recs.length) return { date, points: [], cumulative: [], error: r.error ?? null };
  const cumulative = recs
    .map((x) => ({ hour: `${String(x.point_hour).padStart(2, "0")}:00`, value: num(x.original_amt) ?? num(x.gmv) }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
  let prev = 0;
  const points = cumulative.map((x) => {
    const inc = x.value != null ? Number((x.value - prev).toFixed(2)) : null;
    if (x.value != null) prev = x.value;
    return { hour: x.hour, value: inc };
  });
  return { date, points, cumulative };
};
const hourToday = await hourly(todayStr, "gmv");
const hourYest = await hourly(yestStr, "gmv");
console.log(`② 分时（累计→增量）  今日 ${hourToday.points.length} 段 / 昨日 ${hourYest.points.length} 段${hourToday.error || hourYest.error ? `  ⚠️ ${hourToday.error ?? ""}${hourYest.error ?? ""}` : ""}`);
if (hourToday.points.length) {
  const sum = hourToday.points.reduce((s, x) => s + (x.value ?? 0), 0);
  console.log(`   校验：今日增量合计 ${sum.toFixed(2)} vs 当日总成交额 ${detailToday.gmv ?? "—"}（应接近）`);
}

/**
 * ⭐ ②b **多指标分时**（2026-09-22 补齐）：`SGU1kB5` 的 `field` 可换，
 *   服务端会把 field 归一化成指标名 —— 实测：
 *   `gmv→original_amt`、`expect_income→expect_income`、`valid_order_num→valid_order_cnt`、
 *   `invalid_order_num→invalid_order_cnt`（**流失订单**）、`pay_amt→valid_amt`。
 *   ⚠️ 闪购把「取消单」叫 **流失订单**（= 取消 + 全款退，定义比美团宽），不可与美团相加。
 */
const FIELD_MAP = [
  { key: "gmv", field: "gmv", fieldName: "original_amt" },
  { key: "expectIncome", field: "expect_income", fieldName: "expect_income" },
  { key: "validOrderNum", field: "valid_order_num", fieldName: "valid_order_cnt" },
  { key: "invalidOrderNum", field: "invalid_order_num", fieldName: "invalid_order_cnt" },
];
async function hourlyField(date, map) {
  const r = await protein("SGU1kB5", { date, currHour: String(new Date().getHours()), field: map.field });
  const recs = r.result?.records ?? [];
  if (!recs.length) return { date, points: [], error: r.error ?? null };
  const seq = recs
    .map((x) => ({ hour: `${String(x.point_hour).padStart(2, "0")}:00`, value: num(x[map.fieldName]) ?? num(x[map.field]) }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
  /**
   * ⚠️⚠️ **所有 field 返回的都是累计值**，不只是 gmv —— 实测 `expect_income`
   *   单调递增到 1222.24（= 当天预计收入总额）、`valid_order_num` 递增到 66。
   *   所以**每个字段都要差分**成每小时增量；不差分就会画成上升阶梯。
   *   （我第一版只对 gmv 差分，其余直接画 → 阶梯状，已被这行注释记录的核对抓出来。）
   */
  const isCumulative = true;
  let prev = 0;
  const points = seq.map((x) => {
    if (!isCumulative) return x;
    const inc = x.value != null ? Number((x.value - prev).toFixed(2)) : null;
    if (x.value != null) prev = x.value;
    return { hour: x.hour, value: inc };
  });
  return { date, points, cumulative: isCumulative };
}
const hourlyBy = { today: {}, yesterday: {} };
for (const m of FIELD_MAP) {
  hourlyBy.today[m.key] = await hourlyField(todayStr, m);
  hourlyBy.yesterday[m.key] = await hourlyField(yestStr, m);
}
console.log(
  `②b 多指标分时：` +
    FIELD_MAP.map((m) => `${m.key} 今日${hourlyBy.today[m.key].points.length}段/昨日${hourlyBy.yesterday[m.key].points.length}段`).join(" · "),
);

// ════════ ②c 曝光（闪购「曝光数据」页，2026-09-22 嗅探）════════
/**
 * 暴露页的 proteinCode（全部来自 `exposureDataPc` 页面的抓包）：
 *   S3Bjcm5  单日汇总   {day}                          → {exp_uv_all, exp_pv_all, clk_uv_all, order_user_cnt_all}
 *   S3C2zhg  **分时**   {day}                          → records[{point_hour, exp_uv_all, clk_uv_all, order_user_cnt_all}]
 *   S2iMgSM  窗口汇总   {begin_day=end_day=ds, prd_type:"7days"}
 *   S2iYJNZ  曝光来源构成 {begin_day=end_day=ds, prd_type:"7days"} → {exp_uv_all, exp_uv_guide, exp_uv_category, exp_uv_search…}
 *   S2cuQyx  **逐日**   {begin_day=end_day=ds, prd_type:"7days"} → records[{data_dt, exp_uv_all…}]
 */
const expoDay = async (day) => {
  const r = await protein("S3Bjcm5", { day });
  const rec = r.result?.records?.[0];
  if (!rec) return { day, error: r.error ?? "无 records" };
  return {
    day,
    expUvAll: num(rec.exp_uv_all), expPvAll: num(rec.exp_pv_all),
    clkUvAll: num(rec.clk_uv_all), orderUserCnt: num(rec.order_user_cnt_all),
    clkCvr: num(rec.clk_cvr_all), orderCvr: num(rec.order_cvr_all),
  };
};
const expoHourly = async (day) => {
  const r = await protein("S3C2zhg", { day });
  const recs = r.result?.records ?? [];
  if (!recs.length) return { day, points: [], error: r.error ?? null };
  return {
    day,
    points: recs
      .map((x) => ({ hour: `${String(x.point_hour).padStart(2, "0")}:00`, expUv: num(x.exp_uv_all), clkUv: num(x.clk_uv_all), orderUser: num(x.order_user_cnt_all) }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
  };
};
const expoWindow = async (prdType) => {
  const r = await protein("S2iMgSM", { begin_day: DS, end_day: DS, prd_type: prdType });
  const rec = r.result?.records?.[0];
  if (!rec) return { prdType, error: r.error ?? "无 records" };
  return {
    prdType,
    expPvAll: num(rec.exp_pv_all), expUvAll: num(rec.exp_uv_all),
    clkUvAll: num(rec.clk_uv_all), validOrderCnt: num(rec.valid_order_cnt_all),
  };
};
const expoSources = async (prdType) => {
  const r = await protein("S2iYJNZ", { begin_day: DS, end_day: DS, prd_type: prdType });
  const rec = r.result?.records?.[0];
  if (!rec) return { prdType, error: r.error ?? "无 records" };
  const out = { prdType };
  for (const [k, v] of Object.entries(rec)) {
    if (k === "partition_node_id" || k === "partition_node_name") continue;
    out[k] = num(v);
  }
  return out;
};
const expoDaily = async (prdType) => {
  const r = await protein("S2cuQyx", { begin_day: DS, end_day: DS, prd_type: prdType });
  const recs = r.result?.records ?? [];
  return recs.map((x) => ({ date: dash(String(x.data_dt)), expUv: num(x.exp_uv_all), clkUv: num(x.clk_uv_all), orderUser: num(x.order_user_cnt_all) }))
    .sort((a, b) => a.date.localeCompare(b.date));
};
const exposure = {
  today: await expoDay(todayStr),
  yesterday: await expoDay(yestStr),
  hourlyToday: await expoHourly(todayStr),
  hourlyYesterday: await expoHourly(yestStr),
  windows: { d7: await expoWindow("7days"), d30: await expoWindow("30days") },
  sources: { d7: await expoSources("7days") },
  daily: await expoDaily("7days"),
  /** ⭐ 逐日 30 天（`prd_type:"30days"`）—— 看板「近30天」窗口要它 */
  daily30: await expoDaily("30days"),
};
/**
 * ⚠️ 实测 `S3Bjcm5`（单日汇总）**对「昨日」返回失败**（`F`），但**分时是好的**。
 *   所以昨日的曝光总数用**分时求和**兜底（并标注来源），不把失败当 0。
 *   ✅ 顺带核对：曝光分时**不是累计值**（数值上下波动），可直接画，无需差分。
 */
if (exposure.yesterday?.error && exposure.hourlyYesterday.points.length) {
  const sum = exposure.hourlyYesterday.points.reduce((s, p) => s + (p.expUv ?? 0), 0);
  exposure.yesterday = { day: yestStr, expUvAll: sum, derivedFrom: "hourly-sum", note: "单日接口对昨日失败，用分时求和兜底" };
}
console.log(
  `②c 曝光  今日 ${exposure.today.expUvAll ?? "—"} / 昨日 ${exposure.yesterday.expUvAll ?? "—"} · ` +
    `分时 今日${exposure.hourlyToday.points.length}段/昨日${exposure.hourlyYesterday.points.length}段 · ` +
    `近7日 ${exposure.windows.d7.expPvAll ?? "—"} 曝光次数 · 逐日 ${exposure.daily.length} 天`,
);

// ════════ ③ 逐日趋势（逐日序列）════════
/**
 * ⚠️ `chart_type` 传的是**中文指标名**，服务端归一化成字段名（实测「总成交额」→ `order_total_amt`）。
 *    返回 `records[].index_day` + 该字段。**这是闪购唯一能给出逐日序列的接口。**
 * ⚠️ 不是所有中文名都被接受：实测「流失订单」报 `chart_type 必填！`（即未命中映射），
 *    所以每个指标给一串候选名，命中即用（自愈，不必猜死）。
 */
const CHART_TYPES = [
  { key: "gmv", labels: ["总成交额"] },
  { key: "expectIncome", labels: ["预计收入"] },
  { key: "validOrderNum", labels: ["有效订单"] },
  { key: "invalidOrderNum", labels: ["流失订单", "流失单数", "流失订单数", "无效订单", "取消订单", "invalid_order_num", "invalid_order_cnt", "流失单"] },
];
const dailyBy = {};
for (const ct of CHART_TYPES) {
  dailyBy[ct.key] = [];
  for (const label of ct.labels) {
    const r = await protein("SCEDHRd", {
      begin_day: ymd(-DAYS), end_day: DS, prd_type: "custom", date_type: `近${DAYS}日`, chart_type: label, ds: DS,
    });
    const recs = r.result?.records ?? [];
    if (!recs.length) continue;
    dailyBy[ct.key] = recs
      .map((x) => {
        const vals = Object.entries(x).filter(([k]) => k !== "index_day");
        return { date: dash(String(x.index_day)), value: num(vals[0]?.[1]) };
      })
      .filter((x) => x.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    console.log(`③ 逐日「${label}」(→ ${ct.key}) ${dailyBy[ct.key].length} 天`);
    break;
  }
  if (!dailyBy[ct.key].length) console.log(`③ 逐日「${ct.key}」⬜ 所有候选 chart_type 都不被接受：${ct.labels.join("/")}`);
}

// ════════ ④ 窗口聚合：近7日 / 近30日 ════════
/**
 * ⛔⛔ **必须 `begin_day = end_day = ds`**，靠 `prd_type` 决定窗口长度。
 *    踩过：我第一版传 `begin_day=ds-7, end_day=ds`（一个区间）+ `prd_type=week`，
 *    得到 379,387.6，而平台显示是 51,875.24 —— **差 7.3 倍**（服务端把区间按周重复展开了）。
 *    嗅探里页面发的就是 `begin_day=end_day=20260921&prd_type=week` → 51,875.24。
 */
const windowAgg = async (days, prdType) => {
  const r = await protein("SC8LRHx", {
    begin_day: DS, end_day: DS, prd_type: prdType, date_type: `近${days}日`, ds: DS,
  });
  const rec = r.result?.records?.[0];
  if (!rec) return { days, error: r.error ?? "无 records" };
  return {
    days,
    prdType,
    start: dash(ymd(-days)), end: dash(DS),
    orderTotalAmt: num(rec.order_total_amt),
    merchantIncome: num(rec.merchant_income),
    orderCnt: num(rec.order_cnt),
    avgOrderTotalAmt: num(rec.avg_order_total_amt),
    payAmt: num(rec.pay_amt),
    invalidOrderCnt: num(rec.invalid_order_cnt),
    invalidOrderAmt: num(rec.invalid_order_amt),
    shopSubsidyRate: num(rec.shop_subsidy_rate),
  };
};
const w7 = await windowAgg(7, "week");
const w30 = await windowAgg(30, "month");
console.log(`④ 窗口  近7日 成交额 ${w7.orderTotalAmt ?? "—"} 订单 ${w7.orderCnt ?? "—"}${w7.error ? ` ⚠️ ${w7.error}` : ""}`);
console.log(`        近30日 成交额 ${w30.orderTotalAmt ?? "—"} 订单 ${w30.orderCnt ?? "—"}${w30.error ? ` ⚠️ ${w30.error}` : ""}`);
console.log(`   ⭐ 对账：近7日成交额应等于 taobao-stores-detail 的 kpi.order_total_amt（实测 51875.24）`);

// ── 落盘（与门店明细同样的保护：全失败时不覆盖）──
const anyOk = [detailToday, detailYesterday, hourToday, hourYest].some((x) => !x.error) || Object.values(dailyBy).some((a) => a.length) || !w7.error;
if (!anyOk) {
  console.error(`\n⛔ 全部接口失败，**不覆盖** ${OUT}`);
  await writeFile(join(ROOT, "_recon", "taobao-stats-last-error.txt"), JSON.stringify({ detailToday, detailYesterday, hourToday: hourToday.error, hourYest: hourYest.error, w7 }, null, 2), "utf8");
  process.exit(2);
}
if (rotated._m_h5_tk) {
  const merged = { ...cookies, ...rotated };
  await writeFile(join(ROOT, ".secrets", `${STEM}.cookie.txt`), Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("; ") + "\n", "utf8");
}

const payload = {
  fetchedAt: new Date().toISOString(),
  account: { key: acct.key, label: acct.label },
  source: "taobao-shangou-stats",
  caliber: "闪购 MDA proteinQueryForArea（nrshop.ele.me，jsv 2.7.0）。金额单位=**元**。⚠️ 与美团口径不同、门店集合不同，**不可相加**。",
  ds: DS,
  days: DAYS,
  today: todayStr,
  yesterday: yestStr,
  detail: { today: detailToday, yesterday: detailYesterday },
  hourly: { today: hourToday, yesterday: hourYest },
  /** ⭐ 多指标分时（成交额/预计收入/有效订单/流失订单）—— 闪购把「取消单」叫**流失订单** */
  hourlyByField: hourlyBy,
  /** ⭐ 曝光（闪购「曝光数据」页）：单日 + 分时 + 窗口 + 来源构成 + 逐日 */
  exposure,
  daily: dailyBy,
  windows: { d7: w7, d30: w30 },
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
console.log(`\n落盘 ${OUT}`);
