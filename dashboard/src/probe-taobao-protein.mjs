/**
 * 判别性探测：同一 MTOP 信封下换不同 proteinCode，看谁能通。
 *   node src/probe-taobao-protein.mjs [--account=quanyi]
 *
 * 背景：`fetch-taobao-detail.mjs` 的 `SC8LRHx`（历史区间）报
 *   `FAIL_SYS_SERVICE_INNER_FAULT::服务内部故障`，
 *   而**同一个 mda 网关上的 getLoginnode 是成功的** —— 所以网关与 token 都没问题。
 * 要分清是「信封（context/request 结构）坏了」还是「这个服务号本身变了」，
 * 就得换几个 code 各打一次。
 *
 * 只读，不落盘。
 */
import { loadCookieSmart } from "./lib/cookie.mjs";
import { mtopCall, ensureMtopToken, GATEWAYS } from "./lib/mtop.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acctMeta = resolveAccount(process.argv);
const STEM = acctMeta.key === "quanyi" ? "taobao" : `taobao-${acctMeta.key}`;
const PORT = Number(arg("port", acctMeta.key === "quanyi" ? "9222" : "9223"));

const ymd = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};
const ds = arg("ds", ymd(-1));
const begin = (() => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ds);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 6);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
})();

let { cookies } = await loadCookieSmart({ stem: STEM, port: PORT, host: "nr.ele.me", required: ["WMSTOKEN"] });
if (!cookies._m_h5_tk) {
  cookies = await ensureMtopToken(cookies, { host: GATEWAYS.mda.host, jsv: "2.7.0" });
}

const API = "mtop.me.ele.newretail.data.analysis.proteinQueryForArea";
const HOST = GATEWAYS.mda.host;

async function raw(api, data, { jsv = "2.7.0", host = HOST, appKey } = {}) {
  const r = await mtopCall({ api, data, cookies, host, jsv, ...(appKey ? { appKey } : {}) });
  return r;
}

// 登录节点（这一步已知能通，作为对照组）
const nodeR = await raw("mtop.ele.newretail.ebai.MultiLevelMtopService.getLoginnode", {});
console.log(`对照组 getLoginnode: ok=${nodeR.ok} ret=${nodeR.ret ?? "-"}`);
const login = (nodeR.data?.data ?? nodeR.data)?.loginNodeInfo ?? {};
const ID = String(login.nodeId ?? "");
const ROLE = String(login.nodeType ?? "");
console.log(`nodeId=${ID} nodeType=${ROLE}\n`);
if (!ID) process.exit(2);

const envelope = (proteinCode, parameters) => ({
  context: JSON.stringify({ appName: "kbtdatacenter", userName: ROLE, userId: ID }),
  request: JSON.stringify({ proteinCode, withTracker: true, parameters: { id: ID, role: ROLE, ...parameters } }),
});

/** [code, 名称, 参数, 变体] */
const CASES = [
  ["SDqJ77i", "今日实时(realtime)", { begin_day: ds, end_day: ds, prd_type: "day", date_type: "今日", ds }, "base"],
  ["SC8LRHx", "历史区间(begin=end=ds)", { begin_day: ds, end_day: ds, prd_type: "week", date_type: "近7日", ds }, "base"],
  ["SC8LRHx", "历史区间(ds-6~ds)", { begin_day: begin, end_day: ds, prd_type: "week", date_type: "近7日", ds }, "base"],
  ["SEn1HKG", "多门店表格(ds-6~ds)", { begin_day: begin, end_day: ds, prd_type: "week", date_type: "近7日", ds, pageSize: "500", pageNum: "1" }, "base"],
  ["S2cto44", "曝光历史(ds-6~ds)", { begin_day: begin, end_day: ds, prd_type: "week", date_type: "近7日", ds }, "base"],
  // 变体：看是否是信封细节的问题
  ["SC8LRHx", "历史区间 · withTracker=false", { begin_day: ds, end_day: ds, prd_type: "week", date_type: "近7日", ds }, "noTracker"],
  ["SC8LRHx", "历史区间 · jsv=2.7.5", { begin_day: ds, end_day: ds, prd_type: "week", date_type: "近7日", ds }, "jsv275"],
  ["SC8LRHx", "历史区间 · shell 网关", { begin_day: ds, end_day: ds, prd_type: "week", date_type: "近7日", ds }, "shell"],
];

console.log(`窗口 ds=${ds} begin=${begin}\n`);
for (const [code, label, params, variant] of CASES) {
  let data = envelope(code, params);
  if (variant === "noTracker") {
    data = {
      context: JSON.stringify({ appName: "kbtdatacenter", userName: ROLE, userId: ID }),
      request: JSON.stringify({ proteinCode: code, parameters: { id: ID, role: ROLE, ...params } }),
    };
  }
  const opt = variant === "jsv275" ? { jsv: "2.7.5" } : variant === "shell" ? { host: "mtop.ele.me", jsv: "2.5.8" } : {};
  let out;
  try {
    const r = await raw(API, data, opt);
    const recs = r.data?.data?.result?.records;
    const n = Array.isArray(recs) ? recs.length : null;
    out = `ok=${r.ok} ret=${r.ret ?? "-"}${n != null ? ` records=${n}` : ""}`;
    if (r.ok && n) out += `  样例键=${Object.keys(recs[0] ?? {}).slice(0, 6).join(",")}`;
  } catch (e) {
    out = `抛错 ${String(e.message).slice(0, 80)}`;
  }
  console.log(`  ${label.padEnd(30)} [${code}]  ${out}`);
  await new Promise((r) => setTimeout(r, 400));
}
