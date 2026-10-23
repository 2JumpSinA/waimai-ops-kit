/**
 * 探「美团商家端有没有现成的 7天/30天 聚合入口」—— 第二轮
 *   node src/probe-range-summary.mjs [--account=quanyi|yifeng] [--days=30]
 *
 * 第一轮结论（已成立，别再重复验证）：
 *   · 订单页默认窗口 = **今日**（startDate=endDate=今天），发的是 page/history
 *   · `todayOrderSummary` **硬编码今日**，传区间参数被忽略
 *   · `order/list/interval` 返回各状态**单量**，不含金额
 *
 * 第一轮的 bug（已修）：`coreBase` 以 `labelId=` 结尾，我直接续 `dateType=` 没加 `&`，
 *   拼成 `labelId=dateType=realTime` → 六个 dateType 变体**全部无效**。
 *   教训：拼 query 一律用 URLSearchParams，不要手写字符串。
 *
 * 本轮做三件事：
 *   A. 订单页上把**筛选控件**枚举出来（找真正的「近30天」入口长什么样）
 *   B. 打开**经营分析页**，录它自己发的请求 —— 这是「平台现成入口」最权威的答案
 *   C. 用正确的 URL 重测 manageHome/core，逐个打印 multiProjectedIncome
 *
 * 判据仍是数值：品牌A近30天预计收入 ≈ 121,869 元；品牌B ≈ 84,845 元。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = acct.port;
const DAYS = Number(arg("days", "30"));
const ACCT_ID = acct.key === "quanyi" ? "236679097" : "149608986";
const BASELINE = acct.key === "quanyi" ? "121,869" : "84,845";

const ORDER_PAGE = "https://yiyao.meituan.com/main/frame#/page/orderbusiness#/order/history";
const ANALYSIS_PAGE = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";

const INTERESTING = /order\/list|OrderSummary|countAndSum|manageHome|bizdata|analysis|chart|trend/i;
const compact = (v, n = 320) => (v == null ? "(无)" : String(v).replace(/\s+/g, " ").slice(0, n));

const iso = (offsetDays = 0) => {
  const t = new Date(Date.now() + offsetDays * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};
const ymd = (offsetDays = 0) => iso(offsetDays).replace(/-/g, "");

console.log(`══ 第二轮  账号 ${acct.label}  端口 ${PORT}  days=${DAYS} ══`);
console.log(`   今天=${iso(0)}  近${DAYS}天=${iso(-DAYS)} ~ ${iso(-1)}   基准 ≈ ${BASELINE} 元`);

const cdp = await connectToPage(PORT);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (!INTERESTING.test(u)) return;
  seen.push({ method: p.request.method, url: u, postData: p.request.postData ?? null });
});

const dumpNew = (from, label) => {
  const list = seen.slice(from);
  const uniq = new Map();
  for (const h of list) {
    const key = h.method + " " + h.url.split("?")[0] + " " + String(h.postData ?? "").slice(0, 60);
    if (!uniq.has(key)) uniq.set(key, h);
  }
  console.log(`\n   ── ${label}（${list.length} 条，去重 ${uniq.size}） ──`);
  if (!uniq.size) { console.log("      （无）"); return; }
  for (const h of uniq.values()) {
    console.log(`      ${h.method} ${h.url.replace("https://yiyao.meituan.com", "").split("?")[0]}`);
    console.log(`         query: ${compact(h.url.split("?")[1], 260)}`);
    if (h.postData) console.log(`         body : ${compact(h.postData, 300)}`);
  }
};

// ── A. 订单页：枚举筛选控件 ─────────────────────────────────────
console.log("\n── A. 订单页筛选控件枚举 ──");
await cdp.send("Page.navigate", { url: ORDER_PAGE });
await new Promise((r) => setTimeout(r, 16_000));
const markA = seen.length;

const controls = await evaluate(
  cdp,
  `(() => {
     const re = /近\\s*\\d+\\s*[天日]|昨日|昨天|今日|今天|本周|上周|本月|上月|自定义|时间|日期|筛选/;
     const out = [];
     for (const e of document.querySelectorAll('button,a,span,div,li,label,input')) {
       if (!e.offsetParent) continue;
       const t = (e.textContent || e.placeholder || e.value || '').trim();
       if (t && t.length <= 12 && re.test(t)) out.push(t);
     }
     return [...new Set(out)].slice(0, 60);
   })()`,
);
console.log(`   含时间语义的可见控件: ${JSON.stringify(controls)}`);

const dateInputs = await evaluate(
  cdp,
  `(() => [...document.querySelectorAll('input')]
       .filter(e => e.offsetParent)
       .map(e => ({ ph: e.placeholder || '', val: e.value || '', cls: (e.className||'').toString().slice(0,50) }))
       .filter(o => o.ph || o.val).slice(0, 25))()`,
);
console.log(`   可见输入框: ${JSON.stringify(dateInputs).slice(0, 700)}`);

// ── B. 经营分析页：录它自己的请求 ───────────────────────────────
console.log("\n── B. 经营分析页请求录制 ──");
const markB = seen.length;
await cdp.send("Page.navigate", { url: ANALYSIS_PAGE });
await new Promise((r) => setTimeout(r, 20_000));
console.log(`   页面: ${compact(await evaluate(cdp, "location.href + ' | ' + document.title"), 150)}`);
dumpNew(markB, "经营分析页加载时");

// ── C. 用正确 URL 重测 core ─────────────────────────────────────
console.log("\n── C. manageHome/core 正确重测（含 multiProjectedIncome） ──");

const result = await evaluate(
  cdp,
  `(async () => {
     const out = [];
     const qs = (o) => new URLSearchParams(o).toString();   // ⭐ 不再手拼 query

     const base = {
       ignoreSetRouterProxy: 'true',
       businessType: '1', storeType: '2', cityId: '', labelId: '',
       compareBeginTime: '', compareEndTime: '',
     };

     for (const dt of ['realTime', 'history', 'yesterday', 'today', 'range', '7', '30']) {
       const url = '/api/page/bizdata/manageHome/multi/o/core?' + qs({
         ...base, dateType: dt,
         beginTime: '${ymd(-DAYS)}', endTime: '${ymd(-1)}',
       });
       const t0 = Date.now();
       try {
         const r = await fetch(url, { credentials: 'include' });
         const j = await r.json().catch(() => null);
         out.push({ dt, status: r.status, ms: Date.now() - t0, json: j });
       } catch (e) { out.push({ dt, error: String(e).slice(0, 120) }); }
     }

     // 老版基础数据接口，也按区间试一遍
     for (const dt of ['realTime', 'history']) {
       const url = '/api/page/bizdata/manageHome/multi/o/data?' + qs({
         ignoreSetRouterProxy: 'true', pageItemCode: 'PITEM101',
         businessType: '1', storeType: '2', dateType: dt,
         beginTime: '${ymd(-DAYS)}', endTime: '${ymd(-1)}',
       });
       try {
         const r = await fetch(url, { credentials: 'include' });
         const j = await r.json().catch(() => null);
         out.push({ dt: 'data/' + dt, status: r.status, json: j });
       } catch (e) { out.push({ dt: 'data/' + dt, error: String(e).slice(0, 120) }); }
     }
     return out;
   })()`,
  { timeoutMs: 180_000 },
);

const findKeys = (o, pred, path = "", acc = {}) => {
  if (!o || typeof o !== "object" || path.split(".").length > 6) return acc;
  for (const [k, v] of Object.entries(o)) {
    const p = path + k;
    if (pred(k.toLowerCase())) acc[p] = v && typeof v === "object" ? JSON.stringify(v).slice(0, 80) : v;
    findKeys(v, pred, p + ".", acc);
  }
  return acc;
};

for (const r of result) {
  console.log(`\n   ▸ dateType=${r.dt}   ${r.error ? "ERR" : `HTTP ${r.status} ${r.ms ?? ""}ms`}`);
  if (r.error) { console.log(`        ${r.error}`); continue; }
  const msg = r.json?.message ?? r.json?.msg;
  if (msg && r.json?.code !== 0 && r.json?.code !== 200 && String(msg).length > 2) {
    console.log(`        ⛔ ${compact(msg, 160)}`);
    continue;
  }
  const hits = findKeys(r.json, (k) => /projectedincome|settleincome|dealamount|cancel|validorder|merchantsubsidy/.test(k));
  const entries = Object.entries(hits);
  if (!entries.length) {
    console.log(`        （无相关字段）顶层键: ${r.json && typeof r.json === "object" ? Object.keys(r.json).slice(0, 10).join(", ") : typeof r.json}`);
    continue;
  }
  for (const [k, v] of entries) console.log(`        ${k} = ${compact(JSON.stringify(v), 110)}`);
}

dumpNew(markA, "订单页交互期间");

console.log("\n════════════════════════════════════════════════════════════");
console.log(`基准：${acct.label} 近${DAYS}天预计收入 ≈ ${BASELINE} 元（逐单求和，2026-09-18）`);
console.log("判定：候选接口的值必须落到这个量级才算「平台有现成聚合入口」。");
console.log("      字段名像不算数 —— multiProjectedIncome 就是「名字在、值恒为 null」的先例。");
console.log(`      本轮用了 URLSearchParams 拼 query，第一轮那种拼串 bug 不会再犯。`);

await cdp.close();
