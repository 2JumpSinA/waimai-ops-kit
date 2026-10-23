/**
 * 决定性验证：平台按 last_7_days / last_30_days 到底给不给「预计收入」。
 *   node src/probe-last-days.mjs [--account=quanyi]
 *
 * 背景（前情）：
 *   我连错两次。第一次拼 query 少了个 &，六个 dateType 全废；
 *   第二次猜的 dateType 名字（7days/30days/last7/recent30…）**全不对**，
 *   真正的值是 **last_7_days / last_30_days**，而且控件在**同源 iframe** 里，
 *   顶层 document 查不到 —— 经营者说「7天/30天入口就在这个页面下」是对的。
 *
 * 本轮判据（数值，不看字段名）：
 *   · 品牌A 近30天 预计收入基准 ≈ 121,869 元（逐单求和，2026-09-18）
 *   · 品牌A 近7天  预计收入基准见 income-*.json 的 d7
 *   若 multiProjectedIncome 落在这附近 → 平台确有聚合入口，逐单翻页可以退休。
 *
 * 同时测 trendChart + moduleType=multiProjectedIncome：
 *   若它按天返回，则连「30 天逐日趋势」都不用逐单了。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acct = resolveAccount(process.argv);
const PORT = acct.port;
const TARGET = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";
const compact = (v, n = 160) => (v == null ? "null" : String(v).replace(/\s+/g, " ").slice(0, n));

const findKeys = (o, pred, path = "", acc = {}) => {
  if (!o || typeof o !== "object" || path.split(".").length > 7) return acc;
  for (const [k, v] of Object.entries(o)) {
    const p = path + k;
    if (pred(k.toLowerCase())) acc[p] = v;
    findKeys(v, pred, p + ".", acc);
  }
  return acc;
};

const saysIf = (k) => /projectedincome|settleincome|dealamount|merchantsubsidy|transactionvolume|averageprice/.test(k);

console.log(`══ 决定性验证  账号 ${acct.label}  端口 ${PORT} ══`);

// 本地逐单基准
const incFile = join(ROOT, "data", "raw", `income-${acct.key}.json`);
if (existsSync(incFile)) {
  try {
    const inc = JSON.parse(readFileSync(incFile, "utf8"));
    const w = inc.summary ?? inc;
    console.log("   本地逐单基准（上次抓的 income-*.json）:");
    for (const [k, v] of Object.entries(w)) {
      if (v && typeof v === "object" && ("预计收入" in v || "income" in v || "projectedIncome" in v)) {
        console.log(`      ${k}: ${compact(JSON.stringify(v), 200)}`);
      }
    }
  } catch (e) { console.log(`   （读基准失败: ${e.message}）`); }
} else {
  console.log(`   （没有 ${incFile}，只能靠记忆里的 121,869 作参考）`);
}

const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 2500));
await cdp.send("Page.navigate", { url: TARGET });
await new Promise((r) => setTimeout(r, 28_000));

// 先把 iframe 里的「近30天」点一下，让应用状态和签名链路都热起来
const clicked = await evaluate(
  cdp,
  `(() => {
     const f = document.querySelectorAll('iframe')[0];
     const doc = f && f.contentDocument;
     if (!doc) return { ok: false };
     const c = [...doc.querySelectorAll('button,span,li,div')]
       .filter(e => e.offsetParent && /^\\s*近\\s*30\\s*天\\s*$/.test(e.textContent || ''));
     if (c.length) { c[0].click(); return { ok: true }; }
     return { ok: false };
   })()`,
);
console.log(`   预热（点 iframe 内近30天）: ${JSON.stringify(clicked)}`);
await new Promise((r) => setTimeout(r, 12_000));

const out = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const pad = (n) => String(n).padStart(2, '0');
     const d = (off) => { const t = new Date(Date.now() + off * 86400000); return t.getFullYear() + pad(t.getMonth()+1) + pad(t.getDate()); };
     const end = d(-1);            // 近N天 = 截止昨天
     const b7 = d(-7),  c7e = d(-8),  c7b = d(-14);
     const b30 = d(-30), c30e = d(-31), c30b = d(-60);

     const WINDOWS = [
       { tag: '近7天',  dateType: 'last_7_days',  beginTime: b7,  endTime: end, compareBeginTime: c7b,  compareEndTime: c7e },
       { tag: '近30天', dateType: 'last_30_days', beginTime: b30, endTime: end, compareBeginTime: c30b, compareEndTime: c30e },
     ];
     const common = { ignoreSetRouterProxy: 'true', businessType: '1', storeType: '2', cityId: '', labelId: '' };

     const GETS = [
       '/api/page/bizdata/manageHome/multi/o/core',
       '/api/page/bizdata/manageHome/multi/o/overview',
       '/api/page/bizdata/manageHome/orderDeal/trendChart',
       '/api/page/bizdata/manageHome/multi/o/fixTimeChart',
       '/api/page/bizdata/manageHome/multi/o/deal/module',
       '/api/page/bizdata/manageHome/multi/o/flow/module',
     ];

     const res = [];
     const call = async (name, url, init) => {
       try {
         const r = await fetch(url, { credentials: 'include', ...(init || {}) });
         const j = await r.json().catch(() => null);
         res.push({ name, status: r.status, json: j });
       } catch (e) { res.push({ name, error: String(e).slice(0, 100) }); }
     };

     for (const w of WINDOWS) {
       for (const g of GETS) {
         const extra = g.includes('trendChart') ? { moduleType: 'multiProjectedIncome' } : {};
         await call(w.tag + ' ' + g.split('/').pop(), g + '?' + qs({ ...common, ...w, ...extra }));
       }
       // 逐店明细：moduleTypes 明确要预计收入
       await call(w.tag + ' poi/detail', '/api/page/bizdata/manageHome/multi/store/poi/detail?' + qs({
         ignoreSetRouterProxy: 'true',
       }), {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           pageNum: 1, pageSize: 5, moduleTypes: 'multiProjectedIncome,multiDealAmount',
           businessType: 1, storeType: 2, cityId: '', labelId: '',
           dateType: w.dateType, beginTime: w.beginTime, endTime: w.endTime,
           compareBeginTime: w.compareBeginTime, compareEndTime: w.compareEndTime,
         }),
       });
     }
     return res;
   })()`,
  { timeoutMs: 180_000 },
);

console.log("");
for (const r of out) {
  console.log(`\n▸ ${r.name}   ${r.error ? "ERR " + r.error : "HTTP " + r.status}`);
  if (!r.json) continue;
  const msg = r.json.msg ?? r.json.message;
  if (msg && String(msg).length > 2 && r.json.code !== 0) { console.log(`   ⛔ ${compact(msg, 120)}`); continue; }
  const hits = findKeys(r.json, saysIf);
  const e = Object.entries(hits);
  if (!e.length) {
    const top = r.json.data && typeof r.json.data === "object" ? Object.keys(r.json.data).slice(0, 12) : Object.keys(r.json).slice(0, 8);
    console.log(`   （无收入类字段）顶层: ${top.join(", ")}`);
    continue;
  }
  for (const [k, v] of e.slice(0, 20)) {
    const s = v && typeof v === "object" ? JSON.stringify(v) : v;
    console.log(`   ${k} = ${compact(s, 150)}`);
  }
}

console.log("\n════════════════════════════════════════════════════════════");
console.log("判据：multiProjectedIncome 若 ≈ 121,869（近30天）→ 平台有聚合入口，逐单翻页可退休。");
console.log("      若 trendChart(moduleType=multiProjectedIncome) 按天返回 → 连逐日都省了。");
await cdp.close();
