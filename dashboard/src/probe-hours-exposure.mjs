/**
 * 探测：① 订单列表里有没有「下单时间」（用于「近1小时取消单」）
 *       ② 美团经营分析的曝光接口怎么取（用于「大盘曝光变化」）
 *   node src/probe-hours-exposure.mjs [--account=quanyi|yifeng]
 *
 * 背景：经营者的四项焦点指标里，
 *   - 「取消单在今天 / 近1小时 / 近1周的变化」→ 今天和近1周已从 income-*.json 拿到，
 *     **近1小时**必须靠逐单时间戳，而 income 脚本当初没留时间字段。
 *   - 「大盘曝光变化」→ 需要曝光接口，此前 exposureRank 返回 null。
 */
import { connectToPage, evaluate, pageFetchAll } from "./lib/cdp.mjs";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;
const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;

const iso = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};
/** 曝光接口用的短日期 YYMMDD */
const short = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(t.getFullYear() % 100)}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};

const cdp = await connectToPage(PORT);
console.log(`账号 ${acct.label}  端口 ${PORT}`);
const ACCT_ID = parseCookieString(loadCookieHeader(STEM)).cookies.acctId;
const BIZ = parseCookieString(loadCookieHeader(STEM)).cookies.account_businesstype ?? "1";

await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await new Promise((r) => setTimeout(r, 9000));

// ───── ① 今天订单的 commonInfo / orderInfo 全字段 ─────
console.log(`\n════ ① 订单字段（${iso(0)}）════`);
const raw = await evaluate(
  cdp,
  `(async () => {
     const body = new URLSearchParams({
       tag:'history_all',
       pageParam: JSON.stringify({pageSize:5,pageNum:1,sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
       extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
       startDate:'${iso(0)}', endDate:'${iso(0)}',
     });
     const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
     return await r.text();
   })()`,
);
const j = JSON.parse(raw);
const list = j.data?.orderList ?? [];
console.log(`返回 ${list.length} 单；pageInfo=${JSON.stringify(j.data?.pageInfo)}`);

const ci = list[0] ? JSON.parse(list[0].commonInfo ?? "{}") : {};
console.log(`\ncommonInfo 键（${Object.keys(ci).length} 个）：`);
for (const [k, v] of Object.entries(ci)) {
  const sv = JSON.stringify(v);
  console.log(`   ${k.padEnd(34)} ${sv && sv.length > 70 ? sv.slice(0, 70) + "…" : sv}`);
}
/** 时间类字段 */
console.log(`\n疑似时间字段：`);
for (const [k, v] of Object.entries(ci)) {
  if (/time|date|Time|Date/i.test(k)) console.log(`   ${k} = ${JSON.stringify(v)}  → ${new Date(Number(v)).toISOString?.() ?? ""}`);
}
/** 订单状态分布 */
const st = {};
for (const x of list) {
  const c = JSON.parse(x.commonInfo ?? "{}");
  st[c.orderStatus] = (st[c.orderStatus] ?? 0) + 1;
}
console.log(`\n本页订单状态分布：${JSON.stringify(st)}`);

// ───── ② 曝光接口 ─────
console.log(`\n════ ② 曝光 / 流量接口 ════`);
const specs = [
  { key: "flowOverview", path: `/api/page/bizdata/recoanalysis/flowAnalysisV4/aggregation/overview?poiIds=&recentDays=1&beginTime=${short(-1)}&endTime=${short(-1)}&labelId=&labelName=&wmPoiId=-1&acctId=${ACCT_ID}&source=0` },
  { key: "flowOverviewToday", path: `/api/page/bizdata/recoanalysis/flowAnalysisV4/aggregation/overview?poiIds=&recentDays=1&beginTime=${short(0)}&endTime=${short(0)}&labelId=&labelName=&wmPoiId=-1&acctId=${ACCT_ID}&source=0` },
  { key: "flowTrend7", path: `/api/page/bizdata/recoanalysis/flowAnalysisV4/aggregation/trend?poiIds=&recentDays=7&beginTime=${short(-7)}&endTime=${short(-1)}&labelId=&labelName=&wmPoiId=-1&acctId=${ACCT_ID}&source=0` },
  { key: "exposureRank7", path: `/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2?acctId=${ACCT_ID}&wmPoiId=-1&beginTime=${short(-7)}&endTime=${short(-1)}&recentDays=7&cityIds=0&source=0&type=2` },
  { key: "exposureRank1", path: `/api/page/recoanalysis/flowAnalysisV4/single/recentDays/flowPoiExposureRankingV2?acctId=${ACCT_ID}&wmPoiId=-1&beginTime=${short(-1)}&endTime=${short(-1)}&recentDays=1&cityIds=0&source=0&type=2` },
];
const res = await pageFetchAll(cdp, specs);
for (const [k, v] of Object.entries(res)) {
  const d = v.data;
  const shape = Array.isArray(d) ? `[${d.length}]` : d && typeof d === "object" ? `keys=${JSON.stringify(Object.keys(d).slice(0, 14))}` : JSON.stringify(d);
  console.log(`  ${k.padEnd(20)} [${v.status}] code=${v.code} ${shape ?? ""}`);
  if (d && typeof d === "object" && !Array.isArray(d)) {
    console.log(`      ${JSON.stringify(d).slice(0, 700)}`);
  } else if (Array.isArray(d) && d.length) {
    console.log(`      [0] ${JSON.stringify(d[0]).slice(0, 400)}`);
  }
}

await cdp.close();
