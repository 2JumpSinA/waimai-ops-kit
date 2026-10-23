/**
 * 摸清 flowTransformation 的脾气：多日窗口要不要重试？单日逐个取再求和是否等值？
 *   node src/probe-flow-window.mjs [--account=quanyi]
 *
 * 已知（2026-09-21）：
 *   · recentDays=1 → 一次调用给平台总曝光（FLOW_POI_EXPOSE_UV/PV），与流量分析页显示一致
 *   · recentDays=7 / 30 → `code=100 数据处理中请耐心等待`（平台按需计算多日窗口）
 *
 * 要回答：
 *   (a) 多日窗口**重试几次**能不能出来？
 *   (b) 若不能，**逐个单日取再求和**是否可行、要几次调用、与 7 日窗口是否等值？
 *   (c) 窗口语义：recentDays=1 的 current 是"今天"还是"昨天"？
 *
 * 只读，不落盘。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const STEM = acct.key === "quanyi" ? "meituan" : `meituan-${acct.key}`;
const { cookies: CK } = await loadCookieSmart({ stem: STEM, port: acct.port, host: "yiyao.meituan.com", required: ["token", "acctId"] });
const ACCT_ID = String(CK.acctId ?? "");
const compact = (v, n = 160) => (v == null ? "(null)" : String(v).replace(/\s+/g, " ").slice(0, n));

const cdp = await connectToPage(acct.port);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 1200));
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame#/page/recoanalysis/pc#traffic" });
await new Promise((r) => setTimeout(r, 22_000));
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 90_000 }).catch(() => ({}));
console.log(`账号 ${acct.label}  acctId=${ACCT_ID}`);

/**
 * ⚠️ 日期要在 **Node 侧**算好再插进模板字符串。
 *    我第一版把 `${'$'}{day(-7)}` 写在 Node 的模板里，而 `day` 只定义在**页面**作用域，
 *    Node 解析模板时就 ReferenceError: day is not defined。
 *    两个作用域别混。
 */
const pad2 = (n) => String(n).padStart(2, "0");
const ymdOf = (off) => {
  const t = new Date(Date.now() + off * 86400_000);
  return `${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}`;
};
const D7B = ymdOf(-7), DM1 = ymdOf(-1), D30B = ymdOf(-30);

/** 在页内一次性跑完所有调用（少往返） */
const out = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const pad = (n) => String(n).padStart(2, '0');
     const day = (off) => { const t = new Date(Date.now() + off * 86400_000); return t.getFullYear() + pad(t.getMonth()+1) + pad(t.getDate()); };
     const call = async (begin, end, days) => {
       const cEnd = (() => { const d = new Date(end.slice(0,4)+'-'+end.slice(4,6)+'-'+end.slice(6,8)); d.setDate(d.getDate()-1); return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate()); })();
       const cBegin = (() => { const d = new Date(begin.slice(0,4)+'-'+begin.slice(4,6)+'-'+begin.slice(6,8)); d.setDate(d.getDate()-1); return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate()); })();
       const url = '/api/page/recoanalysis/flowAnalysisV5/recentDays/flowTransformation?' + qs({
         ignoreSetRouterProxy:'true', acctId:'${ACCT_ID}', cityIds:'0', source:'0', wmPoiId:'-1',
         beginTime: begin, endTime: end, recentDays: String(days),
         compareBeginTime: cBegin, compareEndTime: cEnd,
       });
       const r = await fetch(url, { credentials: 'include' });
       const j = await r.json().catch(() => null);
       const arr = Array.isArray(j?.data) ? j.data : [];
       const pick = (idx) => { const o = arr.find(x => x.index === idx); return o ? { current: o.current, ring: o.ring, date: o.date } : null; };
       return { begin, end, days, code: j?.code, msg: j?.msg, uv: pick('FLOW_POI_EXPOSE_UV'), pv: pick('FLOW_POI_EXPOSE_PV') };
     };

     // (a) 多日窗口重试
     const retries = [];
     for (let i = 1; i <= 4; i++) {
       retries.push(await call('${D7B}', '${DM1}', 7));
       if (retries[retries.length-1].code === 0) break;
       await new Promise(r => setTimeout(r, 5000));
     }

     // (b) 逐个单日（近7天，含今天）
     const dailies = [];
     for (let off = -6; off <= 0; off++) {
       const d = day(off);
       dailies.push(await call(d, d, 1));
       await new Promise(r => setTimeout(r, 400));
     }
     // (c) 30 天窗口重试
     const r30 = [];
     for (let i = 1; i <= 3; i++) {
       r30.push(await call('${D30B}', '${DM1}', 30));
       if (r30[r30.length-1].code === 0) break;
       await new Promise(r => setTimeout(r, 5000));
     }
     return { retries, dailies, r30 };
   })()`,
  { timeoutMs: 240_000 },
);

console.log("\n══ (a) recentDays=7 重试 ══");
for (const [i, r] of out.retries.entries()) {
  console.log(`  第${i + 1}次 code=${r.code} msg=${compact(r.msg, 40)}  uv=${compact(JSON.stringify(r.uv), 90)}`);
}

console.log("\n══ (b) 逐个单日（近7天，含今天）══");
let sumUv = 0, sumPv = 0;
for (const r of out.dailies) {
  const uv = r.uv?.current ?? 0, pv = r.pv?.current ?? 0;
  sumUv += uv; sumPv += pv;
  console.log(`  ${r.begin}  code=${r.code}  ${compact(r.msg, 20)}  曝光人数 ${uv}  次数 ${pv}   (date=${compact(r.uv?.date, 24)})`);
}
console.log(`  ── 7 个单日求和：曝光人数 ${sumUv}   曝光次数 ${sumPv}`);

console.log("\n══ (c) recentDays=30 重试 ══");
for (const [i, r] of out.r30.entries()) {
  console.log(`  第${i + 1}次 code=${r.code} msg=${compact(r.msg, 40)}  uv=${compact(JSON.stringify(r.uv), 90)}`);
}

console.log("\n════ 判读 ════");
console.log("  · 若 7 日窗口重试后能出 → 用窗口(1 次调用)");
console.log("  · 若始终 code=100 → 用「逐个单日再求和」，近30天=30 次调用（仍远优于逐店 136 次）");
console.log("  · 单日 current 的 date 字段能告诉我们窗口到底是哪一天");

await cdp.close();
