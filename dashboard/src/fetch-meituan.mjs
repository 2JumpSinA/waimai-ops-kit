/**
 * 美团医药商家端取数。
 *   node src/fetch-meituan.mjs [--account=quanyi|yifeng] [--port=9222] [--days=7]
 *
 * 前置：先双击 start-chrome-<account>.cmd 起一个带调试端口的浏览器
 *       （渲染进程必须在沙箱外才行；Node spawn 的会被拦）
 *
 * 设计要点：
 *   - 所有请求都在**页面上下文里**发 —— 风控 SDK 会自动加 mtgsig
 *   - 分板块独立容错：一个板块挂了，其它板块照常出数（看板上降级成一行提示）
 *   - 原始响应全量落 data/raw/，便于事后核字段、对口径
 *   - 一个账号一个文件：meituan-<account>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieSmart, cookieValue } from "./lib/cookie.mjs";
import { connectToPage, setCookies, waitSignedReady, pageFetchAll, assertNotLoginRedirect } from "./lib/cdp.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";

const DOMAIN = "yiyao.meituan.com";
const FRAME = `https://${DOMAIN}/main/frame`;

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : dflt;
};

const acct = resolveAccount(process.argv);
const PORT = arg("port", acct.port);
const DAYS = arg("days", 7);

/** 账号 -> cookie 文件 stem */
const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const OUT = dataPath(acct, "meituan");

/**
 * ⭐ 优先从浏览器 profile 读**活 cookie**（会自动续期），读不到才回退静态文件。
 * 这样只要调试浏览器偶尔开着，就不必反复手工导出 cookie。
 */
const { header: COOKIE, source: COOKIE_SOURCE } = await loadCookieSmart({
  stem: STEM,
  port: PORT,
  host: DOMAIN,
  required: ["token", "acctId"],
});
const ACCT = cookieValue(COOKIE, "acctId");
const TOKEN = cookieValue(COOKIE, "token") ?? "";
const BIZ = cookieValue(COOKIE, "account_businesstype") ?? "1";

/** 日期工具 —— ⚠️ 绝不用 toISOString()，东八区晚 8 点后会变成明天 */
const fmt = (offsetDays) => {
  const t = new Date(Date.now() + offsetDays * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    /** YYYYMMDD —— 经营分析/服务分析用 */
    ymd: `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`,
    /** YYMMDD —— 曝光排行接口用 */
    short: `${p(t.getFullYear() % 100)}${p(t.getMonth() + 1)}${p(t.getDate())}`,
    /** YYYY-MM-DD —— 评价接口用 */
    iso: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`,
  };
};
const TODAY = fmt(0), Y1 = fmt(-1), Y2 = fmt(-2), D7 = fmt(-DAYS), D30 = fmt(-30);

/** 服务分析的公共参数（后端真实形态） */
const svc = (begin, end, cmpBegin, cmpEnd, recent) =>
  `beginTime=${begin.ymd}&endTime=${end.ymd}&compareBeginTime=${cmpBegin.ymd}&compareEndTime=${cmpEnd.ymd}&recentDays=${recent}&cityIds=`;

/** 经营首页的公共参数 */
const home = (begin, end) =>
  `businessType=${BIZ}&storeType=2&cityId=&labelId=&dateType=realTime` +
  `&beginTime=${begin.ymd}&endTime=${end.ymd}&compareBeginTime=${Y2.ymd}&compareEndTime=${Y2.ymd}`;

async function main() {
  const cdp = await connectToPage(PORT);
  console.log(`账号 ${acct.label}（${acct.key}）  端口 ${PORT}`);
  console.log(`✅ 已连接（${cdp.browser}）`);
  await setCookies(cdp, COOKIE, DOMAIN);
  await cdp.send("Page.navigate", { url: FRAME });
  // 登录态失效时必须在这里就报清楚，否则后面会抛 "navigated or closed"（看不出真因）
  const landed = await assertNotLoginRedirect(cdp, { label: `美团医药商家端（${acct.label}）` });
  if (process.env.DSH_DEBUG_URL) console.log(`   落地: ${landed}`);
  const ready = await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", {
    timeoutMs: 90_000,
    label: `美团医药商家端（${acct.label}）`,
  });
  console.log(`🔏 签名链路就绪（${ready.waitedMs}ms）\n`);

  const result = {
    fetchedAt: new Date().toISOString(),
    account: { key: acct.key, label: acct.label },
    ctx: { acctId: ACCT, businessType: BIZ },
    panels: {},
  };

  // ════════ 0. 门店清单（后续所有单店数据都依赖真实门店 id）════════
  console.log("──── 0. 门店清单 ────");
  const storePages = [];
  let storeTotal = 0;
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    // ⚠️ 不要加 `isOpen=10` —— 那是「只看未营业」的筛选，
    //    实测加上后 136 家只剩 7 家且全是「停业中」，极易误判成"店都关了"
    const [r] = [await pageFetchAll(cdp, [
      { key: "poi", path: `/v2/shop/businessStatus/r/poiListSearch?pageNum=${pageNum}&pageSize=100` },
    ])];
    const d = r.poi?.data;
    const list = d?.dataList ?? [];
    storeTotal = d?.totalCount ?? storeTotal;
    storePages.push(...list);
    if (list.length === 0 || storePages.length >= storeTotal) break;
  }
  const dup = new Set(storePages.map((s) => s.id)).size;
  console.log(`   门店总数 totalCount=${storeTotal}，取回 ${storePages.length} 条，去重后 ${dup} 家`);
  if (storePages.length !== dup) console.log(`   ⚠️ 分页有重叠（${storePages.length - dup} 条重复），已去重`);
  const seen = new Set();
  const stores = storePages
    .filter((s) => s.id != null && !seen.has(s.id) && seen.add(s.id))
    .map((s) => ({
      id: s.id,
      name: s.poiName,
      city: s.city,
      status: s.businessDesc,
      restReason: s.restReason,
      raw: s,
    }));
  const statusDist = {};
  for (const s of stores) statusDist[s.status ?? "(空)"] = (statusDist[s.status ?? "(空)"] ?? 0) + 1;
  console.log(`   去重后 ${stores.length} 家  营业状态分布: ${JSON.stringify(statusDist)}`);
  result.stores = stores;
  result.storeStatusDist = statusDist;

  // ════════ 1. 经营总览 ════════
  console.log("\n──── 1. 经营总览 ────");
  const p1 = await pageFetchAll(cdp, [
    { key: "core", path: `/api/page/bizdata/manageHome/multi/o/core?${home(TODAY, TODAY)}` },
    { key: "realTimeChart", path: `/api/page/bizdata/manageHome/multi/o/realTimeChart?${home(TODAY, TODAY)}` },
    { key: "comprehensive", path: `/api/page/bizdata/manageHome/multi/o/comprehensive?businessType=${BIZ}&storeType=2` },
    { key: "data_legacy", path: `/api/page/bizdata/manageHome/multi/o/data?pageItemCode=PITEM101` },
    { key: "latestTime", path: `/api/page/bizdata/manageHome/latestTime?dateType=realTime` },
    { key: "headPoi", path: `/v2/sc/index/r/analysis/headPoi?pageItemCode=PITEM102` },
  ]);
  result.panels.overview = p1;

  // ════════ 2. 商品排行 ════════
  // body 由嗅探真实页面请求得到（见 _recon/raw/bodies.json），别自己猜字段名
  console.log("──── 2. 商品排行 ────");
  const prodBase = { cityId: "", labelId: "", startDate: Y1.ymd, endDate: Y1.ymd, dateType: "dt" };
  const p2 = await pageFetchAll(cdp, [
    {
      key: "diagnosisOverview",
      method: "POST",
      path: "/api/page/bizdata/o2o/productAnalysis/diagnosis/overview",
      json: { ...prodBase, upcListIdList: [], benchmark: "1", moduleType: "businessProblem" },
    },
    {
      key: "lowSoldDetail",
      method: "POST",
      path: "/api/page/bizdata/o2o/productAnalysis/diagnosis/lowSoldDetail",
      json: { ...prodBase, pageNum: 1, pageSize: 20, sortField: "", order: "", skuNameUpc: "", upcListIdList: [], benchmark: "1" },
    },
    {
      key: "categoryRank",
      method: "POST",
      path: "/api/page/bizdata/o2o/productAnalysis/rank/poiCategoryList",
      json: { startDate: Y1.ymd, endDate: Y1.ymd, dateType: "dt" },
    },
    {
      key: "poiListV2",
      method: "POST",
      path: "/api/merchant/bizdata/o2o/productAnalysis/common/poiListV2",
      json: { labelId: "", onlinePoiFlag: 1 },
    },
    { key: "upcSearch", method: "POST", json: {}, path: "/api/page/bizdata/upcList/search" },
  ]);
  result.panels.product = p2;

  // ════════ 3. 配送与履约（服务分析 · 退款口径）════════
  console.log("──── 3. 配送与履约（退款/申诉）────");
  const s = svc(Y1, Y1, Y2, Y2, 2);
  const p3 = await pageFetchAll(cdp, [
    { key: "refundOverview", path: `/api/page/bizdata/serviceAnalysis/chain/refund/overview?${s}` },
    { key: "refundTrend", path: `/api/page/bizdata/serviceAnalysis/chain/refund/trend?${s}` },
    { key: "refundSkuTop", path: `/api/page/bizdata/serviceAnalysis/chain/refund/skuTop?${s}&orderSource=` },
    { key: "appealReasonTop", path: `/api/page/bizdata/serviceAnalysis/chain/refund/appealReasonTop?${s}&orderSource=` },
    { key: "poiDetailList", path: `/api/page/bizdata/serviceAnalysis/chain/poiInfo/detailList?poiIds=&pageNum=1&pageSize=20&cityId=&beginTime=${Y1.ymd}&endTime=${Y1.ymd}&compareBeginTime=${Y2.ymd}&compareEndTime=${Y2.ymd}` },
  ]);
  result.panels.service = p3;

  // ════════ 4. 评价与评分 ════════
  console.log("──── 4. 评价与评分 ────");
  const p4 = await pageFetchAll(cdp, [
    {
      key: "comments",
      method: "POST",
      path: "/api/support/customer/comment/r/list",
      form: {
        acctId: ACCT, wmPoiId: "-1", appType: "3", token: TOKEN, pageNum: "1",
        rate: "0", reply: "0", context: "-1",
        startDate: D30.iso, endDate: Y1.iso, timeType: "1", commentKeyWord: "",
      },
    },
    { key: "kfgrade", path: `/im/manage/b/v1/kfgrade/show?acctId=${ACCT}&source=0&wmPoiId=-1` },
    { key: "customerOverview", path: `/api/page/bizdata/recoanalysis/customerAnalysisV4/aggregation/overview?poiIds=&recentDays=1&beginTime=${Y1.ymd}&endTime=${Y1.ymd}&labelId=&labelName=&wmPoiId=-1&acctId=${ACCT}&source=0` },
    { key: "customerTrend", path: `/api/page/bizdata/recoanalysis/customerAnalysisV4/aggregation/trend?poiIds=&recentDays=${DAYS}&beginTime=${D7.ymd}&endTime=${Y1.ymd}&labelId=&labelName=&wmPoiId=-1&acctId=${ACCT}&source=0` },
  ]);
  result.panels.review = p4;

  // ════════ 5. 营销与推广 ════════
  console.log("──── 5. 营销与推广 ────");
  const p5 = await pageFetchAll(cdp, [
    { key: "activityList", path: `/api/health/activity/apply/b/activity/list` },
    { key: "recentOverview", path: `/api/health/activity/apply/b/activity/apply/lst/recent/act/overview` },
    { key: "noStartCount", path: `/api/health/rebate/merchant/activity/no-start/count` },
    { key: "adCoupon", path: `/v2/sc/index/weight/r/adCoupon` },
    { key: "membershipStats", path: `/api/health/activity/b/membership/data/statistics?tenantId=5760&brandId=100116977&queryType=3&startDate=${D30.ymd}&endDate=${Y1.ymd}` },
    {
      key: "lowPriceSkuList",
      method: "POST",
      path: "/api/health/activity/apply/b/activity/apply/lst/sku/list",
      json: { filterType: 0, sortField: 50, sortType: 2, rejCode: 1500, favoriteList: [1, 0], medicineTypeList: [], pageNo: 1, pageSize: 20 },
    },
  ]);
  result.panels.marketing = p5;

  // ════════ 6. 待办 / 风险 ════════
  console.log("──── 6. 待办与风险 ────");
  const ITEMS = [
    "noReplyToBadComment", "qualificationExpired", "chronicDiseasesHotSellingGood",
    "seasonalBestseller", "lowPriceSubsidyActivity", "unsubsidizedGoods",
    "upcomingExpiringActivity", "pendingPriceAdjustmentGoods", "pendingOptimizationGoods",
    "unreadViolation",
  ];
  const p6 = await pageFetchAll(cdp, [
    { key: "homeIndex", path: `/health/center/merchant/home/index?pageItemCode=PITEM2&acctId=${ACCT}&businessType=${BIZ}&poiId=-1&items=${ITEMS.join(",")}` },
    { key: "taskStatistics", path: `/api/health/center/task/statistics` },
    { key: "orderCounts", path: `/v2/sc/index/r/order?acctId=${ACCT}&businessType=${BIZ}&poiId=-1` },
    { key: "exposureRank", path: `/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2?acctId=${ACCT}&wmPoiId=-1&beginTime=${Y1.short}&endTime=${Y1.short}&recentDays=1&cityIds=0&source=0&type=2` },
  ]);
  result.panels.todo = p6;

  // ════════ 汇总 ════════
  console.log("\n════ 取数结果汇总 ════");
  for (const [panel, items] of Object.entries(result.panels)) {
    for (const [k, v] of Object.entries(items)) {
      const d = v.data;
      const shape = Array.isArray(d)
        ? `[${d.length}]`
        : d && typeof d === "object"
          ? `keys=${JSON.stringify(Object.keys(d).slice(0, 12))}`
          : JSON.stringify(d)?.slice(0, 60);
      const icon = v.status === 200 && v.code === 0 ? "✅" : v.status === 200 ? "🟡" : "⛔";
      console.log(`${icon} ${panel}.${k.padEnd(20)} [${v.status}] code=${v.code} ${shape ?? ""}`);
    }
  }

  await mkdir("data/raw", { recursive: true });
  await writeFile(OUT, JSON.stringify(result, null, 2));
  console.log(`\n已落盘 ${OUT.replace(process.cwd() + "\\", "")}（${(JSON.stringify(result).length / 1024).toFixed(0)} KB）`);

  await cdp.close();
}

await main();
