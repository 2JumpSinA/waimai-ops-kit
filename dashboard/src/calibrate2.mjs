/**
 * 口径标定 · 验证：用**页面自己的参数**复刻请求，与页面显示值对齐。
 *   node src/calibrate2.mjs
 *
 * 页面显示值（2026-09-17 抓取）：
 *   今日实时：总成交额 ¥4,018.24 · 有效订单 63 · 笔单价 ¥63.78 · 流失订单 3
 *   近7日(09-10~09-16)：总成交额 ¥55,149.59 · 有效订单 904 · 笔单价 ¥61.01
 *                        顾客实付 ¥23,418.14 · 商家补贴 ¥28,522.47 · 补贴力度 51.72%
 */
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const { cookies } = parseCookieString(loadCookieHeader("taobao"));
const d = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};
const node = await mtopCall({ api: "mtop.ele.newretail.ebai.MultiLevelMtopService.getloginnode", data: {}, cookies });
const login = (node.data?.data ?? node.data)?.loginNodeInfo ?? {};
const ID = String(login.nodeId), ROLE = String(login.nodeType);
const API = "mtop.me.ele.newretail.data.analysis.proteinQueryForArea";

async function call(code, params) {
  const data = {
    context: JSON.stringify({ appName: "kbtdatacenter", userName: ROLE, userId: ID }),
    request: JSON.stringify({ proteinCode: code, withTracker: true, parameters: { id: ID, role: ROLE, ...params } }),
  };
  const r = await mtopCall({ api: API, data, cookies, host: "nrshop.ele.me", jsv: "2.7.0" });
  return r.data?.data?.result ?? null;
}

const Y1 = d(-1);  // 页面用的 ds = 昨天
const PAGE_7D = { totalAmt: 55149.59, validOrder: 904, pct: 61.01, payAmt: 23418.14, subsidy: 28522.47, subsidyRate: 0.5172 };

console.log("═══ ① 复刻页面「近7日」参数 ═══");
console.log(`ds=end_day=begin_day=${Y1}  prd_type=week  date_type=近7日\n`);

const r1 = await call("SC8LRHx", {
  begin_day: Y1, end_day: Y1, prd_type: "week", date_type: "近7日", ds: Y1,
});
if (r1?.records?.[0] || r1?.record) {
  const rec = r1.records?.[0] ?? r1.record;
  console.log("SC8LRHx 返回：");
  for (const [k, v] of Object.entries(rec)) console.log(`   ${k} = ${v}`);

  console.log("\n── 与页面显示值比对 ──");
  const cmp = (name, api, page, tol = 0.02) => {
    if (api === undefined || api === null) return console.log(`   ${name.padEnd(18)} 接口无此字段，页面=${page}`);
    const a = Number(api), p = Number(page);
    const ok = Math.abs(a - p) <= Math.max(tol * Math.abs(p), tol);
    console.log(`   ${ok ? "✅" : "❌"} ${name.padEnd(18)} 接口=${api}  页面=${page}  ${ok ? "" : `差 ${((a / p - 1) * 100).toFixed(1)}%`}`);
  };
  cmp("总成交额", rec.order_total_amt, PAGE_7D.totalAmt);
  cmp("有效订单", rec.order_cnt, PAGE_7D.validOrder);
  cmp("笔单价", rec.avg_order_total_amt, PAGE_7D.pct);
  cmp("顾客实付金额", rec.pay_amt, PAGE_7D.payAmt);
  cmp("商家补贴", rec.shop_subsidy_amt, PAGE_7D.subsidy);
  cmp("补贴力度", rec.shop_subsidy_rate, PAGE_7D.subsidyRate);
} else {
  console.log("SC8LRHx 无记录：", JSON.stringify(r1));
}

console.log("\n═══ ② 流失订单（SCDzram）同参数 ═══");
const r2 = await call("SCDzram", { begin_day: Y1, end_day: Y1, prd_type: "week", date_type: "近7日", ds: Y1 });
console.log(JSON.stringify(r2?.records?.[0] ?? r2?.record ?? r2));

console.log("\n═══ ③ 门店明细（SEn1HKG）页面原参数 ═══");
const r3 = await call("SEn1HKG", { begin_day: d(-6), end_day: Y1, prd_type: "week", date_type: "近7日", ds: Y1, pageSize: "10" });
const recs3 = r3?.records ?? [];
console.log(`records=${recs3.length}  totalCount=${r3?.totalCount ?? r3?.total ?? "?"}`);
for (const x of recs3.slice(0, 5)) console.log("   " + JSON.stringify(x));

console.log("\n═══ ④ 今日实时（SDqJ77i）与页面比对 ═══");
const r4 = await call("SDqJ77i", { date: d(0), currHour: String(new Date().getHours()) });
console.log("接口:", JSON.stringify(r4?.record));
console.log("页面: 总成交额 ¥4,018.24 · 有效订单 63 · 笔单价 ¥63.78 · 流失订单 3");

console.log("\n═══ ⑤ 昨日同时段（页面用它做对比）」═══");
const r5 = await call("SDqJ77i", { date: Y1, currHour: String(new Date().getHours()) });
console.log("接口:", JSON.stringify(r5?.record));
console.log("页面昨日同时段: 总成交额 ¥3,703.80 · 有效订单 64 · 笔单价 ¥57.87 · 流失订单 7");
