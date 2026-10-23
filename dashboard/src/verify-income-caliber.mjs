/**
 * 口径对账：平台的 fixTimeChart 逐日「预计收入」 vs 我逐单求和出来的逐日值。
 *   node src/verify-income-caliber.mjs [--account=quanyi]
 *
 * 背景：经营者指出经营首页有近7天/近30天入口（在**同源 iframe** 里，我先前漏了）。
 *   实测 dateType=last_30_days 时：
 *     core.multiProjectedIncome.amount  = 117,947.25
 *     fixTimeChart.data.multiProjectedIncome = [{axis:"20260822",dataValue:"5041.89"}, ...]
 *
 * ⚠️ 不能拿 117,947 跟记忆里的 121,869 直接比 —— 那是 09-18 按当时近30天算的，
 *   **窗口不同**。必须**逐日同天对比**才能分清是「窗口差」还是「口径差」。
 *
 * 判据：同一天两边差 0.00 → 口径一致，平台的聚合可以直接替代逐单翻页。
 *       若系统性差一个比例 → 口径不同，得记录清楚差在哪。
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

const file = join(ROOT, "data", "raw", `income-orderlist-${acct.key}.json`);
if (!existsSync(file)) {
  console.error(`缺逐单基准文件 ${file}`);
  console.error(`  先跑：node src/legacy/fetch-meituan-income-orderlist.mjs --account=${acct.key}`);
  console.error(`  （旧实现已固化到 src/legacy/，它就是基准来源）`);
  process.exit(1);
}
const local = JSON.parse(readFileSync(file, "utf8"));
console.log(`══ 口径对账  ${acct.label} ══`);
console.log(`   本地逐单文件: ${file}`);
console.log(`   fetchedAt: ${local.fetchedAt}   selfCheck: ${JSON.stringify(local.selfCheck)}`);
console.log(`   daily 天数: ${local.daily?.length}`);

const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 2500));
await cdp.send("Page.navigate", { url: TARGET });
await new Promise((r) => setTimeout(r, 28_000));

const plat = await evaluate(
  cdp,
  `(async () => {
     const qs = (o) => new URLSearchParams(o).toString();
     const pad = (n) => String(n).padStart(2, '0');
     const d = (off) => { const t = new Date(Date.now() + off * 86400000); return t.getFullYear() + pad(t.getMonth()+1) + pad(t.getDate()); };
     const w = { dateType: 'last_30_days', beginTime: d(-30), endTime: d(-1), compareBeginTime: d(-60), compareEndTime: d(-31) };
     const common = { ignoreSetRouterProxy: 'true', businessType: '1', storeType: '2', cityId: '', labelId: '' };
     const url = '/api/page/bizdata/manageHome/multi/o/fixTimeChart?' + qs({ ...common, ...w });
     const r = await fetch(url, { credentials: 'include' });
     const j = await r.json().catch(() => null);
     return { win: w, json: j };
   })()`,
  { timeoutMs: 180_000 },
);

const D = plat?.json?.data ?? {};
const asMap = (arr) => {
  const m = new Map();
  for (const it of arr ?? []) {
    if (!it?.axis) continue;
    const ymd = String(it.axis).replace(/-/g, "");
    m.set(ymd, Number(it.dataValue));
  }
  return m;
};

console.log(`   平台窗口: ${plat?.win?.beginTime} ~ ${plat?.win?.endTime}`);
console.log(`   平台 code/msg: ${plat?.json?.code} / ${plat?.json?.msg}`);

const pIncome = asMap(D.multiProjectedIncome);
const pDeal = asMap(D.multiDealAmount);
const pVolume = asMap(D.multiTransactionVolume);
console.log(`   平台返回天数: 预计收入 ${pIncome.size} · 成交额 ${pDeal.size} · 成交订单量 ${pVolume.size}`);

const lIncome = new Map();
const lVolume = new Map();
for (const d of local.daily ?? []) {
  const ymd = String(d.date).replace(/-/g, "");
  lIncome.set(ymd, Number(d.projectedIncome));
  lVolume.set(ymd, Number(d.validOrderCount));
}

const fmt = (n, w = 12) => (n == null || Number.isNaN(n) ? "—" : n.toFixed(2).padStart(w));

console.log("");
console.log("   日期       平台预计收入     逐单预计收入        差额      平台成交额   平台订单量  逐单订单量");
console.log("   " + "─".repeat(96));
const days = [...pIncome.keys()].sort();
let bothDays = 0, maxAbsDiff = 0, sumP = 0, sumL = 0, volDiffDays = 0;
for (const ymd of days) {
  const p = pIncome.get(ymd);
  const l = lIncome.get(ymd);
  const diff = l == null ? null : p - l;
  if (l != null) {
    bothDays++;
    sumP += p; sumL += l;
    if (Math.abs(diff) > maxAbsDiff) maxAbsDiff = Math.abs(diff);
  }
  const pv = pVolume.get(ymd), lv = lVolume.get(ymd);
  if (pv != null && lv != null && pv !== lv) volDiffDays++;
  console.log(
    `   ${ymd}  ${fmt(p)}  ${fmt(l)}  ${diff == null ? "        (无)" : (diff >= 0 ? "+" : "") + diff.toFixed(2).padStart(10)}  ${fmt(pDeal.get(ymd), 10)}  ${String(pv ?? "—").padStart(9)}  ${String(lv ?? "—").padStart(10)}`,
  );
}

console.log("");
console.log(`   重叠天数: ${bothDays}`);
console.log(`   平台合计: ${sumP.toFixed(2)}`);
console.log(`   逐单合计: ${sumL.toFixed(2)}`);
console.log(`   合计差额: ${(sumP - sumL).toFixed(2)}`);
console.log(`   单日最大绝对差: ${maxAbsDiff.toFixed(2)}`);
console.log(`   订单量不一致的天数: ${volDiffDays}`);
console.log("");
console.log(maxAbsDiff < 0.01 && volDiffDays === 0
  ? "   ✅ 口径完全一致 —— 平台的聚合可直接替代逐单翻页。"
  : "   ⚠️ 存在差异，看上面逐日明细判断是系统性口径差还是个别天。");

await cdp.close();
