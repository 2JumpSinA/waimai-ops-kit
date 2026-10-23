/**
 * 把旧的「逐单翻页」实现固化到 src/legacy/ 下，输出改成 income-orderlist-<key>.json。
 * 目的：它是**逐单基准**，改成平台聚合后要用它做口径对账（见 src/compare-income.mjs）。
 * 用法：node src/legacy/_make-orderlist-version.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SRC = join(ROOT, "src", "fetch-meituan-income.mjs");
const OUTDIR = join(ROOT, "src", "legacy");
const OUT = join(OUTDIR, "fetch-meituan-income-orderlist.mjs");

if (!existsSync(SRC)) { console.error(`缺 ${SRC}`); process.exit(1); }
mkdirSync(OUTDIR, { recursive: true });

let code = readFileSync(SRC, "utf8");

// 输出文件名换掉，免得覆盖新实现的结果
const before = code;
code = code.replace(
  /const OUT = dataPath\(acct, "income"\);/,
  'const OUT = dataPath(acct, "income-orderlist");',
);
if (code === before) {
  console.error("没找到 OUT 定义，未做替换 —— 请检查源码");
  process.exit(1);
}

// 修正相对路径：新文件在 src/legacy/ 下，lib 的相对路径要多退一层
code = code.replace(/(from\s+")\.\/(lib\/[^"]+")/g, '$1../$2');

const header = `/**
 * ⚠️ 这是**旧实现**的固化副本：订单列表逐单翻页求和。
 *   已被 src/fetch-meituan-income.mjs（平台聚合）取代。
 *   保留原因：它是**逐单基准**，用于口径对账（src/compare-income.mjs）。
 *   输出：data/raw/income-orderlist-<account>.json（不覆盖新实现的结果）
 *
 * 由 src/legacy/_make-orderlist-version.mjs 生成，请勿手改。
 */
`;

writeFileSync(OUT, header + code, "utf8");
console.log(`✅ 已生成 ${OUT}`);
console.log(`   输出改名为 income-orderlist-<key>.json`);
console.log(`   相对 import 已改成 ../lib/...`);
