/**
 * 从生成的 dashboard.html 里把内嵌 VM 抠出来，检查关键字段是否齐、是否合理。
 *   node src/inspect-dashboard-vm.mjs [--file=<html>] [--json] [--digest=<out.json>]
 *
 * 用途：build-dashboard 跑完后不打开浏览器也能确认数据落到了看板里
 * （尤其是「逐店 byPoi 回退路径」这种容易静默变空的地方）。
 *
 * ⚠️ 抠 VM / 摘要**一律走 `src/lib/`**，本文件不再自带一份提取实现 ——
 *    历史上这里（括号配平）与 `verify-dashboard.mjs`（脆弱正则）各有一份，
 *    改一处另一处不知道，而它们校验的是同一份产物。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlProfile } from "./lib/dashboard-digest.mjs";
import { derivedDigest, stableJson } from "./lib/dashboard-digest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const FILE = resolve(ROOT, arg("file", "dashboard.html"));
const html = readFileSync(FILE, "utf8");
const prof = htmlProfile(html);
if (!prof.hasVm) { console.error(`⛔ ${FILE} 里没有可解析的内联 VM：${prof.vmError}`); process.exit(1); }
const VM = prof.vm;

console.log(`文件        ${FILE}`);
console.log(`generatedAt = ${VM.generatedAt}`);
console.log(`项目        = ${(VM.projectOrder ?? []).join(", ")}`);
console.log(`顶层键      = ${Object.keys(VM).join(", ")}`);

for (const key of VM.projectOrder ?? Object.keys(VM.projects ?? {})) {
  const p = VM.projects[key];
  if (!p) continue;
  const inc = p.income ?? {};
  const d7 = inc.byPoiD7 ?? [];
  const d30 = inc.byPoiD30 ?? [];
  console.log(`\n════ ${p.label} (${key}) ════`);
  console.log(`  dataTime        ${p.dataTime}`);
  console.log(`  warnings        ${(p.warnings ?? []).length}`);
  console.log(`  收入窗口        ${Object.keys(inc.windows ?? {}).join(", ") || "(无)"}`);
  console.log(`  逐日天数        ${(inc.daily ?? []).length}`);
  console.log(`  byPoiD7         ${d7.length} 家`);
  console.log(`  byPoiD30        ${d30.length} 家`);
  console.log(`  highCancelD7    ${(p.highCancelD7 ?? []).length} 家`);
  console.log(`  highCancelD30   ${(p.highCancelD30 ?? []).length} 家`);
  console.log(`  crossCheck      ${(inc.crossCheck ?? []).length} 项`);
  console.log(`  selfCheck       ${JSON.stringify(inc.selfCheck ?? null).slice(0, 120)}`);
  console.log(`  收入口径        ${inc.caliber ?? "(无)"}`.slice(0, 150));

  const w = inc.windows ?? {};
  for (const k of ["today", "yesterday", "d7", "d30"]) {
    const x = w[k];
    if (!x) { console.log(`    ${k.padEnd(10)} (缺)`); continue; }
    console.log(`    ${k.padEnd(10)} 订单 ${String(x.orderCount).padStart(6)}  收入 ${String(x.projectedIncome).padStart(10)}  取消 ${String(x.cancelCount).padStart(4)} (${x.cancelRate}%)  来源 ${x.source ?? "?"}`);
  }

  /**
   * ⭐ 看板**渲染用的**派生窗口（`p.windows`），也就是 KPI 卡片的真正数据源。
   *    推广占比在这里算出来 —— 直接从 VM 读，比从 income/ka 两个原始 JSON 猜字段可靠得多
   *    （先前写临时脚本去猜 `ka.results[].cost` 的字段名，猜错了）。
   */
  const pw = p.windows ?? {};
  console.log(`  ── 派生窗口（KPI 数据源）──`);
  for (const k of ["today", "yesterday", "d7", "d30"]) {
    const x = pw[k];
    if (!x) { console.log(`    ${k.padEnd(10)} (缺)`); continue; }
    const ratio = x.promoRatio == null ? "—" : x.promoRatio + "%";
    console.log(
      `    ${k.padEnd(10)} 收入 ${String(x.projectedIncome).padStart(10)}  推广消耗 ${String(x.promoCost ?? "—").padStart(9)}` +
        `  推广占比 ${ratio.padStart(7)}  ROI ${x.promoRoi ?? "—"}  口径来源 ${x.projectedIncomeSource ?? "?"}`,
    );
  }

  // 逐店条目的形状检查（高取消门店依赖 orders/rate/poiName）
  const bad = d7.filter((x) => x.poiId == null || x.orders == null || x.rate == null);
  console.log(`  byPoiD7 形状异常 ${bad.length} 条`);
  if (d7[0]) console.log(`  byPoiD7 样例    ${JSON.stringify(d7[0])}`);
  const top = (p.highCancelD7 ?? [])[0];
  if (top) console.log(`  高取消样例      ${JSON.stringify(top).slice(0, 160)}`);
}

/**
 * `--digest=<out.json>`：把**规范化派生值摘要**落盘，供阶段对比/回归对比机器 diff。
 * 这也是「结构优化前后派生值逐项对比」的机器基准。
 */
const digestOut = arg("digest", null);
if (digestOut) {
  const out = resolve(ROOT, digestOut);
  writeFileSync(out, stableJson(derivedDigest(VM)), "utf8");
  console.log(`\n派生值摘要已写入 ${out}（${stableJson(derivedDigest(VM)).length} B）`);
}
if (process.argv.includes("--json")) console.log("\n" + JSON.stringify(VM, null, 2));
