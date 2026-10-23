/**
 * 探测：大盘曝光到底从哪取。
 *   node src/probe-exposure.mjs [--account=quanyi|yifeng]
 *
 * 已知（从 main bundle index-*.js 抠出来的真实调用）：
 *   GET /api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2
 *       ?acctId=<id>&beginTime=<YYMMDD>&endTime=<YYMMDD>&recentDays=1&wmPoiId=<poiId>&cityIds=0&source=0&type=2
 *   ⚠️ 页面里它包在 `if (mode === "single-o2o")` 里，且 wmPoiId 传的是**具体门店**。
 *   我用 wmPoiId=-1 试过 → code=0 但 data=null，所以要试真实 poiId。
 *
 * 另外试 manageHome/multi/o/data 的其它 pageItemCode（PITEM101 已知可用，可能还有流量卡片）。
 */
import { connectToPage, pageFetchAll } from "./lib/cdp.mjs";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { resolveAccount, readData } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;
const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;

const short = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(t.getFullYear() % 100)}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};

const cdp = await connectToPage(PORT);
console.log(`账号 ${acct.label}  端口 ${PORT}`);
const COOKIE = loadCookieHeader(STEM);
const ACCT_ID = parseCookieString(COOKIE).cookies.acctId;
const BIZ = parseCookieString(COOKIE).cookies.account_businesstype ?? "1";

await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await new Promise((r) => setTimeout(r, 9000));

const mt = readData(acct, "meituan");
const stores = mt?.stores ?? [];
console.log(`本账号门店 ${stores.length} 家，拿 3 个真实 poiId 试`);
const sample = stores.slice(0, 3).map((s) => s.id);
console.log(`  样本 poiId: ${sample.join(", ")}`);

const specs = [];
for (const pid of sample) {
  specs.push({
    key: `expo_poi_${pid}`,
    path: `/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2?acctId=${ACCT_ID}&beginTime=${short(-1)}&endTime=${short(-1)}&recentDays=1&wmPoiId=${pid}&cityIds=0&source=0&type=2`,
  });
}
specs.push({
  key: "expo_multi_7d",
  path: `/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2?acctId=${ACCT_ID}&beginTime=${short(-7)}&endTime=${short(-1)}&recentDays=7&wmPoiId=-1&cityIds=0&source=0&type=2`,
});
// manageHome 的其它 pageItemCode
for (const code of ["PITEM101", "PITEM102", "PITEM103", "PITEM104", "PITEM105", "PITEM3", "PITEM4", "PITEM5"]) {
  specs.push({
    key: `home_${code}`,
    path: `/api/page/bizdata/manageHome/multi/o/data?pageItemCode=${code}&businessType=${BIZ}&storeType=2`,
  });
}

const res = await pageFetchAll(cdp, specs);
for (const [k, v] of Object.entries(res)) {
  const d = v.data;
  let shape;
  if (Array.isArray(d)) shape = `[${d.length}]`;
  else if (d && typeof d === "object") shape = `keys=${JSON.stringify(Object.keys(d).slice(0, 16))}`;
  else shape = JSON.stringify(d);
  console.log(`\n  ${k}  [${v.status}] code=${v.code} ${v.msg ?? ""}`);
  console.log(`     ${shape ?? ""}`);
  if (d && typeof d === "object") {
    const s = JSON.stringify(d);
    console.log(`     ${s.length > 800 ? s.slice(0, 800) + "…" : s}`);
  }
}

await cdp.close();
