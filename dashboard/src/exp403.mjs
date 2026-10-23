/**
 * 对照实验：403 到底是「缺参数」还是「缺签名(mtgsig/WAF)」。
 *   node src/exp403.mjs
 *
 * 设计要点（来自方法论底座的「先做最小可用请求的对照实验」）：
 *   - 用**已知成功**的 /v2/sc/index/r/order 做基准：去掉参数是否也变 403？
 *     → 若变 403，说明是「参数触发的网关规则」，不是签名。
 *   - 给失败接口**补齐** acctId/wmPoiId 等参数，看是否转 200。
 *   - 最后才试合成 mtgsig（成本最高的假设放最后）。
 */
import { loadCookieHeader, cookieValue } from "./lib/cookie.mjs";

const HOST = "https://yiyao.meituan.com";
const COOKIE = loadCookieHeader("meituan");
const ACCT = cookieValue(COOKIE, "acctId");
const POI = cookieValue(COOKIE, "wmPoiId");

const H = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  Referer: `${HOST}/main/frame`,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Cookie: COOKIE,
};

async function t(label, path) {
  const r = await fetch(HOST + path, { headers: H, redirect: "manual" });
  const text = await r.text();
  const isWaf = text.includes("openresty");
  let note = "";
  if (r.status === 200) {
    try {
      const j = JSON.parse(text);
      const d = j.data;
      note =
        `code=${j.code} ` +
        (d && typeof d === "object" && !Array.isArray(d)
          ? `data keys=${JSON.stringify(Object.keys(d).slice(0, 12))}`
          : Array.isArray(d)
            ? `data[${d.length}]`
            : "");
    } catch {
      note = text.slice(0, 80).replace(/\s+/g, " ");
    }
  } else {
    note = isWaf ? "openresty WAF" : text.slice(0, 100).replace(/\s+/g, " ");
  }
  const icon = r.status === 200 ? "✅" : r.status === 403 ? "⛔" : "⚠️ ";
  console.log(`${icon} [${r.status}] ${label}\n      ${note}`);
}

console.log("──── A. 基准：已知成功的 order，参数有无对比 ────");
await t("order 带全参（基准）", `/v2/sc/index/r/order?acctId=${ACCT}&businessType=1&poiId=${POI}`);
await t("order 完全无参", `/v2/sc/index/r/order`);
await t("order 只带 acctId", `/v2/sc/index/r/order?acctId=${ACCT}`);

console.log("\n──── B. 失败接口：补齐参数 ────");
await t("poiInfo/get 无参（复现）", `/v2/sc/index/r/poiInfo/get`);
await t("poiInfo/get 补参", `/v2/sc/index/r/poiInfo/get?acctId=${ACCT}&wmPoiId=${POI}&poiId=${POI}`);
await t("poiListSearch 补参", `/v2/shop/businessStatus/r/poiListSearch?acctId=${ACCT}&wmPoiId=${POI}&pageNum=1&pageSize=10`);
await t(
  "manageHome multi 补参",
  `/api/page/bizdata/manageHome/multi/o/data?pageItemCode=PITEM101&acctId=${ACCT}&wmPoiId=${POI}`,
);
await t(
  "manageHome single 补参",
  `/api/page/bizdata/manageHome/single/o/data?pageItemCode=PITEM101&acctId=${ACCT}&wmPoiId=${POI}&businessType=1`,
);
await t(
  "home/index 补参",
  `/health/center/merchant/home/index?acctId=${ACCT}&businessType=1&poiId=${POI}&items=noReplyToBadComment`,
);

console.log("\n──── C. 合成 mtgsig（最后才试）────");
const sig = encodeURIComponent(JSON.stringify({ a1: "1.2", a2: Date.now(), a5: "1" }));
await t(
  "order 带合成 mtgsig（若仍 200 说明不校验）",
  `/v2/sc/index/r/order?acctId=${ACCT}&businessType=1&poiId=${POI}&mtgsig=${sig}`,
);
await t(
  "manageHome 带合成 mtgsig",
  `/api/page/bizdata/manageHome/multi/o/data?pageItemCode=PITEM101&mtgsig=${sig}`,
);
const badSig = encodeURIComponent(JSON.stringify({ a1: "1.2", a2: Date.now(), a5: "999999" }));
await t(
  "order 带畸形 mtgsig",
  `/v2/sc/index/r/order?acctId=${ACCT}&businessType=1&poiId=${POI}&mtgsig=${badSig}`,
);

console.log("\n──── D. Referer / Origin 变化 ────");
for (const ref of [`${HOST}/`, `${HOST}/main/frame`, `${HOST}/page/home`]) {
  const r = await fetch(HOST + `/api/page/bizdata/manageHome/multi/o/data?pageItemCode=PITEM101`, {
    headers: { ...H, Referer: ref, Origin: HOST },
    redirect: "manual",
  });
  await r.text();
  console.log(`   Referer=${ref.padEnd(42)} → ${r.status}`);
}
