/**
 * 核对「预计收入」口径：manageHome/core 的 multiProjectedIncome 是否等于逐单求和。
 *   node src/check-income.mjs [--account=quanyi|yifeng]
 *
 * 背景：用户口径要求看板收入一律用**预计收入**。
 * 逐单求和（fetch-meituan-income.mjs）已验证 = 官方 settleIncome，但慢（要翻订单列表）。
 * 若 core 接口的 multiProjectedIncome 与之相等，看板就用 core（快、且是平台原生字段）。
 */
import { readData, resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const mt = readData(acct, "meituan");
if (!mt) {
  console.error(`没有 data/raw/meituan-${acct.key}.json`);
  process.exit(1);
}

const num = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));
const yuan = (v) => (num(v) / 100).toFixed(2);
const raw = (v) => num(v).toFixed(2);

const core = mt.panels?.overview?.core?.data;

console.log(`════ ${acct.label}（${acct.key}）  取数时间 ${mt.fetchedAt} ════\n`);

if (!core) {
  console.log("overview.core 无数据");
  process.exit(0);
}

console.log("── overview.core 全字段原值 ──");
for (const [k, v] of Object.entries(core)) {
  console.log(`   ${k.padEnd(42)} ${JSON.stringify(v)}`);
}

console.log("\n── 金额类字段的两种量纲解读 ──");
const MONEY = [
  "multiDealAmount", "multiProjectedIncome", "multiSingleAveragePrice",
  "multiRefundAmount", "multiMerchantSubsidyAmount",
  "multiStoreAverageDealAmount", "multiStoreProjectedIncome",
  "multiStoreAverageMerchantSubsidyAmount",
];
for (const k of MONEY) {
  if (core[k] === undefined) continue;
  console.log(`   ${k.padEnd(42)} 原值=${raw(core[k]).padStart(12)}   ÷100=${yuan(core[k]).padStart(12)}`);
}

console.log("\n── 计数类字段 ──");
for (const k of ["multiTransactionVolume", "multiAllRefundOrderQuantity", "multiRefundOrderQuantity"]) {
  if (core[k] !== undefined) console.log(`   ${k.padEnd(42)} ${JSON.stringify(core[k])}`);
}

// 与逐单求和结果对照（若已跑过 fetch-meituan-income）
const inc = readData(acct, "meituan-income");
if (inc) {
  console.log("\n── 对照：逐单求和（fetch-meituan-income）──");
  console.log("   " + JSON.stringify(inc.summary ?? inc).slice(0, 600));
}
