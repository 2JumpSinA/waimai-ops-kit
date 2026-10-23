/**
 * 接口探针 —— 验证 cookie 是否可用、接口是否需要签名、响应结构是什么。
 *   node src/probe.mjs
 *
 * 只读，不写任何数据文件。输出全部截断，避免把大响应灌进终端。
 */
import { loadCookieHeader, cookieValue } from "./lib/cookie.mjs";

const HOST = "https://yiyao.meituan.com";
const COOKIE = loadCookieHeader("meituan");

const ACCT = cookieValue(COOKIE, "acctId");
const POI = cookieValue(COOKIE, "wmPoiId");
const BIZ = cookieValue(COOKIE, "account_businesstype");
console.log(`[ctx] acctId=${ACCT} wmPoiId=${POI} account_businesstype=${BIZ}\n`);

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  Referer: `${HOST}/main/frame`,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Cookie: COOKIE,
};

function brief(body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return body.slice(0, 300).replace(/\s+/g, " ");
  }
  const top = Object.keys(j);
  const code = j.code ?? j.status ?? j.ret;
  const data = j.data ?? j.result;
  let shape = "";
  if (data && typeof data === "object") {
    shape = Array.isArray(data)
      ? `data[${data.length}] keys=${JSON.stringify(Object.keys(data[0] ?? {}).slice(0, 25))}`
      : `data keys=${JSON.stringify(Object.keys(data).slice(0, 30))}`;
  }
  return `code=${JSON.stringify(code)} top=${JSON.stringify(top)} ${shape}`;
}

async function probe(label, path, { method = "GET", body, headers = {} } = {}) {
  const url = path.startsWith("http") ? path : HOST + path;
  try {
    const r = await fetch(url, {
      method,
      headers: { ...BASE_HEADERS, ...headers },
      body,
      redirect: "manual",
    });
    const text = await r.text();
    const flag = r.status === 200 ? "✅" : r.status === 403 ? "⛔" : "⚠️ ";
    console.log(`${flag} [${r.status}] ${label}`);
    console.log(`    ${path.slice(0, 120)}`);
    console.log(`    ${brief(text)}\n`);
    return { status: r.status, text };
  } catch (e) {
    console.log(`💥 ${label}\n    ${e.message}\n`);
    return { status: 0, text: "" };
  }
}

console.log("════ 1. 经营总览（多店 o2o）════");
await probe("multi/o/data", `/api/page/bizdata/manageHome/multi/o/data?pageItemCode=PITEM101`);
await probe("single/o/data", `/api/page/bizdata/manageHome/single/o/data?pageItemCode=PITEM101`);
await probe("latestTime", `/api/page/bizdata/manageHome/latestTime?dateType=realTime`);

console.log("════ 2. 订单 / 门店 ════");
await probe("order", `/v2/sc/index/r/order?acctId=${ACCT}&businessType=1&poiId=${POI}`);
await probe("poiInfo/get", `/v2/sc/index/r/poiInfo/get`);
await probe("analysis/headPoi", `/v2/sc/index/r/analysis/headPoi?pageItemCode=PITEM102`);
await probe("poiListSearch", `/v2/shop/businessStatus/r/poiListSearch`);

console.log("════ 3. 评价（POST 表单）════");
const form = new URLSearchParams({
  acctId: ACCT,
  wmPoiId: POI,
  appType: "3",
  token: cookieValue(COOKIE, "token") ?? "",
  pageNum: "1",
  rate: "0",
  reply: "0",
  context: "-1",
  startDate: "2026-08-17",
  endDate: "2026-09-16",
  timeType: "1",
  commentKeyWord: "",
});
await probe("comment/r/list", `/api/support/customer/comment/r/list`, {
  method: "POST",
  body: form,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
});

console.log("════ 4. 曝光排行 ════");
await probe(
  "flowPoiExposureRankingV2",
  `/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2` +
    `?acctId=${ACCT}&wmPoiId=${POI}&beginTime=260916&endTime=260916&recentDays=1&cityIds=0&source=0&type=2`,
);

console.log("════ 5. 待办 ════");
await probe(
  "merchant home index",
  `/health/center/merchant/home/index?acctId=${ACCT}&businessType=1&poiId=${POI}` +
    `&items=noReplyToBadComment,qualificationExpired,unsubsidizedGoods,pendingPriceAdjustmentGoods,unreadViolation`,
);
