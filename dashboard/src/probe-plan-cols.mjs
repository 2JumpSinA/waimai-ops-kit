/**
 * 台账列标定：按**列位置**导出关键列的取值分布。
 *   node src/probe-plan-cols.mjs
 *
 * 为什么必须按位置：两表的表头都有重名（品牌B 3 个「店名」、2 个「是否上线」；
 * 品牌A 2 个「评分」「30天订单」「营业状态」），`toObjects` 按名建对象会**后者覆盖前者**，
 * 按名取值会静默拿到错误的列。
 */
import { readXlsx } from "./src/lib/xlsx.mjs";

const { sheets } = readXlsx("_recon/xlsx/plan.xlsx");
const sheet = (n) => sheets.find((s) => s.name === n);
const header = (s) => (s.rows[0] ?? []).map((h) => String(h ?? "").trim());
const body = (s) => s.rows.slice(1).filter((r) => r && r.some((c) => String(c ?? "").trim() !== ""));

const hist = (rows, idx) => {
  const m = new Map();
  for (const r of rows) {
    const k = String(r[idx] ?? "").trim() || "(空)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

function dump(name, cols) {
  const s = sheet(name);
  const h = header(s);
  const rows = body(s);
  console.log(`\n${"═".repeat(74)}`);
  console.log(`  工作表「${name}」  表头 ${h.length} 列，数据行 ${rows.length}`);
  console.log("═".repeat(74));
  console.log("  列索引  列名");
  h.forEach((x, i) => console.log(`   [${String(i).padStart(2)}]   ${x}`));
  for (const i of cols) {
    console.log(`\n  ── [${i}] ${h[i]} ──`);
    const hs = hist(rows, i);
    for (const [k, v] of hs.slice(0, 30)) {
      console.log(`     ${String(v).padStart(4)}  ${k.length > 60 ? k.slice(0, 60) + "…" : k}`);
    }
    if (hs.length > 30) console.log(`     … 另 ${hs.length - 30} 种取值`);
    console.log(`     合计 ${hs.reduce((a, b) => a + b[1], 0)} 行，空值 ${hs.find((x) => x[0] === "(空)")?.[1] ?? 0} 行`);
  }
}

dump("品牌B", [4, 10, 11, 16, 17, 14]);
dump("品牌A", [9, 18, 12, 13]);
