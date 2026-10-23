/**
 * 淘宝闪购 · 第三轮：验证两个假设
 *   node src/probe-taobao3.mjs
 *
 *   假设 A：门店级接口需要会话里有「当前门店」上下文（cookie `SWITCH_SHOP`），
 *           收割时它是空的 → 先想办法把它设上，再重试 getShopBusinessState
 *   假设 B：订单列表在 `/crm?qt=neworderlist`（HTTP 路径，不走 MTOP），
 *           主机是 ebai.ele.me → 直接带 cookie 请求
 */
import { readFileSync } from "node:fs";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const header = loadCookieHeader("taobao");
const { cookies } = parseCookieString(header);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const tb = JSON.parse(readFileSync("data/raw/taobao.json", "utf8"));
const shops = (tb.stores ?? []).slice(0, 3);
console.log("试验门店：");
for (const s of shops) console.log(`  ${s.name}  nodeBusinessId=${s.nodeBusinessId}  nodeId=${s.nodeId}`);

const cut = (v, n = 400) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > n ? s.slice(0, n) + "…" : s;
};

// ════════ 假设 B：/crm 是普通 HTTP（先试，成本最低）════════
console.log("\n═══ 假设 B：订单 HTTP 路径 ═══");
const PATHS = [
  ["订单列表", "/crm?qt=neworderlist"],
  ["自动确认订单", "/crm/autoconfirmorderlist"],
  ["订单通知", "/order/notice?type=1"],
];
for (const host of ["ebai.ele.me", "nr.ele.me"]) {
  for (const [label, path] of PATHS) {
    const url = `https://${host}${path}`;
    try {
      const r = await fetch(url, {
        headers: { Cookie: header, "User-Agent": UA, Accept: "application/json, text/plain, */*", Referer: "https://nr.ele.me/" },
        redirect: "manual",
      });
      const text = await r.text();
      const icon = r.status === 200 ? "✅" : "⛔";
      let note = "";
      try {
        const j = JSON.parse(text);
        note = `JSON keys=${JSON.stringify(Object.keys(j).slice(0, 12))} ${cut(j, 200)}`;
      } catch {
        note = text.slice(0, 120).replace(/\s+/g, " ");
      }
      console.log(`${icon} [${r.status}] ${host.padEnd(14)} ${label.padEnd(12)} ${note}`);
    } catch (e) {
      console.log(`💥 ${host} ${label}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 300));
  }
}

// ════════ 假设 A：先把当前门店设上 ════════
console.log("\n═══ 假设 A：设置当前门店上下文 ═══");
const SID = String(shops[0]?.nodeBusinessId ?? "");
const NID = String(shops[0]?.nodeId ?? "");

// A1. getSwitchShop 带节点参数
for (const [name, data] of [
  ["空", {}],
  ["nodeId", { nodeId: NID }],
  ["shopId", { shopId: SID }],
  ["parentNodeId", { parentNodeId: NID }],
]) {
  const r = await mtopCall({ api: "mtop.eleme.newretail.shop.admin.ebai.h5.chain.getSwitchShop", data, cookies });
  console.log(`${r.ok ? "✅" : "⛔"} getSwitchShop·${name.padEnd(14)} ${r.ok ? cut(r.data, 200) : r.ret}`);
  await new Promise((res) => setTimeout(res, 300));
}

// A2. 手工塞 SWITCH_SHOP 各种格式后重试营业状态
const SWITCH_VARIANTS = [
  ["=nodeBusinessId", SID],
  ["=nodeId", NID],
  ["=JSON{shopId}", JSON.stringify({ shopId: SID })],
  ["=JSON{nodeBusinessId}", JSON.stringify({ nodeBusinessId: SID })],
  ["=JSON{shopId,nodeId}", JSON.stringify({ shopId: SID, nodeId: NID })],
];
for (const [name, val] of SWITCH_VARIANTS) {
  const withSwitch = { ...cookies, SWITCH_SHOP: val };
  const r = await mtopCall({
    api: "mtop.eleme.newretail.shop.admin.ebai.common.getShopBusinessState",
    data: { shopId: SID },
    cookies: withSwitch,
  });
  console.log(`${r.ok ? "✅" : "⛔"} 营业状态 SWITCH_SHOP${name.padEnd(22)} ${r.ok ? cut(r.data, 240) : r.ret}`);
  await new Promise((res) => setTimeout(res, 320));
}

// A3. 完全不传 shopId，只靠 cookie
const r3 = await mtopCall({
  api: "mtop.eleme.newretail.shop.admin.ebai.common.getShopBusinessState",
  data: {},
  cookies: { ...cookies, SWITCH_SHOP: SID },
});
console.log(`${r3.ok ? "✅" : "⛔"} 营业状态 只靠 SWITCH_SHOP cookie     ${r3.ok ? cut(r3.data, 240) : r3.ret}`);

// ════════ 顺带：资质到期的正确参数（前面提示缺 page）════════
console.log("\n═══ 资质到期参数补全 ═══");
for (const [name, data] of [
  ["page+pageSize", { page: 1, pageSize: 20 }],
  ["pageNum+pageSize", { pageNum: 1, pageSize: 20 }],
  ["page+page_size", { page: 1, page_size: 20 }],
]) {
  const r = await mtopCall({ api: "mtop.ele.newretail.ebai.YellowPromptService.getSubAptitudeExpire", data, cookies });
  console.log(`${r.ok ? "✅" : "⛔"} ${name.padEnd(18)} ${r.ok ? cut(r.data, 300) : r.ret}`);
  await new Promise((res) => setTimeout(res, 320));
}
