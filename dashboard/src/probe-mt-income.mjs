/**
 * 两条路并查：
 *   A. 订单列表的 `orderInfo` 里有没有单笔「预计收入」
 *   B. 美团经营数据 `manageHome/multi/o/core` 换 dateType 能否出 multiProjectedIncome
 *   node src/probe-mt-income.mjs [--port=9222]
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;

const iso = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};
const ymd = (o = 0) => iso(o).replace(/-/g, "");
const cut = (v, n = 700) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s?.length > n ? s.slice(0, n) + "…" : s; };

const cdp = await connectToPage(PORT);
console.log(`页面：${(await evaluate(cdp, `location.href`)).slice(0, 80)}\n`);

// ── A. orderInfo ──
const aRaw = await evaluate(
  cdp,
  `(async () => {
     const body = new URLSearchParams({
       tag:'history_all',
       pageParam: JSON.stringify({pageSize:3,pageNum:1,sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
       extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
       startDate:'${iso(0)}', endDate:'${iso(0)}',
     });
     const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
     return await r.text();
   })()`,
);
const aJ = JSON.parse(aRaw);
const first = aJ.data?.orderList?.[0] ?? {};
console.log("═══ A. 订单列表 orderInfo ═══");
console.log(`  外层字段: ${JSON.stringify(Object.keys(first))}`);
for (const k of ["orderInfo", "commonInfo"]) {
  const v = first[k];
  if (typeof v !== "string") { console.log(`  ${k}: ${cut(v, 300)}`); continue; }
  try {
    const o = JSON.parse(v);
    console.log(`  ${k} 字段（${Object.keys(o).length}）: ${JSON.stringify(Object.keys(o)).slice(0, 500)}`);
  } catch {
    console.log(`  ${k}（非 JSON 字符串）: ${cut(v, 300)}`);
  }
}
console.log(`\n  全量搜 income/收入: ${/income|收入/i.test(aRaw) ? "✅ 有" : "❌ 无"}`);
if (/income|收入/i.test(aRaw)) {
  const m = [...aRaw.matchAll(/"([\w]*(?:[Ii]ncome|收入)[\w]*)"\s*:\s*([^,}]{1,30})/g)];
  for (const x of m.slice(0, 10)) console.log(`     ${x[1]} = ${x[2]}`);
}

// ── B. 经营数据换 dateType ──
console.log("\n═══ B. manageHome/multi/o/core 换 dateType ═══");
const VARIANTS = ["realTime", "history", "dt", "day", "period", "1", "2"];
for (const dt of VARIANTS) {
  const path =
    `/api/page/bizdata/manageHome/multi/o/core?businessType=1&storeType=2&cityId=&labelId=&dateType=${dt}` +
    `&beginTime=${ymd(0)}&endTime=${ymd(0)}&compareBeginTime=${ymd(-1)}&compareEndTime=${ymd(-1)}`;
  const r = JSON.parse(
    await evaluate(
      cdp,
      `(async () => { const r = await fetch(${JSON.stringify(path)}, {credentials:'include'}); return JSON.stringify({s:r.status, t:(await r.text()).slice(0,900)}); })()`,
    ),
  );
  let keys = "?", proj = "?";
  try {
    const j = JSON.parse(r.t);
    const d = j.data ?? {};
    keys = JSON.stringify(Object.keys(d).slice(0, 6));
    proj = d.multiProjectedIncome === undefined ? "（无此字段）" : cut(d.multiProjectedIncome, 90);
  } catch { keys = r.t.slice(0, 80); }
  console.log(`  dateType=${dt.padEnd(9)} [${r.s}] projIncome=${proj}`);
  if (String(proj).startsWith("{")) break;
  await new Promise((x) => setTimeout(x, 400));
}
await cdp.close();
