/**
 * 台账结构探查：先看清有哪些表、哪些列、未上线原因长什么样。
 *   node src/inspect-plan.mjs
 */
import { readXlsx } from "./lib/xlsx.mjs";

const PATH = "_recon/xlsx/plan.xlsx";
const { sheets } = readXlsx(PATH);

console.log(`共 ${sheets.length} 张表：${sheets.map((s) => s.name).join(" | ")}\n`);

for (const s of sheets) {
  const nonEmpty = s.rows.filter((r) => r && r.some((v) => v !== undefined && v !== ""));
  console.log("═".repeat(70));
  console.log(`  表「${s.name}」  ${s.rows.length} 行（非空 ${nonEmpty.length} 行）`);
  console.log("═".repeat(70));

  // 表头候选：前 4 行里非空单元格最多的那行
  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(4, s.rows.length); i++) {
    const n = (s.rows[i] ?? []).filter((v) => v !== undefined && v !== "").length;
    if (n > best) { best = n; headerIdx = i; }
  }
  console.log(`  表头在第 ${headerIdx + 1} 行：`);
  const header = s.rows[headerIdx] ?? [];
  header.forEach((h, i) => { if (h !== undefined && h !== "") console.log(`    [${i}] ${h}`); });

  // 前 3 条数据
  console.log(`\n  前 3 条数据：`);
  let shown = 0;
  for (let i = headerIdx + 1; i < s.rows.length && shown < 3; i++) {
    const r = s.rows[i] ?? [];
    if (!r.some((v) => v !== undefined && v !== "")) continue;
    const o = {};
    header.forEach((h, c) => { if (h) o[h] = r[c]; });
    console.log(`    ${JSON.stringify(o, null, 0).slice(0, 600)}`);
    shown++;
  }
  console.log();
}
