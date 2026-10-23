/**
 * 对比「平台聚合」与「逐单基准」的逐日值 —— 口径对账的汇总视图。
 *   node src/compare-income-files.mjs [--account=quanyi|yifeng]
 *
 * 输入（都已在盘上，不需要浏览器）：
 *   data/raw/income-<key>.json            平台聚合（新，src/fetch-meituan-income.mjs）
 *   data/raw/income-orderlist-<key>.json  逐单翻页（旧，src/legacy/...）
 *
 * 为什么要有这个脚本：`verify-income-caliber.mjs` 会**现场重打接口**再比，
 * 适合怀疑数据时用；日常只想看「两条路差多少」时，直接比两个文件更快也更省请求。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const keys = arg("account", "") ? [arg("account")] : ["quanyi", "yifeng"];
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

const read = (k, stem) => {
  const p = join(ROOT, "data", "raw", `${stem}-${k}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
};

for (const k of keys) {
  const plat = read(k, "income");
  const base = read(k, "income-orderlist");
  console.log(`\n════ ${k} ════`);
  if (!plat) { console.log("  ❌ 缺 income-<key>.json（先跑 fetch-meituan-income.mjs）"); continue; }
  if (!base) { console.log("  ⚠️ 缺 income-orderlist-<key>.json（先跑 src/legacy/fetch-meituan-income-orderlist.mjs --only=daily）"); continue; }

  console.log(`  平台 ${plat.fetchedAt}  source=${plat.source ?? "(无)"}`);
  console.log(`  逐单 ${base.fetchedAt}`);
  const gapMin = Math.round((new Date(plat.fetchedAt) - new Date(base.fetchedAt)) / 60000);
  console.log(`  两次抓取相隔 ${Math.abs(gapMin)} 分钟${Math.abs(gapMin) > 120 ? " ⚠️ 跨时较久，差异里会混入时点影响" : "（同批次，差异基本只能是口径）"}`);

  const bm = new Map((base.daily ?? []).map((d) => [d.date, d]));
  const rows = [];
  for (const d of plat.daily ?? []) {
    const b = bm.get(d.date);
    if (!b) continue;
    rows.push({
      date: d.date,
      pInc: d.projectedIncome, bInc: b.projectedIncome,
      dInc: r2((d.projectedIncome ?? 0) - (b.projectedIncome ?? 0)),
      pVol: d.validOrderCount, bVol: b.validOrderCount,
      dVol: (d.validOrderCount ?? 0) - (b.validOrderCount ?? 0),
      pCancel: d.cancelCount, bCancel: b.cancelCount,
    });
  }
  if (!rows.length) { console.log("  ⚠️ 没有可对比的重叠日期"); continue; }

  const exact = rows.filter((r) => Math.abs(r.dInc) < 0.01).length;
  const diffRows = rows.filter((r) => Math.abs(r.dInc) >= 0.01);
  const sumP = r2(rows.reduce((a, r) => a + (r.pInc ?? 0), 0));
  const sumB = r2(rows.reduce((a, r) => a + (r.bInc ?? 0), 0));
  const cancelSame = rows.filter((r) => r.pCancel === r.bCancel).length;
  const volDiff = rows.filter((r) => r.dVol !== 0).length;

  console.log(`\n  日期         平台收入      逐单收入        差额    平台单量 逐单单量  平台取消 逐单取消`);
  console.log("  " + "─".repeat(88));
  for (const r of rows) {
    const mark = Math.abs(r.dInc) < 0.01 ? " " : "•";
    console.log(
      `  ${mark}${r.date}  ${String(r.pInc).padStart(10)}  ${String(r.bInc).padStart(10)}  ` +
      `${(r.dInc >= 0 ? "+" : "") + r.dInc.toFixed(2)}`.padStart(9) +
      `  ${String(r.pVol ?? "—").padStart(8)} ${String(r.bVol ?? "—").padStart(8)}` +
      `  ${String(r.pCancel ?? "—").padStart(8)} ${String(r.bCancel ?? "—").padStart(8)}`,
    );
  }

  const pct = sumB ? (((sumP - sumB) / sumB) * 100).toFixed(3) : "?";
  console.log("");
  console.log(`  重叠天数              ${rows.length}`);
  console.log(`  ⭐ 逐日完全一致        ${exact} / ${rows.length} 天`);
  console.log(`  平台合计              ${sumP}`);
  console.log(`  逐单合计              ${sumB}`);
  console.log(`  合计差                ${r2(sumP - sumB)}  (${pct}%)`);
  console.log(`  单日最大绝对差        ${r2(Math.max(...rows.map((r) => Math.abs(r.dInc))))}`);
  console.log(`  取消单一致的天数      ${cancelSame} / ${rows.length}`);
  console.log(`  订单量不一致的天数    ${volDiff}`);
  if (diffRows.length) {
    console.log(`  有差异的日期          ${diffRows.map((r) => r.date.slice(5)).join(", ")}`);
    const allPos = diffRows.every((r) => r.dInc > 0);
    const allNeg = diffRows.every((r) => r.dInc < 0);
    const dir = allPos ? "全部 平台 > 逐单" : allNeg ? "全部 平台 < 逐单" : "双向";
    console.log(`  差异方向              ${dir}`);
    // ⚠️ 不要无条件打印「方向单一」——双向时那句话是误导（第一版就写死了）
    console.log(
      `\n  判读：逐日大面积到分一致 → 口径相同；差异集中在少数天` +
        (allPos || allNeg
          ? `、方向单一（${dir}）→ 边界/状态归类差，平台的值权威。`
          : `、且方向双向 → 两边都不是对方的超集，多半混入了取数期间的订单变动；` +
            `要看纯口径差请让两次抓取靠得更近。`),
    );
  } else {
    console.log(`\n  判读：逐日全部到分一致 → 两个口径在该窗口内完全等价。`);
  }
}

console.log(`\n说明：本脚本只读盘上的两个 JSON，不发任何请求。`);
