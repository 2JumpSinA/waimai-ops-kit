/**
 * 口径标定 ③：门店明细求和 vs 大盘 KPI（自洽性校验）+ 高取消门店排行。
 *   node src/calibrate3.mjs
 *
 * 校验逻辑：若门店级窗口与大盘窗口一致，则 Σ门店 order_cnt 应 ≈ 大盘 904。
 * 不一致就说明窗口不同 —— 这比事后发现数字对不上便宜得多。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { cookies } = parseCookieString(loadCookieHeader("taobao"));
const d = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};
const node = await mtopCall({ api: "mtop.ele.newretail.ebai.MultiLevelMtopService.getLoginnode", data: {}, cookies });
const login = (node.data?.data ?? node.data)?.loginNodeInfo ?? {};
const ID = String(login.nodeId), ROLE = String(login.nodeType);
const API = "mtop.me.ele.newretail.data.analysis.proteinQueryForArea";

async function call(code, params) {
  const data = {
    context: JSON.stringify({ appName: "kbtdatacenter", userName: ROLE, userId: ID }),
    request: JSON.stringify({ proteinCode: code, withTracker: true, parameters: { id: ID, role: ROLE, ...params } }),
  };
  const r = await mtopCall({ api: API, data, cookies, host: "nrshop.ele.me", jsv: "2.7.0" });
  if (!r.ok) return { error: r.ret };
  const dd = r.data?.data;
  return { result: dd?.result, parameters: dd?.parameters };
}

const Y1 = d(-1);
const n = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));

// ── 大盘 KPI ──
const kpi = await call("SC8LRHx", { begin_day: Y1, end_day: Y1, prd_type: "week", date_type: "近7日", ds: Y1 });
const K = kpi.result?.records?.[0] ?? {};
console.log("═══ 大盘 KPI（近7日）═══");
console.log(`  窗口参数: ds=${Y1} prd_type=week date_type=近7日`);
console.log(`  总成交额 ${K.order_total_amt}  有效订单 ${K.order_cnt}  流失订单 ${K.invalid_order_cnt}`);
console.log(`  流失金额 ${K.invalid_order_amt}`);

// ── 门店明细：按不同窗口各拉一次，看哪个能对上 ──
console.log("\n═══ 门店明细 · 窗口对齐实验 ═══");
const WINDOWS = [
  ["begin=end=ds(页面法)", Y1, Y1],
  ["begin=ds-6", d(-6), Y1],
  ["begin=ds-7", d(-7), Y1],
];
for (const [label, begin, end] of WINDOWS) {
  const r = await call("SEn1HKG", { begin_day: begin, end_day: end, prd_type: "week", date_type: "近7日", ds: Y1, pageSize: "500", pageNum: "1" });
  const recs = r.result?.records ?? [];
  const sumCnt = recs.reduce((s, x) => s + n(x.order_cnt), 0);
  const sumAmt = recs.reduce((s, x) => s + n(x.order_total_amt), 0);
  const sumInv = recs.reduce((s, x) => s + n(x.invalid_order_cnt), 0);
  const range = recs[0]?.date_range ?? "?";
  const okCnt = Math.abs(sumCnt - n(K.order_cnt)) <= 2;
  const okAmt = Math.abs(sumAmt - n(K.order_total_amt)) <= 5;
  console.log(`\n  ▸ ${label}  (${begin} ~ ${end})`);
  console.log(`     门店数 ${recs.length}  date_range=${range}`);
  console.log(`     Σ订单 ${sumCnt} ${okCnt ? "✅" : "❌"} 大盘 ${K.order_cnt}    Σ成交额 ${sumAmt.toFixed(2)} ${okAmt ? "✅" : "❌"} 大盘 ${K.order_total_amt}`);
  console.log(`     Σ流失单 ${sumInv}   大盘 ${K.invalid_order_cnt}`);
}

// ── 用能对上的窗口排高取消门店 ──
const best = await call("SEn1HKG", { begin_day: d(-6), end_day: Y1, prd_type: "week", date_type: "近7日", ds: Y1, pageSize: "500", pageNum: "1" });
const stores = (best.result?.records ?? []).map((x) => ({
  name: x.shop_name, id: x.shop_id, city: x.city_name, supplier: x.supplier_name,
  orders: n(x.order_cnt), invalid: n(x.invalid_order_cnt),
  rate: n(x.order_cnt) ? n(x.invalid_order_cnt) / n(x.order_cnt) : 0,
  amt: n(x.order_total_amt), invalidAmt: n(x.invalid_order_amt),
  u: n(x.invalid_order_cnt_user), del: n(x.invalid_order_cnt_del),
  shop: n(x.invalid_order_cnt_shop), oth: n(x.invalid_order_cnt_oth),
  range: x.date_range,
}));

console.log(`\n═══ 高取消单占比门店（${stores.length} 家，窗口 ${stores[0]?.range ?? "?"}）═══`);
/** 底座文档：小样本量门槛，避免 1 单 100% 的噪音 */
const MIN_ORDERS = 10;
const ranked = stores.filter((s) => s.orders >= MIN_ORDERS).sort((a, b) => b.rate - a.rate);
console.log(`  样本门槛：订单数 ≥ ${MIN_ORDERS}（低于此不计，避免小样本噪音）`);
console.log(`  共 ${ranked.length} 家入选\n`);
console.log("  取消占比  门店 / 城市                          订单  流失  (用户/配送/商家/其他)");
for (const s of ranked.slice(0, 15)) {
  console.log(
    `  ${(s.rate * 100).toFixed(1).padStart(5)}%   ${s.name.slice(0, 26).padEnd(28)} ${String(s.orders).padStart(4)}  ${String(s.invalid).padStart(3)}   (${s.u}/${s.del}/${s.shop}/${s.oth})`,
  );
}
const zero = stores.filter((s) => s.orders >= MIN_ORDERS && s.invalid === 0).length;
console.log(`\n  零流失门店: ${zero} 家 / 入选 ${ranked.length} 家`);

await mkdir(join(ROOT, "data", "raw"), { recursive: true });
await writeFile(join(ROOT, "data", "raw", "taobao-stores-detail.json"), JSON.stringify({ kpi: K, window: stores[0]?.range, stores }, null, 2), "utf8");
console.log(`\n落盘 data/raw/taobao-stores-detail.json`);
