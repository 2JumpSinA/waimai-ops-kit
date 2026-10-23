/**
 * 淘宝闪购零售商家端 · MTOP 接口探测（纯 Node，不需要浏览器）。
 *   node src/probe-taobao.mjs
 *
 * 用空参数先打一遍最相关的接口，看哪些直接可用、响应结构长什么样。
 * 不写业务数据，只打印结构与样例。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const header = loadCookieHeader("taobao");
const { cookies } = parseCookieString(header);

const cut = (v, n = 400) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > n ? s.slice(0, n) + "…" : s;
};

function describe(d) {
  if (d === null || d === undefined) return String(d);
  if (Array.isArray(d)) {
    return `[${d.length}]` + (d[0] !== undefined ? ` 首项keys=${JSON.stringify(Object.keys(d[0] ?? {}).slice(0, 14))}` : "");
  }
  if (typeof d === "object") {
    const keys = Object.keys(d);
    const out = [`keys=${JSON.stringify(keys.slice(0, 16))}`];
    // 如果里面还嵌着数组，指出来
    for (const k of keys.slice(0, 8)) {
      if (Array.isArray(d[k])) out.push(`${k}:[${d[k].length}]`);
    }
    return out.join(" ");
  }
  return cut(d, 120);
}

/** 按用途分组，全部先用空参数打一发 */
const GROUPS = [
  ["账号与节点", [
    ["账号信息", "mtop.ele.newretail.ebai.AccountShopCookieService.getAccountInfo"],
    ["登录节点", "mtop.ele.newretail.ebai.MultiLevelMtopService.getloginnode"],
    ["连锁子节点(门店列表)", "mtop.ele.newretail.ebai.MultiLevelMtopService.getChildNodeList"],
    ["权限菜单", "mtop.ele.newretail.ebai.RoleService.getPcPrivilegeMenu"],
    ["权限基础菜单", "mtop.ele.newretail.ebai.RoleService.getPcPrivilegeBaseMenu"],
    ["当前门店用户", "mtop.ele.newretail.ebai.AccountReadMtopService.getloginShopUser"],
    ["门店用户信息", "mtop.ele.newretail.ebai.AccountReadMtopService.getShopUserInfo"],
  ]],
  ["门店", [
    ["门店营业状态", "mtop.eleme.newretail.shop.admin.ebai.common.getShopBusinessState"],
    ["门店信息", "mtop.ele.newretail.ebai.ShopReadMtopService.getShopInfo"],
    ["门店属性", "mtop.eleme.newretail.shop.admin.ebai.common.getShopAttribute"],
    ["连锁切换门店", "mtop.eleme.newretail.shop.admin.ebai.h5.chain.getSwitchShop"],
    ["经营主体", "mtop.eleme.newretail.shop.admin.ebai.shop.operatedMerchant"],
    ["是否有开店任务", "mtop.ele.newretail.ebai.ShopReadMtopService.isShopHasOpenTask"],
  ]],
  ["订单", [
    ["拉取订单", "mtop.ele.newretail.order.seller.QueryPcService.pullOrder"],
    ["按日期订单列表", "mtop.ele.newretail.order.seller.queryappservice.getdateorderlist"],
    ["订单主信息", "mtop.ele.newretail.order.seller.QueryPcService.getMainOrderInfo"],
  ]],
  ["风险与导出", [
    ["黄牌预警", "mtop.ele.newretail.ebai.YellowPromptMtopService.getYellowPrompt"],
    ["资质到期", "mtop.ele.newretail.ebai.YellowPromptService.getSubAptitudeExpire"],
    ["导出任务轮询", "mtop.ele.newretail.tools.download.taskPollingQuery"],
    ["进行中任务数", "mtop.ele.newretail.tools.download.inprogresstaskcount"],
  ]],
  ["消息待办", [
    ["未读消息V2", "mtop.ele.newretail.merchant.notice.DevMsgService.unreadMsgListV2"],
    ["未读数量", "mtop.ele.newretail.touch.notice.getUnreadCountList"],
  ]],
];

await mkdir("_recon/raw", { recursive: true });
const results = {};

for (const [group, apis] of GROUPS) {
  console.log(`\n${"═".repeat(66)}\n  ${group}\n${"═".repeat(66)}`);
  for (const [label, api] of apis) {
    let r;
    try {
      r = await mtopCall({ api, data: {}, cookies });
    } catch (e) {
      console.log(`💥 ${label.padEnd(22)} ${e.message}`);
      continue;
    }
    results[label] = { api, ret: r.ret, ok: r.ok, data: r.data };
    if (r.ok) {
      console.log(`✅ ${label.padEnd(22)} ${describe(r.data)}`);
      // 深层结构单独列出，便于看清嵌套
      if (r.data && typeof r.data === "object" && !Array.isArray(r.data)) {
        for (const [k, v] of Object.entries(r.data)) {
          if (Array.isArray(v) && v.length) {
            console.log(`     └─ ${k}: [${v.length}] 首项keys=${JSON.stringify(Object.keys(v[0] ?? {}).slice(0, 14))}`);
            if (v[0] && typeof v[0] === "object") {
              console.log(`        样例: ${cut(v[0], 300)}`);
            }
          }
        }
      }
      if (Array.isArray(r.data) && r.data.length) {
        console.log(`     样例: ${cut(r.data[0], 320)}`);
      }
    } else {
      console.log(`⛔ ${label.padEnd(22)} ${r.ret}`);
    }
    await new Promise((res) => setTimeout(res, 350)); // 别打太快
  }
}

await writeFile("_recon/raw/taobao-probe.json", JSON.stringify(results, null, 2));
const okN = Object.values(results).filter((x) => x.ok).length;
console.log(`\n汇总：${okN} / ${Object.keys(results).length} 个接口直接可用`);
console.log("落盘 _recon/raw/taobao-probe.json");
