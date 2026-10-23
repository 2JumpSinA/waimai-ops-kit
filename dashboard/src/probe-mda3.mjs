/**
 * MDA 服务号 · 参数补全后复测（覆盖用户要的四项）
 *   node src/probe-mda3.mjs
 */
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const { cookies } = parseCookieString(loadCookieHeader("taobao"));
const d = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};
const cut = (v, n = 500) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > n ? s.slice(0, n) + "…" : s;
};

const node = await mtopCall({ api: "mtop.ele.newretail.ebai.MultiLevelMtopService.getloginnode", data: {}, cookies });
const login = (node.data?.data ?? node.data)?.loginNodeInfo ?? {};
const ID = String(login.nodeId ?? ""), ROLE = String(login.nodeType ?? "");
const HOST = "nrshop.ele.me", JSV = "2.7.0";
const API = "mtop.me.ele.newretail.data.analysis.proteinQueryForArea";

async function p(label, code, params = {}) {
  const data = {
    context: JSON.stringify({ appName: "kbtdatacenter", userName: ROLE, userId: ID }),
    request: JSON.stringify({ proteinCode: code, withTracker: true, parameters: { id: ID, role: ROLE, ...params } }),
  };
  const r = await mtopCall({ api: API, data, cookies, host: HOST, jsv: JSV });
  const dd = r.data?.data, res = dd?.result;
  if (r.ok && res?.success) {
    const rec = res.record ?? {}, recs = res.records ?? [];
    console.log(`✅ ${label.padEnd(24)} ${code} type=${dd.resultType}` + (recs.length ? `  [${recs.length} 条]` : ""));
    if (Object.keys(rec).length) console.log(`     记录: ${cut(rec, 420)}`);
    if (recs.length) { console.log(`     首条: ${cut(recs[0], 420)}`); if (recs[1]) console.log(`     次条: ${cut(recs[1], 300)}`); }
    return r;
  }
  console.log(`⛔ ${label.padEnd(24)} ${code}  ${r.ok ? (res?.statusCode ?? dd?.msg ?? "?") : r.ret}`);
  if (r.ok && dd?.msg) console.log(`     msg: ${String(dd.msg).slice(0, 160)}`);
  return r;
}
const g = () => new Promise((r) => setTimeout(r, 360));

console.log("═══ ① 取消/流失 · 今日 / 近7日 / 近30日 ═══");
await p("实时(今日)", "SDqJ77i", { date: d(0), currHour: String(new Date().getHours()) });
await g();
await p("历史·近7日", "SC8LRHx", { begin_day: d(-6), end_day: d(0), prd_type: "week", date_type: "近7日" });
await g();
await p("历史·昨日", "SC8LRHx", { begin_day: d(-1), end_day: d(-1), prd_type: "day", date_type: "昨日" });
await g();
await p("流失·近7日", "SCDzram", { begin_day: d(-6), end_day: d(0), prd_type: "week", date_type: "近7日" });
await g();
await p("流失·昨日", "SCDzram", { begin_day: d(-1), end_day: d(-1), prd_type: "day", date_type: "昨日" });
await g();

console.log("\n═══ ② 分时曲线（近1小时口径）═══");
for (const f of ["gmv", "invalid_order_num", "valid_order_num"]) {
  await p(`分时 field=${f}`, "SGBk0Xz", { date: d(0), field: f, currHour: String(new Date().getHours()) });
  await g();
}

console.log("\n═══ ③ 门店明细 ═══");
await p("多门店表格 ds", "SEn1HKG", { ds: d(0), begin_day: d(-6), end_day: d(0), pageSize: 10 });
await g();
await p("历史明细", "S4tMNzj", { begin_day: d(-6), end_day: d(0), prd_type: "week", date_type: "近7日", pageSize: 10 });
await g();

console.log("\n═══ ④ 大盘曝光 ═══");
await p("曝光实时 day", "S3Bjcm5", { day: d(0), prd_type: "yesterday" });
await g();
await p("曝光曲线 day", "S3C2zhg", { day: d(0), prd_type: "yesterday" });
await g();
await p("曝光历史 近7日", "S2cto44", { begin_day: d(-6), end_day: d(0), prd_type: "7days" });
await g();
await p("曝光历史 昨日", "S2cto44", { begin_day: d(-1), end_day: d(-1), prd_type: "yesterday" });
