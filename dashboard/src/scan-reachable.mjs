/**
 * 无签名可达性扫描：把侦察到的接口逐一探一遍，分出「直连可用」与「需页面签名」。
 *   node src/scan-reachable.mjs
 *
 * 目的：把能在沙箱内直接取到的数据最大化，缩小必须借 Chrome 签名的范围。
 * 只读，不写业务数据；全量响应落到 _recon/raw/ 便于定字段。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieHeader, cookieValue } from "./lib/cookie.mjs";

const HOST = "https://yiyao.meituan.com";
const COOKIE = loadCookieHeader("meituan");
const ACCT = cookieValue(COOKIE, "acctId");
const POI = cookieValue(COOKIE, "wmPoiId");
const TOKEN = cookieValue(COOKIE, "token");

const H = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  Referer: `${HOST}/main/frame`,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Cookie: COOKIE,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 昨天 / 近 7 天 / 近 30 天，以及 YYMMDD 变体
const d = (offset) => {
  const t = new Date(Date.now() + offset * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    iso: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`,
    ymd: `${p(t.getFullYear() % 100)}${p(t.getMonth() + 1)}${p(t.getDate())}`,
  };
};
const Y1 = d(-1), D7 = d(-7), D30 = d(-30);

/** 候选接口：来自前端包扫描 + 方法论底座里记录的美团医药路由 */
const CANDIDATES = [
  // ——— 已验证可用 ———
  { k: "order", path: `/v2/sc/index/r/order?acctId=${ACCT}&businessType=1&poiId=${POI}` },
  {
    k: "comment_list",
    method: "POST",
    path: `/api/support/customer/comment/r/list`,
    form: {
      acctId: ACCT, wmPoiId: POI, appType: "3", token: TOKEN, pageNum: "1",
      rate: "0", reply: "0", context: "-1",
      startDate: D30.iso, endDate: Y1.iso, timeType: "1", commentKeyWord: "",
    },
  },
  {
    k: "exposure_rank",
    path: `/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2?acctId=${ACCT}&wmPoiId=${POI}&beginTime=${Y1.ymd}&endTime=${Y1.ymd}&recentDays=1&cityIds=0&source=0&type=2`,
  },
  // ——— 方法论底座记录的其它美团医药路由（试探是否同样受限）———
  { k: "order_history", path: `/unified/r/order/list/page/history?pageNum=1&pageSize=10` },
  { k: "order_history_2", path: `/unified/r/order/list/page/history?acctId=${ACCT}&wmPoiId=${POI}&pageNum=1&pageSize=10` },
  { k: "order_detail_info", path: `/order/detail/info?wmPoiId=${POI}&orderId=0` },
  { k: "today_statistics", path: `/v2/common/statistics/r/today/data?acctId=${ACCT}&wmPoiId=${POI}` },
  { k: "today_statistics_2", path: `/v2/common/statistics/r/today/data` },
  // ——— 前端包里的其余路由，确认是否全部需要签名 ———
  { k: "poiInfo_get", path: `/v2/sc/index/r/poiInfo/get?acctId=${ACCT}&wmPoiId=${POI}` },
  { k: "analysis_headPoi", path: `/v2/sc/index/r/analysis/headPoi?pageItemCode=PITEM102` },
  { k: "poiListSearch", path: `/v2/shop/businessStatus/r/poiListSearch?acctId=${ACCT}&wmPoiId=${POI}&pageNum=1&pageSize=20` },
  { k: "manageHome_single_o", path: `/api/page/bizdata/manageHome/single/o/data?pageItemCode=PITEM101` },
  { k: "manageHome_multi_o", path: `/api/page/bizdata/manageHome/multi/o/data?pageItemCode=PITEM101` },
  { k: "latestTime", path: `/api/page/bizdata/manageHome/latestTime?dateType=realTime` },
  { k: "home_index", path: `/health/center/merchant/home/index?acctId=${ACCT}&businessType=1&poiId=${POI}&items=noReplyToBadComment` },
  { k: "business_card", path: `/health/pc/home/merchant-business-card?acctId=${ACCT}&businessType=1&poiId=${POI}` },
  { k: "pending_items", path: `/health/pc/home/pending-items?acctId=${ACCT}&businessType=1&poiId=${POI}&items=noReplyToBadComment` },
  { k: "flowAnalysis_single", path: `/api/page/recoanalysis/flowAnalysisV4/single/recentDays?acctId=${ACCT}&wmPoiId=${POI}&beginTime=${D7.ymd}&endTime=${Y1.ymd}&recentDays=7&cityIds=0&source=0&type=2` },
  { k: "adCoupon", path: `/v2/sc/index/weight/r/adCoupon?acctId=${ACCT}&wmPoiId=${POI}` },
  { k: "businessQualification", path: `/v2/shop/manage/businessQualification?acctId=${ACCT}&wmPoiId=${POI}` },
  { k: "marketing_invite", path: `/health/api/sg/promotion/invite/centerList?acctId=${ACCT}&wmPoiId=${POI}` },
];

await mkdir("_recon/raw", { recursive: true });

const ok = [], blocked = [], other = [];
const rawAll = {};

for (const c of CANDIDATES) {
  const init = { headers: { ...H } };
  if (c.method === "POST") {
    init.method = "POST";
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(c.form).toString();
  }
  let status = 0, text = "";
  try {
    const r = await fetch(HOST + c.path, { ...init, redirect: "manual" });
    status = r.status;
    text = await r.text();
  } catch (e) {
    text = String(e.message);
  }

  let summary;
  if (status === 200) {
    try {
      const j = JSON.parse(text);
      rawAll[c.k] = { path: c.path, code: j.code, data: j.data };
      const dd = j.data;
      summary = Array.isArray(dd)
        ? `data[${dd.length}] keys=${JSON.stringify(Object.keys(dd[0] ?? {}).slice(0, 14))}`
        : dd && typeof dd === "object"
          ? `data keys=${JSON.stringify(Object.keys(dd).slice(0, 20))}`
          : `data=${JSON.stringify(dd)?.slice(0, 80)}`;
      ok.push(c.k);
    } catch {
      summary = `非 JSON：${text.slice(0, 80).replace(/\s+/g, " ")}`;
      other.push(c.k);
    }
  } else if (status === 403 && text.includes("openresty")) {
    summary = "openresty WAF（需页面签名）";
    blocked.push(c.k);
  } else {
    summary = `HTTP ${status} ${text.slice(0, 70).replace(/\s+/g, " ")}`;
    other.push(c.k);
  }
  const icon = status === 200 ? "✅" : status === 403 ? "⛔" : "⚠️ ";
  console.log(`${icon} [${String(status).padStart(3)}] ${c.k.padEnd(22)} ${summary}`);
  await sleep(350); // 别把风控惹毛
}

await writeFile("_recon/raw/reachable-200.json", JSON.stringify(rawAll, null, 2));

console.log("\n════ 汇总 ════");
console.log(`✅ 无签名直连可用 ${ok.length} 个：${ok.join(", ")}`);
console.log(`⛔ 需页面签名    ${blocked.length} 个：${blocked.join(", ")}`);
if (other.length) console.log(`⚠️  其它状态      ${other.length} 个：${other.join(", ")}`);
console.log(`\n全量响应已落盘：_recon/raw/reachable-200.json`);
