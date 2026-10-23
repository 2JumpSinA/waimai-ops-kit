/**
 * 第四轮：枚举合法的 dateType，并用正确参数重测 core，看 multiProjectedIncome 到底有没有值。
 *   node src/probe-datetype.mjs [--account=quanyi]
 *
 * 为什么需要这一轮：
 *   reference 3.10.1 只证明了 `dateType=realTime` 下 `multiProjectedIncome` 为 null。
 *   「历史区间下也是 null」**尚未证明** —— 而这正是「平台有没有现成 7天/30天 收入入口」的关键。
 *   若能拿到非 null 的预计收入，就能一次调用替代 69 页逐单翻页。
 *
 * 技巧：`/api/page/bizdata/manageHome/latestTime?dateType=X` 会**校验** X。
 *       用它当合法性探针，比猜快得多。
 *
 * ⚠️ `core` 的 `compareBeginTime`/`compareEndTime` 是**必填**（第三轮踩过：
 *    留空报「参数错误：对比时间错误」，六个变体全废）。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;
const DAYS = 30;
const BASELINE = acct.key === "quanyi" ? "121,869" : "84,845";

const ANALYSIS = "https://yiyao.meituan.com/main/frame#/page/analysis/home/o2o";

const iso = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};
const ymd = (o = 0) => iso(o).replace(/-/g, "");
const compact = (v, n = 200) => (v == null ? "(null)" : String(v).replace(/\s+/g, " ").slice(0, n));

const CANDIDATES = [
  "realTime", "history", "yesterday", "today", "todayRealTime",
  "7", "30", "7day", "30day", "7days", "30days",
  "week", "month", "recent7", "recent30", "recent7Day", "recent30Day",
  "last7", "last30", "custom", "range", "day", "date", "normal", "past",
];

console.log(`══ 第四轮  账号 ${acct.label}  端口 ${PORT} ══`);
console.log(`   今天=${iso(0)}  近${DAYS}天=${iso(-DAYS)} ~ ${iso(-1)}  基准 ≈ ${BASELINE} 元`);

const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: ANALYSIS });
await new Promise((r) => setTimeout(r, 15_000));
console.log(`   落地: ${compact(await evaluate(cdp, "location.href"), 120)}\n`);

const out = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const probe = [${CANDIDATES.map((c) => `'${c}'`).join(",")}];
     const legacy = [];

     // ── dateType 合法性探针 ──
     for (const dt of probe) {
       const url = '/api/page/bizdata/manageHome/latestTime?' + qs({
         ignoreSetRouterProxy: 'true', dateType: dt,
         'test[businessType]': '1', 'test[storeType]': '2', 'test[cityId]': '', 'test[labelId]': '',
       });
       try {
         const r = await fetch(url, { credentials: 'include' });
         const j = await r.json().catch(() => null);
         legacy.push({ dt, code: j?.code, msg: String(j?.msg ?? j?.message ?? '').slice(0, 90), data: j?.data ?? null });
       } catch (e) { legacy.push({ dt, err: String(e).slice(0, 80) }); }
     }

     // ── 用合法 dateType 打 core（对比区间必填）──
     const valid = legacy.filter(x => x.code === 0 || x.code === 200 || (x.data !== null && x.data !== undefined)).map(x => x.dt);
     const cores = [];
     for (const dt of (valid.length ? valid : ['realTime'])) {
       for (const [tag, b, e] of [
         ['近30天', '${ymd(-DAYS)}', '${ymd(-1)}'],
         ['昨日',   '${ymd(-1)}',   '${ymd(-1)}'],
       ]) {
         const url = '/api/page/bizdata/manageHome/multi/o/core?' + qs({
           ignoreSetRouterProxy: 'true', businessType: '1', storeType: '2', cityId: '', labelId: '',
           dateType: dt, beginTime: b, endTime: e,
           compareBeginTime: '${ymd(-DAYS - 1)}', compareEndTime: '${ymd(-2)}',
         });
         try {
           const r = await fetch(url, { credentials: 'include' });
           const j = await r.json().catch(() => null);
           cores.push({ dt, tag, code: j?.code, msg: String(j?.msg ?? j?.message ?? '').slice(0, 90), data: j?.data ?? null });
         } catch (e) { cores.push({ dt, tag, err: String(e).slice(0, 80) }); }
       }
     }
     return { legacy, valid, cores };
   })()`,
  { timeoutMs: 180_000 },
);

console.log("── dateType 合法性探针（latestTime） ──");
for (const x of out.legacy) {
  const ok = x.code === 0 || x.code === 200;
  console.log(`   ${ok ? "✅" : "  "} ${String(x.dt).padEnd(14)} code=${x.code ?? "?"}  ${compact(x.msg ?? x.err, 80)}${x.data != null ? "  data=" + compact(JSON.stringify(x.data), 60) : ""}`);
}
console.log(`\n   合法 dateType: ${JSON.stringify(out.valid)}`);

const findKeys = (o, pred, path = "", acc = {}) => {
  if (!o || typeof o !== "object" || path.split(".").length > 6) return acc;
  for (const [k, v] of Object.entries(o)) {
    const p = path + k;
    if (pred(k.toLowerCase())) acc[p] = v;
    findKeys(v, pred, p + ".", acc);
  }
  return acc;
};

console.log("\n── core 重测（对比区间已填） ──");
for (const c of out.cores) {
  console.log(`\n   ▸ dateType=${c.dt}  ${c.tag}   code=${c.code ?? "?"}  ${c.err ? c.err : ""}`);
  if (c.msg) console.log(`      msg: ${compact(c.msg, 120)}`);
  if (!c.data) continue;
  const hits = findKeys(c.data, (k) => /projectedincome|settleincome|dealamount|merchantsubsidy|tradeamount|income/.test(k));
  const e = Object.entries(hits);
  if (!e.length) { console.log(`      （无收入类字段）顶层: ${Object.keys(c.data).slice(0, 12).join(", ")}`); continue; }
  for (const [k, v] of e) {
    console.log(`      ${k} = ${compact(v && typeof v === "object" ? JSON.stringify(v) : v, 120)}`);
  }
}

console.log("\n════════════════════════════════════════════════════════════");
console.log(`基准：${acct.label} 近${DAYS}天预计收入 ≈ ${BASELINE} 元`);
console.log("结论判据：");
console.log("  · 任一 multiProjectedIncome 非 null 且落在这个量级 → 平台有现成聚合入口，可弃用逐单翻页");
console.log("  · 全为 null / 或只有 multiDealAmount（成交额）→ 逐单是唯一能拿到「预计收入」口径的路");
await cdp.close();
