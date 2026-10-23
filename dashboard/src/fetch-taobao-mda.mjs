/**
 * 闪购「MDA 门户」取数（**② 族**，不依赖 proteinCode）—— 品牌A / 品牌B**共用一条通路**。
 *   node src/fetch-taobao-mda.mjs [--account=quanyi|yifeng] [--days=30]
 *
 * 为什么要有这个脚本（2026-09-22）：
 *   闪购数据有**两套并行 API 族**（reference §6.13）：
 *     ① `...proteinQueryForArea`（proteinCode 参数）—— **2026-09-23 起对品牌A失效**（登录账号换成
 *        「眼镜店」主账号 nodeType=6 后 protein 一律返回 F，见 reference §6.16）；
 *     ② `mtop.nr.mda.portal.*` + `...data.analysis.get*Data` —— **两账号都能用，本脚本走这族**。
 *
 * ⭐⭐ 子账号求和口径（2026-09-23 经营者指示）：
 *   品牌A登录的是「眼镜店」主账号，下挂**两个子账号**（getChildNodeList 实测）：
 *     · 品牌A（o2o）      nodeId=17388905922760001  supplierId=2000003611017
 *     · 镜像子账号（镜像）    nodeId=<NODE_ID>  supplierId=<SUPPLIER_ID>
 *   MDA 接口**不认任何节点参数**（实测 nodeId/supplierId/nodeIds 全被忽略），数据跟随
 *   **服务器会话的当前节点**（页面顶部账号切换器控制）。纯 Node 切换 = 重放页面的
 *   `POST nracc.ele.me/bwm_newretail.recrm_merchant/manager/switchshop`
 *   （body `{"switchShopName","switchNodeId"}`，头 `X-Shard: nrshopid=<当前节点 supplierId>`，
 *   成功后 **Set-Cookie: SWITCH_SHOP/OUTER_AUTH_LOGIN** 必须应用到后续请求）。
 *   → 本脚本对每个子账号各取一遍再**求和**（昨日/近7/近30/今日/逐日/分时/流量），
 *     结束后**切回遍历前的原节点**（指纹匹配），尽量不打扰 reuse 模式下的网页端。
 *
 * 通路：纯 Node / MTOP，网关 `nrshop.ele.me`，**jsv 2.5.8**（② 族用的是 2.5.8，不是 protein 的 2.7.0）。
 * 响应约定：`data.dataItems`
 *   · `getMasterData` / `getCardData` → **对象 map**：`{字段: {code, codeName, currValue, preValue, preChangeValue, preRatio, valueType}}`
 *   · `getTrendChartData` / `getListData` → **数组**；趋势项形如 `{type:"曝光人数-当期值", day, value, typeCode}`
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { mtopCall, ensureMtopToken } from "./lib/mtop.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const STEM = acct.key === "quanyi" ? "taobao" : `taobao-${acct.key}`;
const PORT = Number(arg("port", acct.key === "quanyi" ? "9222" : "9223"));
const DAYS = Number(arg("days", "30"));
const OUT = dataPath(acct, "taobao-mda");

/** ② 族网关：jsv 2.5.8（与 protein 族的 2.7.0 不同，别混） */
const GATEWAY = { host: "nrshop.ele.me", jsv: "2.5.8" };

const ymd = (offset = 0) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() + offset * 86400_000)).replace(/-/g, "");
const dash = (s) => (String(s).length === 8 ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : String(s));
const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

let { cookies } = await loadCookieSmart({ stem: STEM, port: PORT, host: "nr.ele.me", required: ["WMSTOKEN"] });
if (!cookies._m_h5_tk) cookies = await ensureMtopToken(cookies, { host: "mtop.ele.me", jsv: "2.5.8" });
// ⭐ 子账号切换需要三域 cookie（switchshop @nracc.ele.me 校验 .ele.me + nracc 的 WMUSS 等）
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const eleCookies = await loadCookieSmart({ stem: STEM, port: PORT, host: "ele.me", required: [] }).catch(() => null);
const nraccCookies = await loadCookieSmart({ stem: STEM, port: PORT, host: "nracc.ele.me", required: [] }).catch(() => null);
let switchCookie = [cookies.header ?? null, eleCookies?.header ?? null, nraccCookies?.header ?? null].filter(Boolean).join("; ");

/** 把 switchshop 下发的 Set-Cookie（SWITCH_SHOP/OUTER_AUTH_LOGIN）应用到后续请求 */
const applySetCookies = (setc) => {
  const map = new Map();
  for (const p of switchCookie.split("; ").filter(Boolean)) { const i = p.indexOf("="); if (i > 0) map.set(p.slice(0, i), p); }
  for (const raw of setc) { const [pair] = raw.split(";"); const i = pair.indexOf("="); if (i > 0) map.set(pair.slice(0, i), pair); }
  switchCookie = [...map.values()].join("; ");
  const merged = Object.fromEntries([...map.values()].map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
  cookies = { ...merged, WMSTOKEN: merged.WMSTOKEN ?? cookies.WMSTOKEN };
  if (merged._m_h5_tk) rotated._m_h5_tk = merged._m_h5_tk;
};

const rotated = {};
const call = async (api, data) => {
  const r = await mtopCall({ api, data, cookies: { ...cookies, ...rotated }, host: GATEWAY.host, jsv: GATEWAY.jsv });
  if (r.cookies?._m_h5_tk && r.cookies._m_h5_tk !== (rotated._m_h5_tk ?? cookies._m_h5_tk)) rotated._m_h5_tk = r.cookies._m_h5_tk;
  if (!r.ok) return { error: r.ret?.[0] ?? r.ret };
  const dd = r.data?.data;
  if (dd?.code !== undefined && String(dd.code) !== "0") return { error: `code=${dd.code} ${dd.message ?? ""}` };
  return { data: dd?.dataItems ?? dd ?? null, raw: dd };
};

/** 重放页面「账号切换器」的 switchshop（返回 result=true 即切换成功）。 */
let curShard = null; // 当前节点的 supplierId（X-Shard 路由键）
const switchTo = async (node) => {
  const attempt = async (shard) => {
    const r = await fetch("https://nracc.ele.me/bwm_newretail.recrm_merchant/manager/switchshop", {
      method: "POST",
      headers: {
        "Accept": "application/json", "Content-Type": "application/json",
        "Origin": "https://nr.ele.me", "Referer": "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next",
        "User-Agent": UA, ...(shard ? { "X-Shard": `nrshopid=${shard}` } : {}),
        Cookie: switchCookie,
      },
      body: JSON.stringify({ switchShopName: node.name, switchNodeId: node.nodeId }),
    });
    const setc = r.headers.getSetCookie?.() ?? [];
    const j = await r.json().catch(() => null);
    return { ok: !!j?.result, msg: j?.errorMessage ?? r.status, setc };
  };
  let out = await attempt(curShard); // 先用当前节点 shard
  if (!out.ok) out = await attempt(node.bizId); // 兜底：目标节点自己的 shard
  if (out.ok) {
    applySetCookies(out.setc);
    curShard = node.bizId;
  }
  return out;
};

// ════════ ② 族接口封装（每-节点调用；多节点时在遍历循环里反复使用）════════
/** `biz.getMasterData`：窗口汇总。`startDate/endDate` 定窗口（T+1，查当天返回全 0）。 */
const bizMaster = async (start, end) => {
  const r = await call("mtop.nr.mda.portal.biz.getMasterData", { datePeriodTypeCode: "day", startDate: start, endDate: end });
  if (r.error) return { start: dash(start), end: dash(end), error: r.error };
  const D = r.data ?? {};
  const g = (k) => num(D[k]?.currValue);
  return {
    start: dash(start), end: dash(end),
    orderAmt: g("original_amt"),
    expectIncome: g("expect_income"),
    validOrderCnt: g("valid_order_cnt"),
    payAmt: g("pay_amt"),
    avgOrderAmt: g("avg_order_amt"),
    invalidOrderNum: g("invalid_order_num") ?? g("invalid_order_cnt"),
    shopSubsidyRate: g("shop_subsidy_rate"),
    /** 环比（上一期值 / 变化率）—— ② 族自带，不用自己算 */
    pre: {
      orderAmt: num(D.original_amt?.preValue), orderAmtRatio: num(D.original_amt?.preRatio),
      validOrderCnt: num(D.valid_order_cnt?.preValue), validOrderCntRatio: num(D.valid_order_cnt?.preRatio),
    },
  };
};
/** `homepage.getCustomerHourMasterData`：今日实时（对比日=昨天；页面「今日实时」6 卡片数据源）。 */
const homeMaster = async (compareDate) => {
  const r = await call("mtop.nr.mda.portal.homepage.getCustomerHourMasterData", {
    compareStartDate: compareDate, compareEndDate: compareDate,
  });
  if (r.error) return { error: r.error };
  const D = r.data ?? {};
  const g = (k) => num(D[k]?.currValue);
  const pre = (k) => num(D[k]?.preValue);
  return {
    orderAmt: g("original_amt"), expectIncome: g("expect_income"),
    validOrderCnt: g("valid_order_cnt"), payAmt: g("pay_amt"),
    /** 字段名实测为 invalid_order_cnt（homepage 族）；biz 族叫 invalid_order_num，两个都兜底 */
    avgOrderAmt: g("avg_order_amt"), invalidOrderNum: g("invalid_order_num") ?? g("invalid_order_cnt"),
    /** 上一期（对比日）同口径值 —— 页面上的「昨日同时段」 */
    pre: { orderAmt: pre("original_amt"), expectIncome: pre("expect_income"), validOrderCnt: pre("valid_order_cnt") },
  };
};
/** `biz.getTrendChartData`：逐日趋势（只取「当期值」行）。 */
const bizTrend = async (indexCode) => {
  const r = await call("mtop.nr.mda.portal.biz.getTrendChartData", {
    indexCodes: JSON.stringify([indexCode]), datePeriodTypeCode: "day", startDate: ymd(-DAYS), endDate: DS,
  });
  const items = Array.isArray(r.data) ? r.data : [];
  if (r.error || !items.length) return { points: [], error: r.error ?? "无 dataItems" };
  return {
    points: items
      .filter((x) => !String(x.type ?? "").includes("上一期"))
      .map((x) => ({ date: dash(String(x.day)), value: num(x.value) }))
      .filter((x) => x.date)
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
};
/** `homepage.getCustomerHourTrendChartData`：分时（当期值 + 上一期值成对 = 今日 vs 昨日）。 */
const hourTrend = async (indexCode, compareDate) => {
  const r = await call("mtop.nr.mda.portal.homepage.getCustomerHourTrendChartData", {
    indexCode, indexCodes: JSON.stringify([indexCode]), compareStartDate: compareDate, compareEndDate: compareDate,
  });
  const items = Array.isArray(r.data) ? r.data : [];
  if (r.error || !items.length) return { current: [], previous: [], error: r.error ?? "无 dataItems" };
  const pick = (suffix) =>
    items
      .filter((x) => String(x.type ?? "").includes(suffix))
      .map((x) => ({ hour: `${String(x.hour).padStart(2, "0")}:00`, value: num(x.value) }))
      .sort((a, b) => a.hour.localeCompare(b.hour));
  return { current: pick("当期值"), previous: pick("上一期值") };
};
/** `flow.overview.getMasterData`：流量窗口汇总（曝光/进店/下单）。⚠️ 实测字段是 exp_user_num/clk_user_num，不是 exp_uv_all/clk_uv_all。 */
const flowMaster = async (start, end) => {
  const r = await call("mtop.nr.mda.portal.flow.overview.getMasterData", { datePeriodTypeCode: "day", startDate: start, endDate: end });
  if (r.error) return { start: dash(start), end: dash(end), error: r.error };
  const D = r.data ?? {};
  const g = (k) => num(D[k]?.currValue);
  return {
    start: dash(start), end: dash(end),
    expPvAll: g("exp_pv_all"), expUvAll: g("exp_user_num"),
    clkPvAll: g("clk_pv_all"), clkUvAll: g("clk_user_num"),
    orderUserNum: g("place_order_user_num"),
    validOrderCntAll: g("valid_order_cnt_all"), validOrderCvrAll: g("valid_order_cvr_all"),
  };
};
/** 曝光逐日：`data.analysis.getTrendChartData`（flowAnalysis 族）。 */
const flowTrend = async (indexCode) => {
  const r = await call("mtop.me.ele.newretail.data.analysis.getTrendChartData", {
    datePeriodTypeCode: "day", startDate: ymd(-DAYS), endDate: DS,
    pageType: "flowAnalysis", moduleType: "flowConversionHistory",
    functionType: "flowConversionHistoryTrend", requestChannel: "PC", countRingRatio: true,
    extendParam: JSON.stringify({ range_type: 1 }),
    indexCodes: JSON.stringify([indexCode]), indexCode,
  });
  const items = Array.isArray(r.data) ? r.data : [];
  if (r.error || !items.length) return { points: [], error: r.error ?? "无 dataItems" };
  return {
    points: items
      .filter((x) => String(x.type ?? "").includes("当期值"))
      .map((x) => ({ date: dash(String(x.day)), value: num(x.value) }))
      .filter((x) => x.date)
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
};

const DS = ymd(-1);
console.log(`账号 ${acct.label}（${acct.key}）  端口 ${PORT}  ② 族（nrshop.ele.me jsv=2.5.8）`);
console.log(`窗口：ds=${DS}  回溯 ${DAYS} 天\n`);

// ════════ ⓪ 子账号发现（经营者 2026-09-23 口径：多子账号则遍历求和）════════
const loginResp = await call("mtop.ele.newretail.ebai.MultiLevelMtopService.getLoginnode", {});
if (loginResp.error) { console.error(`⛔ getLoginnode 失败：${loginResp.error}`); process.exit(2); }
const loginInfo = (loginResp.raw ?? loginResp.data)?.loginNodeInfo ?? {};
const loginNode = { name: String(loginInfo.nodeName ?? ""), nodeId: String(loginInfo.nodeId ?? ""), bizId: String(loginInfo.nodeBusinessId ?? ""), type: String(loginInfo.nodeType ?? "") };
if (!loginNode.nodeId) { console.error("⛔ 登录节点没有 nodeId"); process.exit(2); }

/** 子账号列表：loginnode 的子节点里 nodeType=2（o2o/镜像账号）才是可切换的业务节点 */
let childNodes = [];
const childResp = await call("mtop.ele.newretail.ebai.MultiLevelMtopService.getChildNodeList", { nodeId: loginNode.nodeId }, "2.5.8").catch(() => null);
const childRaw = childResp && !childResp.error ? (childResp.raw?.data?.childNodeList ?? childResp.data?.childNodeList ?? childResp.data?.data?.childNodeList ?? []) : [];
for (const c of childRaw) {
  if (String(c.nodeType) === "2") childNodes.push({ name: String(c.nodeName), nodeId: String(c.nodeId), bizId: String(c.nodeBusinessId ?? c.supplierId ?? "") });
}
const multiNode = childNodes.length > 1;
// 单节点账号（品牌B）：targets 就一个，不切换
const targets = multiNode ? childNodes : [{ name: loginNode.name || acct.label, nodeId: loginNode.nodeId, bizId: loginNode.bizId }];
console.log(multiNode
  ? `⓪ 检测到 ${childNodes.length} 个子账号，将遍历求和：${childNodes.map((c) => c.name).join(" + ")}`
  : `⓪ 单节点账号（${targets[0].name}），不切换`);

/** 遍历前的当前节点指纹（昨日窗口成交+有效单）—— 结束后切回它 */
let originNode = null;
if (multiNode) {
  const fp = await call("mtop.nr.mda.portal.biz.getMasterData", { datePeriodTypeCode: "day", startDate: DS, endDate: DS });
  const D = fp.data ?? {};
  originNode = { amt: num(D.original_amt?.currValue), valid: num(D.valid_order_cnt?.currValue) };
}

// 每-节点的原始采集结果
const perNode = [];   // { node, bizWindows, bizDaily, hourBiz, flowWindows, flowDaily }
let switchFails = 0;
for (const node of targets) {
  if (multiNode) {
    const sw = await switchTo(node);
    if (!sw.ok) { console.log(`   ⚠️ 切换到「${node.name}」失败（${sw.msg}），该节点数据缺失`); switchFails++; continue; }
    console.log(`→ 已切换到「${node.name}」`);
  }
  const collect = {};
  // ── 营业：4 窗口 ──
  collect.bizWindows = {
    today: await homeMaster(DS),
    yesterday: await bizMaster(DS, DS),
    d7: await bizMaster(ymd(-7), DS),
    d30: await bizMaster(ymd(-DAYS), DS),
  };
  // ── 营业：逐日 ──
  collect.bizDaily = {};
  for (const code of ["original_amt", "expect_income", "valid_order_cnt", "invalid_order_num", "invalid_order_cnt"]) {
    collect.bizDaily[code] = await bizTrend(code);
  }
  // ── 营业：分时（今日 vs 对比日）──
  //   ⭐ R22（2026-09-24）：新增 valid_order_cnt 分时 —— 「全部平台」合计取消率的分母需要它
  //   （美团分时有 orders，闪购此前没有分时有效订单，无法按小时对齐求和）。
  collect.hourBiz = {};
  for (const [key, codes] of [
    ["original_amt", ["original_amt"]],
    ["expect_income", ["expect_income"]],
    ["invalid_order_num", ["invalid_order_num", "invalid_order_cnt"]],
    ["valid_order_cnt", ["valid_order_cnt"]],
  ]) {
    collect.hourBiz[key] = { current: [], previous: [] };
    for (const code of codes) {
      const r = await hourTrend(code, DS);
      if (r.current.length) { collect.hourBiz[key] = r; break; }
    }
  }
  // ── 流量：窗口 + 逐日 ──
  collect.flowWindows = { d7: await flowMaster(ymd(-7), DS), d30: await flowMaster(ymd(-DAYS), DS) };
  collect.flowDaily = {};
  for (const code of ["exp_user_num", "clk_user_num", "place_order_user_num"]) {
    collect.flowDaily[code] = await flowTrend(code);
  }
  perNode.push({ node, ...collect });
}
// 结束后切回遍历前的原节点（按昨日窗口指纹匹配；匹配不到就切回第一个子账号）
if (multiNode && perNode.length) {
  let back = perNode[0].node;
  if (originNode && (originNode.amt != null || originNode.valid != null)) {
    for (const pn of perNode) {
      const y = pn.bizWindows.yesterday ?? {};
      if (y.orderAmt === originNode.amt && y.validOrderCnt === originNode.valid) { back = pn.node; break; }
    }
  }
  const sw = await switchTo(back);
  console.log(sw.ok ? `↩ 已切回原节点「${back.name}」` : `⚠️ 切回原节点失败（${sw.msg}）—— 网页端当前节点可能已变`);
}

// ════════ 多节点求和装配（输出 schema 与单节点版完全一致）════════
const okOf = (x) => (x && !x.error ? x : null);
const sumFields = (objs, keys) => {
  const out = {};
  for (const k of keys) {
    const vals = objs.map((o) => o?.[k]).filter((v) => v != null);
    out[k] = vals.length ? Number(vals.reduce((a, b) => a + b, 0).toFixed(2)) : null;
  }
  return out;
};
/** 窗口汇总求和：金额/单数可加；笔单价由合计重算；补贴率置 null（比率不可加） */
const sumBizWindows = (list) => {
  const oks = list.map(okOf).filter(Boolean);
  if (!oks.length) return list[0] ?? null;
  const s = sumFields(oks, ["orderAmt", "expectIncome", "validOrderCnt", "payAmt", "invalidOrderNum"]);
  const first = oks[0];
  return {
    start: first.start, end: first.end,
    ...s,
    avgOrderAmt: s.validOrderCnt ? Number((s.payAmt / s.validOrderCnt).toFixed(2)) : null,
    shopSubsidyRate: oks.length === 1 ? first.shopSubsidyRate : null,
    pre: oks.length === 1 ? first.pre : {
      orderAmt: sumFields(oks.map((o) => o.pre ?? {}), ["orderAmt"]).orderAmt,
      validOrderCnt: sumFields(oks.map((o) => o.pre ?? {}), ["validOrderCnt"]).validOrderCnt,
    },
    ...(oks.length > 1 ? { summedNodes: oks.length } : {}),
  };
};
/** 逐日序列求和：按 date 对齐 */
const sumDaily = (lists) => {
  const ok = lists.filter((l) => l?.points?.length);
  if (!ok.length) return lists[0] ?? { points: [] };
  const byDate = new Map();
  for (const l of ok) for (const p of l.points) {
    const cur = byDate.get(p.date) ?? { date: p.date, value: 0 };
    cur.value = Number((cur.value + (p.value ?? 0)).toFixed(2));
    byDate.set(p.date, cur);
  }
  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return ok.length === 1 ? ok[0] : { points, summedNodes: ok.length };
};
/** 分时求和：按 hour 对齐（当期/上期分别） */
const sumHourly = (list) => {
  const ok = list.filter((h) => h?.current?.length);
  if (!ok.length) return list[0] ?? { current: [], previous: [] };
  if (ok.length === 1) return ok[0];
  const merge = (side) => {
    const byH = new Map();
    for (const h of ok) for (const p of h[side] ?? []) {
      const cur = byH.get(p.hour) ?? { hour: p.hour, value: 0 };
      cur.value = Number((cur.value + (p.value ?? 0)).toFixed(2));
      byH.set(p.hour, cur);
    }
    return [...byH.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  };
  return { current: merge("current"), previous: merge("previous"), summedNodes: ok.length };
};

// ════════ 装配（schema 不变；多节点时值为求和）════════
// ⭐ 经营者 2026-09-23 口径：今日实时只算「品牌A o2o」主账号（页面今日实时跟随 o2o 节点），
//    **不参与子账号求和**；昨日/近7/近30 才是 o2o + 镜像两账号求和。
//    识别方式：节点名含 "o2o"（品牌A）；单节点账号（品牌B）找不到 o2o 时回退第一个节点。
const todayNode = perNode.find((p) => /o2o/i.test(p.node.name)) ?? perNode[0];
const bizWindows = {
  today: todayNode?.bizWindows.today ?? null,
  yesterday: sumBizWindows(perNode.map((p) => p.bizWindows.yesterday)),
  d7: sumBizWindows(perNode.map((p) => p.bizWindows.d7)),
  d30: sumBizWindows(perNode.map((p) => p.bizWindows.d30)),
};
// 逐日：valid_order_cnt 与 invalid_order_cnt 是同一指标的两个归一化名，避免重复 —— 优先 invalid_order_num
const bizDaily = {};
for (const code of ["original_amt", "expect_income", "valid_order_cnt"]) {
  bizDaily[code] = sumDaily(perNode.map((p) => p.bizDaily[code]));
}
{
  const invLists = perNode.map((p) => p.bizDaily.invalid_order_num?.points?.length ? p.bizDaily.invalid_order_num : p.bizDaily.invalid_order_cnt);
  const invSum = sumDaily(invLists);
  if (invSum.points?.length) bizDaily.invalidOrderNum = invSum;
}
const hourBiz = {};
for (const key of ["original_amt", "expect_income", "invalid_order_num", "valid_order_cnt"]) {
  hourBiz[key] = sumHourly(perNode.map((p) => p.hourBiz[key]));
}
/** 流量窗口求和：字段与营业窗口不同（expPvAll 等），不能复用 sumBizWindows；转化率不可加置 null */
const sumFlowWindows = (list) => {
  const oks = list.map(okOf).filter(Boolean);
  if (!oks.length) return list[0] ?? null;
  const s = sumFields(oks, ["expPvAll", "expUvAll", "clkPvAll", "clkUvAll", "orderUserNum", "validOrderCntAll"]);
  const first = oks[0];
  return {
    start: first.start, end: first.end,
    ...s,
    validOrderCvrAll: oks.length === 1 ? first.validOrderCvrAll : null,
    ...(oks.length > 1 ? { summedNodes: oks.length } : {}),
  };
};
const flowWindows = { d7: sumFlowWindows(perNode.map((p) => p.flowWindows.d7)), d30: sumFlowWindows(perNode.map((p) => p.flowWindows.d30)) };
const flowDaily = {};
for (const code of ["exp_user_num", "clk_user_num", "place_order_user_num"]) {
  flowDaily[code] = sumDaily(perNode.map((p) => p.flowDaily[code]));
}

console.log("① 营业窗口汇总（" + (multiNode ? `${perNode.length} 子账号求和` : "单节点") + "）：");
for (const [k, w] of Object.entries(bizWindows)) {
  console.log(`   ${k.padEnd(9)} ${w?.error ? `⚠️ ${w.error}` : `成交额 ${w.orderAmt ?? "—"} 预计收入 ${w.expectIncome ?? "—"} 有效订单 ${w.validOrderCnt ?? "—"} 流失 ${w.invalidOrderNum ?? "—"}`}`);
}

console.log("② 营业逐日：");
for (const [k, v] of Object.entries(bizDaily)) console.log(`   ${k.padEnd(16)} ${v?.points?.length ?? 0} 天`);
console.log("③ 营业分时：");
for (const [k, v] of Object.entries(hourBiz)) console.log(`   ${k.padEnd(18)} 当期 ${v?.current?.length ?? 0} 段 / 上期 ${v?.previous?.length ?? 0} 段`);
console.log(`④ 流量窗口：近7日 曝光人次 ${flowWindows.d7?.expPvAll ?? "—"} 曝光人数 ${flowWindows.d7?.expUvAll ?? "—"} 进店 ${flowWindows.d7?.clkUvAll ?? "—"}`);
for (const [k, v] of Object.entries(flowDaily)) console.log(`⑤ 流量逐日 ${k.padEnd(22)} ${v?.points?.length ?? 0} 天${v?.error ? `  ⚠️ ${v.error}` : ""}`);

// ── 落盘（全失败不覆盖）──
const anyOk =
  Object.values(bizWindows).some((w) => !w.error) ||
  Object.values(bizDaily).some((x) => x.points.length) ||
  Object.values(hourBiz).some((x) => x.current.length) ||
  Object.values(flowDaily).some((x) => x.points.length);
if (!anyOk) {
  console.error(`\n⛔ ② 族全部接口失败，**不覆盖** ${OUT}`);
  console.error(`   最后错误：${JSON.stringify(bizWindows.today.error ?? flowWindows.d7.error ?? bizDaily.original_amt.error ?? "?")}`);
  process.exit(2);
}
if (rotated._m_h5_tk) {
  const merged = { ...cookies, ...rotated };
  await writeFile(join(ROOT, ".secrets", `${STEM}.cookie.txt`), Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("; ") + "\n", "utf8");
}

const payload = {
  fetchedAt: new Date().toISOString(),
  account: { key: acct.key, label: acct.label },
  source: "taobao-shangou-mda",
  family: "② 门户族（mtop.nr.mda.portal.* + data.analysis.get*Data，jsv 2.5.8）",
  caliber: "闪购 MDA 门户。金额单位=**元**。⚠️ 与美团口径不同、门店集合不同，**不可相加**。闪购「流失订单」= 取消 + 全款退，比美团「已取消」宽。",
  ds: DS,
  days: DAYS,
  bizWindows,
  bizDaily,
  hourBiz,
  flowWindows,
  flowDaily,
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
console.log(`\n落盘 ${OUT}`);
