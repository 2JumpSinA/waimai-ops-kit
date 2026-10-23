/**
 * 淘宝闪购零售商家端取数（纯 Node，**不需要浏览器**）。
 *   node src/fetch-taobao.mjs [--account=quanyi|yifeng] [--port=9222]
 *
 * 为什么不需要浏览器：本后台走 MTOP，签名是普通 md5
 * （`md5(token & t & appKey & data)`，已从 vendors.js 源码逐字验证），
 * 可在 Node 里自己算。详见 reference/taobao-shangou-api.md。
 *
 * 但**cookie 可以从浏览器 profile 里读**（`--port`，默认 9222）：
 * `start-chrome-taobao.cmd` 用的是默认 profile `user-chrome`，和品牌A美团同一个 ——
 * 所以那个 profile 里同时有 `.meituan.com` 和 `.ele.me` 的 cookie。
 * 浏览器开着时优先读它（**会自动续期**），关着就回退静态文件，行为不变。
 *
 * 每个板块独立容错：某块失败只降级成一行提示，不影响其它块。
 *
 * ⚠️ 品牌B的闪购 cookie 是 `.secrets/taobao-yifeng.cookie.txt`，目前**尚未提供**。
 *    品牌A侧台账 130 家闪购门店已匹配，品牌B侧台账有 316 个饿了么 ID 但接口没数据。
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

const acctMeta = resolveAccount(process.argv);
/** 账号 -> cookie 文件 stem（品牌A沿用历史的 `taobao`，不破坏既有文件） */
const STEM = acctMeta.key === "quanyi" ? "taobao" : `taobao-${acctMeta.key}`;
const OUT = dataPath(acctMeta, "taobao");
/**
 * 闪购 cookie 所在浏览器必须与该账号一致：
 *   品牌A -> Chrome，端口 9222
 *   品牌B -> Edge，  端口 9223
 * ⚠️ 早先写死 9222，于是品牌B会去读**品牌A profile** 里的闪购 cookie ——
 *    看起来「读到了」，其实拿的是另一个账号的凭据（假阳性，比读不到更危险）。
 */
const DEFAULT_PORT = acctMeta.key === "quanyi" ? "9222" : "9223";
const PORT = Number(arg("port", DEFAULT_PORT));

console.log(`账号 ${acctMeta.label}（${acctMeta.key}）  cookie stem = ${STEM}\n`);
let { cookies } = await loadCookieSmart({
  stem: STEM,
  port: PORT,
  host: "nr.ele.me",
  // ⚠️ 只把 WMSTOKEN（登录会话）当硬条件。
  //    `_m_h5_tk` 是**服务端在首次访问 MTOP 网关时**通过 Set-Cookie 下发的，
  //    不是登录时给的 —— 把它当硬条件会误判成「登录失效」，
  //    让明明登录着的账号整段跑不了（品牌B就栽在这）。
  required: ["WMSTOKEN"],
});

/** ⭐ 缺 `_m_h5_tk` 时先向网关引导一次，再决定是不是真的没登录 */
if (!cookies._m_h5_tk) {
  console.log("[cookie] 缺 `_m_h5_tk`（MTOP 签名令牌），向网关引导一次…");
  cookies = await ensureMtopToken(cookies, { host: "mtop.ele.me", jsv: "2.5.8" });
  if (cookies._m_h5_tk) {
    console.log(`[cookie] ✅ 引导成功，已取到 _m_h5_tk（长度 ${String(cookies._m_h5_tk).length}）—— 说明登录会话本身是好的`);
  } else {
    console.log("[cookie] ⚠️ 引导失败：该账号的闪购登录会话可能真的失效了");
  }
}

/** 累计本次运行中被服务端轮换过的新 token，退出前写回凭据 */
const rotated = {};

const NS = "mtop.ele.newretail";
const call = async (api, data = {}) => {
  const r = await mtopCall({ api, data, cookies: { ...cookies, ...rotated } });
  if (r.cookies?._m_h5_tk && r.cookies._m_h5_tk !== (rotated._m_h5_tk ?? cookies._m_h5_tk)) {
    rotated._m_h5_tk = r.cookies._m_h5_tk;
    console.log(`   ↻ 服务端轮换了 _m_h5_tk（第 ${r.attempts} 次尝试后成功）`);
  }
  return r;
};

/** 板块级容错：单块失败只记降级信息 */
async function panel(name, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    console.warn(`  ⚠️ 板块「${name}」失败：${e.message}`);
    return { ok: false, error: e.message };
  }
}

const result = {
  fetchedAt: new Date().toISOString(),
  source: "taobao-shangou",
  entry: "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next",
  panels: {},
};

console.log("淘宝闪购取数（纯 Node / MTOP）\n");

// ════════ 1. 账号与登录节点 ════════
console.log("──── 1. 账号与登录节点 ────");
const acct = await panel("账号信息", async () => {
  const r = await call(`${NS}.ebai.AccountShopCookieService.getAccountInfo`);
  if (!r.ok) throw new Error(r.ret);
  return r.data?.data ?? r.data;
});
if (acct.ok) {
  const a = acct.value;
  console.log(`   用户 ${a.loginUserName} · 角色 ${a.roleTypeEnum} · 门店名「${a.shopName}」`);
  console.log(`   headChainId=${a.headChainId} merchantId=${a.merchantId}`);
}
result.panels.account = acct;

// ════════ 2. 门店清单（核心）════════
console.log("\n──── 2. 门店清单 ────");
const nodes = await panel("登录节点", async () => {
  const r = await call(`${NS}.ebai.MultiLevelMtopService.getloginnode`);
  if (!r.ok) throw new Error(r.ret);
  return r.data?.data ?? r.data;
});
result.panels.nodes = nodes;

if (nodes.ok) {
  const n = nodes.value;
  const shops = (n.subShopNodeInfos ?? []).map((s) => ({
    nodeId: s.nodeId,
    nodeBusinessId: s.nodeBusinessId,
    supplierId: s.supplierId,
    name: s.nodeName,
    city: s.cityName,
    nodeLevel: s.nodeLevel,
    nodeType: s.nodeType,
  }));
  const subNodes = (n.subNodeInfos ?? []).map((s) => ({
    nodeId: s.nodeId,
    name: s.nodeName,
    nodeBusinessId: s.nodeBusinessId,
  }));
  const cityDist = {};
  for (const s of shops) if (s.city) cityDist[s.city] = (cityDist[s.city] ?? 0) + 1;

  result.stores = shops;
  result.subNodes = subNodes;
  result.cityDist = cityDist;
  result.storeCount = shops.length;

  console.log(`   门店 ${shops.length} 家，分属 ${subNodes.length} 个二级节点：`);
  for (const s of subNodes) console.log(`     · ${s.name}`);
  console.log(`   城市分布：${JSON.stringify(cityDist)}`);
  const brands = {};
  for (const s of shops) {
    const b = String(s.name).replace(/[（(].*$/, "");
    brands[b] = (brands[b] ?? 0) + 1;
  }
  console.log(`   品牌分布：${JSON.stringify(brands)}`);
  console.log(`   门店 ID 样例：nodeId=${shops[0]?.nodeId} nodeBusinessId=${shops[0]?.nodeBusinessId}`);
}

// ════════ 3. 权限菜单（探测可见模块）════════
console.log("\n──── 3. 权限菜单 ────");
const menu = await panel("权限菜单", async () => {
  const r = await call(`${NS}.ebai.RoleService.getPcPrivilegeMenu`);
  if (!r.ok) throw new Error(r.ret);
  return r.data?.data ?? r.data;
});
if (menu.ok && menu.value?.list) {
  console.log(`   顶层分区 ${menu.value.list.length} 个：`);
  for (const m of menu.value.list) {
    const kids = m.list?.length ?? 0;
    console.log(`     · ${m.name}${kids ? `（${kids} 个子项）` : ""}`);
  }
}
result.panels.menu = menu;

// ════════ 4. 风险预警 ════════
console.log("\n──── 4. 风险预警 ────");
const risk = await panel("黄牌预警", async () => {
  const r = await call(`${NS}.ebai.YellowPromptMtopService.getYellowPrompt`);
  if (!r.ok) throw new Error(r.ret);
  return r.data?.data ?? r.data;
});
if (risk.ok) {
  const y = risk.value;
  console.log(`   显示=${y.display}  预警条数=${y.msgCount ?? 0}`);
  for (const m of (y.msgList ?? []).slice(0, 5)) console.log(`     · ${JSON.stringify(m).slice(0, 140)}`);
}
result.panels.risk = risk;

// ════════ 5. 未读消息 ════════
console.log("\n──── 5. 未读消息 ────");
const msg = await panel("未读数量", async () => {
  const r = await call(`${NS}.touch.notice.getUnreadCountList`);
  if (!r.ok) throw new Error(r.ret);
  return r.data?.data ?? r.data;
});
if (msg.ok && Array.isArray(msg.value)) {
  const total = msg.value.reduce((s, x) => s + (Number(x.unreadNum) || 0), 0);
  console.log(`   合计未读 ${total}`);
  for (const m of msg.value) if (Number(m.unreadNum) > 0) console.log(`     · ${m.categoryOneName}: ${m.unreadNum}`);
}
result.panels.messages = msg;

// ════════ 写回轮换过的 token ════════
if (rotated._m_h5_tk) {
  const merged = { ...cookies, ...rotated };
  const newHeader = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("; ");
  const cookiePath = join(ROOT, ".secrets", `${STEM}.cookie.txt`);
  await writeFile(cookiePath, newHeader + "\n", "utf8");
  console.log(`\n   ↻ 已把轮换后的 _m_h5_tk 写回 .secrets/${STEM}.cookie.txt`);
}

await mkdir(dirname(OUT), { recursive: true });
/**
 * ⚠️ 全板块失败时**不要落盘**。
 *
 * 真实翻车：品牌A闪购 cookie 过期后重跑，5 个板块全报 `FAIL_SYS_TOKEN_ILLEGAL`，
 * 脚本照样把空结果写进 `taobao-quanyi.json`，**把上一份好数据覆盖了**。
 * 落盘前先看有没有任何一块成功 —— 没有就保留旧文件并明确报错。
 */
const okPanels = Object.values(result.panels ?? {}).filter((p) => p?.ok).length;
const totalPanels = Object.keys(result.panels ?? {}).length;
if (okPanels === 0 && totalPanels > 0) {
  console.error(`\n⛔ ${totalPanels} 个板块全部失败，**不覆盖** ${OUT}`);
  console.error(`   最可能的原因：cookie 过期（看错误码是不是 FAIL_SYS_TOKEN_ILLEGAL / 非法令牌）`);
  console.error(`   请更新 .secrets/${STEM}.cookie.txt 后重跑。原有数据文件保持不变。`);
  process.exit(2);
}
await writeFile(OUT, JSON.stringify({ ...result, account: { key: acctMeta.key, label: acctMeta.label } }, null, 2), "utf8");
console.log(`\n已落盘 ${OUT}（${(JSON.stringify(result).length / 1024).toFixed(0)} KB，${okPanels}/${totalPanels} 板块成功）`);
if (result.storeCount) console.log(`门店 ${result.storeCount} 家`);
