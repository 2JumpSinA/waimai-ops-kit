/**
 * 复刻 MDA proteinQueryForArea 请求 —— 验证能否拿到营业统计数据。
 *   node src/probe-mda.mjs
 *
 * 请求形状来自 CDP 嗅探真实流量（见 _recon/raw/eleme-sniff2.json）：
 *   GET https://nrshop.ele.me/h5/mtop.me.ele.newretail.data.analysis.proteinqueryforarea/1.0/
 *   jsv=2.7.0 appKey=12574478 v=1.0 type=originaljson
 *   data = { context: "<json 字符串>", request: "<json 字符串>" }
 */
import { readFileSync } from "node:fs";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const { cookies } = parseCookieString(loadCookieHeader("taobao"));

const d = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};
const cut = (v, n = 900) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > n ? s.slice(0, n) + "…" : s;
};

// 登录节点（id / role 的真实来源）
const node = await mtopCall({ api: "mtop.ele.newretail.ebai.MultiLevelMtopService.getloginnode", data: {}, cookies });
const n = node.data?.data ?? node.data;
const login = n?.loginNodeInfo ?? {};
const NODE_ID = String(login.nodeId ?? "");
const ROLE = String(login.nodeType ?? "");
console.log(`登录节点：${login.nodeName}  nodeId=${NODE_ID}  nodeType=${ROLE}`);
console.log(`（嗅探到的真实请求里 id=${"17388197152180001"} role=${"6"} —— 应对得上）\n`);

const HOST = "nrshop.ele.me";
const JSV = "2.7.0";
const API = "mtop.me.ele.newretail.data.analysis.proteinQueryForArea";

/** 复刻嗅探到的结构 */
function makeData(proteinCode, { date, currHour, extra = {} } = {}) {
  const context = JSON.stringify({
    appName: "kbtdatacenter",
    userName: ROLE,
    userId: NODE_ID,
  });
  const parameters = { id: NODE_ID, role: ROLE, date, currHour, ...extra };
  const request = JSON.stringify({ proteinCode, withTracker: true, parameters });
  return { context, request };
}

async function call(label, proteinCode, opts = {}) {
  const data = makeData(proteinCode, { date: d(0), currHour: String(new Date().getHours()), ...opts });
  const r = await mtopCall({ api: API, data, cookies, host: HOST, jsv: JSV });
  if (r.ok) {
    console.log(`✅ ${label.padEnd(30)} ret=${r.ret}`);
    console.log(`     ${cut(r.data, 700)}`);
  } else {
    console.log(`⛔ ${label.padEnd(30)} ${r.ret}`);
  }
  return r;
}

console.log("═══ ① 复刻嗅探到的 proteinCode ═══");
await call("SDqJ77i（营业统计页面用的）", "SDqJ77i");
await new Promise((r) => setTimeout(r, 400));

console.log("\n═══ ② 源码 mock 里出现的 proteinCode ═══");
await call("S2cto44", "S2cto44", { extra: { begin_day: d(-6), end_day: d(0) } });
await new Promise((r) => setTimeout(r, 400));

console.log("\n═══ ③ 换日期：近 7 天 ═══");
await call("SDqJ77i 近7天", "SDqJ77i", { date: d(-6), extra: { begin_day: d(-6), end_day: d(0) } });
await new Promise((r) => setTimeout(r, 400));

console.log("\n═══ ④ 探测更多 proteinCode 是否存在（看是「无效 code」还是「有效但无数据」）═══");
for (const code of ["S2cto44", "aaaaaaa", "SDqJ77A", "SDqJ77j"]) {
  const r = await mtopCall({
    api: API,
    data: makeData(code, { date: d(0), currHour: "17" }),
    cookies, host: HOST, jsv: JSV,
  });
  const tail = r.ok ? cut(r.data, 260) : r.ret;
  console.log(`  ${code.padEnd(10)} ${r.ok ? "✅" : "⛔"} ${tail}`);
  await new Promise((x) => setTimeout(x, 350));
}
