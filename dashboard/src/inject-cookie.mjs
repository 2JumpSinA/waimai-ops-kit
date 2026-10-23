/**
 * 把 cookie 文件注入已运行的调试浏览器，并验证登录态。
 *   node src/inject-cookie.mjs --account=yifeng [--platform=meituan|ka]
 *
 * 为什么不用「用户手工登录」：用户已提供完整 cookie，CDP `Network.setCookie` 注入即可。
 *
 * 为什么要借助浏览器：美团系的敏感路由有网关签名（mtgsig），Node 直连会 403。
 * 浏览器里 H5guard 已 hook fetch，页内请求自动带签名。
 *
 * 先决条件：用户必须先跑 start-chrome-<account>.cmd 把浏览器起来
 *   （Node spawn 启动的 Chrome 渲染进程会被本环境拦，只有用户会话里的才行）
 *
 * 同一账号的美团医药与推广共用同一个 profile：两者域名都属 .meituan.com，
 *   cookie 会互相覆盖同名项（如 device_uuid），但 acctId/token/bsid 一致，实测可共存。
 *
 * 验证口径提醒：
 *   美团医药 订单接口日期格式 YYYY-MM-DD；推广报表接口日期格式 YYYYMMDD（相反）。
 *   推广报表是 T+1，查「今日」恒返回 0，验证必须用「昨日」。
 */
import { resolveAccount } from "./lib/account.mjs";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { connectToPage, setCookies, evaluate } from "./lib/cdp.mjs";

const argv = process.argv;
const argVal = (n) => {
  const a = argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : null;
};

const acct = resolveAccount(argv);
const PLATFORM = argVal("platform") ?? "meituan";

/** 平台 -> cookie 文件 stem 与验证方式 */
const PLATFORMS = {
  meituan: {
    stem: acct.key === "yifeng" ? "meituan-yifeng" : "meituan",
    domains: [".meituan.com", "yiyao.meituan.com"],
    navigate: "https://yiyao.meituan.com/main/frame",
    label: "美团医药",
  },
  ka: {
    stem: acct.key === "yifeng" ? "ka-yifeng" : "ka",
    domains: [".meituan.com", "ka.waimai.meituan.com"],
    navigate: "https://ka.waimai.meituan.com/new#/newhome",
    label: "美团营销平台（推广）",
  },
};

const P = PLATFORMS[PLATFORM];
if (!P) {
  console.error(`未知平台 "${PLATFORM}"，可用：${Object.keys(PLATFORMS).join(", ")}`);
  process.exit(1);
}

console.log(`账号 ${acct.label}（${acct.key}）  平台 ${P.label}  端口 ${acct.port}\n`);

// ── 1. 读 cookie ──
const header = loadCookieHeader(P.stem);
const { cookies } = parseCookieString(header);

// ── 2. 连浏览器 ──
let cdp;
try {
  cdp = await connectToPage(acct.port);
} catch (e) {
  console.error(`[失败] 连不上端口 ${acct.port}：${e.message}`);
  console.error(`   请先双击 start-chrome-${acct.key}.cmd 把浏览器起来`);
  process.exit(1);
}
console.log("[成功] 已连接（渲染器可用）");

// ── 3. 注入 ──
const n = await setCookies(cdp, header, P.domains);
console.log(`[cookie] 已注入 ${n} 项（域：${P.domains.join(" + ")}）`);
console.log(
  `   acctId=${cookies.acctId}  acctLogin=${cookies.acctLogin ?? cookies.acct_name ?? "-"}  wmPoiId=${cookies.wmPoiId}`
);

// ── 4. 导航 + 验证 ──
await cdp.send("Page.navigate", { url: P.navigate });
await new Promise((r) => setTimeout(r, 10000));

const ACCT_ID = cookies.acctId;
const pad = (x) => String(x).padStart(2, "0");

let script;
if (PLATFORM === "meituan") {
  script = `(async () => {
     const r = await fetch('/api/retail/v3/order/todayOrderSummary/query?ignoreSetRouterProxy=true', {
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'poiId=-1&acctId=${ACCT_ID}' });
     return JSON.stringify({ url: location.href, title: document.title, status: r.status, text: (await r.text()).slice(0,600) });
   })()`;
} else {
  // 推广：页内 POST 报表接口（H5guard 自动签名）
  const y = new Date(Date.now() - 86400_000);
  const day = `${y.getFullYear()}${pad(y.getMonth() + 1)}${pad(y.getDate())}`;
  script = `(async () => {
     const q = (o) => Object.entries(o).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
     // 用 overview（无分页参数，最干净）；list 需 pageSize/pageNum/queryType，且 pageSize 有合法取值
     const form = q({ startDate:'${day}', endDate:'${day}', cityIds:'-1', wmPoiIds:'-1', dpPoiIds:'-1',
       prodTypes:'1,36,35', searchRange:'0', platformType:'-1', fundTypes:'-1', acctBizType:'0', promotionType:'1' });
     const r = await fetch('/kepler/datacenter/api/ka/data/v2/history/overview', {
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: form });
     return JSON.stringify({ url: location.href, title: document.title, status: r.status, day:'${day}', text:(await r.text()).slice(0,1200) });
   })()`;
}

const out = JSON.parse(
  await evaluate(cdp, script).catch((e) => JSON.stringify({ error: e.message }))
);
if (out.error) {
  console.log(`\n[警告] 验证失败：${out.error}`);
} else {
  console.log(`\n页面：${out.title}  ${String(out.url).slice(0, 90)}`);
  console.log(`验证接口 [${out.status}]${out.day ? `  日期 ${out.day}` : ""}`);
  try {
    const j = JSON.parse(out.text);
    const d = j.data ?? {};
    if (PLATFORM === "ka") {
      console.log(`  code=${j.code} msg=${j.message ?? j.msg}`);
      console.log(
        `  曝光 ${d.showCount}  点击 ${d.clickCount}  消耗(分) ${d.cost}  CPC(分) ${d.cpc}  ROI ${d.convertEffectRoi}`
      );
      if (!Number(d.cost)) console.log(`  （cost 为 0/空：可能是该日无投放，或日期口径不对）`);
    } else {
      console.log("  " + JSON.stringify(d).slice(0, 400));
    }
  } catch {
    console.log("  " + String(out.text).replace(/\s+/g, " ").slice(0, 500));
  }
}

await cdp.close();
