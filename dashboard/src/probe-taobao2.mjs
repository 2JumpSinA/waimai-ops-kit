/**
 * 淘宝闪购 · 第二轮接口探测：聚焦用户要的四项数据。
 *   node src/probe-taobao2.mjs
 *
 *   ① 取消单数量/占比（今日 / 近1小时 / 近7天）
 *   ② 异常未营业门店明细
 *   ③ 近7天高取消单占比门店
 *   ④ 大盘曝光变化
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const header = loadCookieHeader("taobao");
const { cookies } = parseCookieString(header);

// 拿一家真实门店做参数实验
const tb = JSON.parse(readFileSync("data/raw/taobao.json", "utf8"));
const shop = tb.stores?.[0] ?? {};
const SID = String(shop.nodeBusinessId ?? "1259016335");
const NID = String(shop.nodeId ?? "");
console.log(`试验门店：${shop.name}  nodeBusinessId=${SID} nodeId=${NID}\n`);

const cut = (v, n = 320) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > n ? s.slice(0, n) + "…" : s;
};

const results = [];
async function probe(label, api, data) {
  let r;
  try {
    r = await mtopCall({ api, data, cookies });
  } catch (e) {
    console.log(`💥 ${label.padEnd(26)} ${e.message}`);
    return null;
  }
  results.push({ label, api, data, ret: r.ret, ok: r.ok, sample: r.ok ? cut(r.data) : undefined });
  if (r.ok) {
    let shape = "";
    const d = r.data;
    if (Array.isArray(d)) shape = `[${d.length}]` + (d[0] ? ` 首项keys=${JSON.stringify(Object.keys(d[0]).slice(0, 14))}` : "");
    else if (d && typeof d === "object") shape = `keys=${JSON.stringify(Object.keys(d).slice(0, 18))}`;
    else shape = cut(d, 100);
    console.log(`✅ ${label.padEnd(26)} ${shape}`);
    if (Array.isArray(d) && d[0]) console.log(`     样例: ${cut(d[0], 280)}`);
  } else {
    console.log(`⛔ ${label.padEnd(26)} ${r.ret}`);
  }
  await new Promise((res) => setTimeout(res, 320));
  return r;
}

const NS = "mtop.ele.newretail";
const SHOPNS = "mtop.eleme.newretail.shop.admin.ebai";

console.log("═══ ① 订单与取消 ═══");
await probe("按日期订单列表", `${NS}.order.seller.queryappservice.getdateorderlist`, {
  keyword: "", page_size: 50, page: 1, mainOrderGray: 1,
});
await probe("拉取订单", `${NS}.order.seller.QueryPcService.pullOrder`, {});
await probe("拉取订单(带门店)", `${NS}.order.seller.QueryPcService.pullOrder`, { shopId: SID });
await probe("拉取订单(pageSize)", `${NS}.order.seller.QueryPcService.pullOrder`, { pageSize: 20, pageNum: 1 });
await probe("订单主信息", `${NS}.order.seller.QueryPcService.getMainOrderInfo`, { orderId: "0" });
await probe("订单灰度", `${NS}.order.seller.common.getOrderOptGray`, {});

console.log("\n═══ ② 门店营业状态（试不同参数名）═══");
for (const [name, data] of [
  ["空", {}],
  ["shopId=nodeBusinessId", { shopId: SID }],
  ["shopId=nodeId", { shopId: NID }],
  ["poiId=nodeBusinessId", { poiId: SID }],
  ["wmPoiId=nodeBusinessId", { wmPoiId: SID }],
  ["nodeBusinessId", { nodeBusinessId: SID }],
  ["shopIds 数组", { shopIds: [SID] }],
  ["merchantId", { merchantId: "17388197152130001" }],
]) {
  await probe(`营业状态·${name}`, `${SHOPNS}.common.getShopBusinessState`, data);
}

console.log("\n═══ ③ 资质到期（影响「异常」判定）═══");
await probe("资质到期(pageSize)", `${NS}.ebai.YellowPromptService.getSubAptitudeExpire`, { pageSize: 20, pageNum: 1 });
await probe("资质到期(page_size)", `${NS}.ebai.YellowPromptService.getSubAptitudeExpire`, { page_size: 20, page: 1 });

console.log("\n═══ ④ 数据分析 / 曝光 / 导出 ═══");
await probe("数据分析权限", "mtop.me.ele.newretail.data.analysis.aiCheckPermission", {});
await probe("数据分析灰度", "mtop.me.ele.newretail.data.analysis.batchDataAnalysisGrayScale", {});
await probe("进行中任务数", `${NS}.tools.download.inprogresstaskcount`, {});
await probe("任务轮询", `${NS}.tools.download.taskPollingQuery`, {});
await probe("任务轮询(taskId)", `${NS}.tools.download.taskPollingQuery`, { taskId: "" });
await probe("读任务", `${NS}.tools.gei.readTask`, {});

await mkdir("_recon/raw", { recursive: true });
await writeFile("_recon/raw/taobao-probe2.json", JSON.stringify(results, null, 2));
const okN = results.filter((r) => r.ok).length;
console.log(`\n汇总：${okN} / ${results.length} 可用 → _recon/raw/taobao-probe2.json`);
