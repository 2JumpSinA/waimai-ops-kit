/**
 * 验证 MDA 服务号（proteinCode）—— 覆盖用户要的四项数据。
 *   node src/probe-mda2.mjs
 */
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const { cookies } = parseCookieString(loadCookieHeader("taobao"));
const d = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};
const cut = (v, n = 620) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > n ? s.slice(0, n) + "…" : s;
};

const node = await mtopCall({ api: "mtop.ele.newretail.ebai.MultiLevelMtopService.getloginnode", data: {}, cookies });
const login = (node.data?.data ?? node.data)?.loginNodeInfo ?? {};
const ID = String(login.nodeId ?? "");
const ROLE = String(login.nodeType ?? "");
console.log(`节点 ${login.nodeName}  id=${ID} role=${ROLE}\n`);

const HOST = "nrshop.ele.me", JSV = "2.7.0";
const API = "mtop.me.ele.newretail.data.analysis.proteinQueryForArea";

async function p(label, code, params = {}) {
  const data = {
    context: JSON.stringify({ appName: "kbtdatacenter", userName: ROLE, userId: ID }),
    request: JSON.stringify({ proteinCode: code, withTracker: true, parameters: { id: ID, role: ROLE, currHour: String(new Date().getHours()), ...params } }),
  };
  const r = await mtopCall({ api: API, data, cookies, host: HOST, jsv: JSV });
  const dd = r.data?.data;
  const res = dd?.result;
  if (r.ok && res?.success) {
    const rec = res.record ?? {};
    const recs = res.records ?? [];
    const fields = (dd.parameters?._downloadFields ?? "").split(",").filter(Boolean);
    console.log(`✅ ${label.padEnd(26)} ${code}  type=${dd.resultType}`);
    if (fields.length) console.log(`     字段: ${fields.slice(0, 20).join(", ")}`);
    if (Object.keys(rec).length) console.log(`     记录: ${cut(rec, 400)}`);
    if (recs.length) { console.log(`     [${recs.length} 条] 首条: ${cut(recs[0], 400)}`); }
    return r;
  }
  console.log(`⛔ ${label.padEnd(26)} ${code}  ${r.ok ? (res?.statusCode ?? dd?.msg ?? "无数据") : r.ret}`);
  if (r.ok && dd?.msg) console.log(`     msg: ${String(dd.msg).slice(0, 200)}`);
  return r;
}

console.log("═══ ① 取消/流失：今日 · 近7天 · 分时 ═══");
await p("今日实时", "SDqJ77i", { date: d(0) });
await new Promise((r) => setTimeout(r, 350));
await p("历史区间(今日)", "SC8LRHx", { begin_day: d(0), end_day: d(0) });
await new Promise((r) => setTimeout(r, 350));
await p("历史区间(近7天)", "SC8LRHx", { begin_day: d(-6), end_day: d(0) });
await new Promise((r) => setTimeout(r, 350));
await p("流失/失效", "SCDzram", { begin_day: d(-6), end_day: d(0) });
await new Promise((r) => setTimeout(r, 350));
await p("分时曲线(今日)", "SGBk0Xz", { date: d(0) });
await new Promise((r) => setTimeout(r, 350));

console.log("\n═══ ② 门店明细 ═══");
await p("历史明细(门店)", "S4tMNzj", { begin_day: d(-6), end_day: d(0), pageSize: 10 });
await new Promise((r) => setTimeout(r, 350));
await p("多门店表格", "SEn1HKG", { begin_day: d(-6), end_day: d(0), pageSize: 10 });
await new Promise((r) => setTimeout(r, 350));

console.log("\n═══ ③ 大盘曝光 ═══");
await p("曝光实时", "S3Bjcm5", { date: d(0) });
await new Promise((r) => setTimeout(r, 350));
await p("曝光曲线", "S3C2zhg", { date: d(0) });
await new Promise((r) => setTimeout(r, 350));
await p("曝光历史(近7天)", "S2cto44", { begin_day: d(-6), end_day: d(0) });
await new Promise((r) => setTimeout(r, 350));

console.log("\n═══ ④ 商品/退款 ═══");
await p("商品历史", "SE2F758", { begin_day: d(-6), end_day: d(0) });
await new Promise((r) => setTimeout(r, 350));
await p("退款商品", "SDxZhMl", { begin_day: d(-6), end_day: d(0), pageSize: 10 });
