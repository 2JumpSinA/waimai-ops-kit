/**
 * 品牌B门店核对：台账 316 条 vs 美团接口实际返回的门店。
 *   node src/check-yifeng-stores.mjs
 *
 * 为什么要核：台账 316 条但品牌B acctId 的美团门店接口只返回 113 家。
 * 需要判断这 316 条是「多平台展开」还是「口径不符」。
 */
import { readFileSync } from "node:fs";

const plan = JSON.parse(readFileSync("data/plan/yifeng-stores.json", "utf8"));
const mt = JSON.parse(readFileSync("data/raw/meituan-yifeng.json", "utf8"));

const apiStores = mt.stores ?? [];
const apiIds = new Set(apiStores.map((s) => String(s.id)));
const apiNames = new Set(apiStores.map((s) => s.name));

console.log(`台账 ${plan.length} 条`);
console.log(`美团接口 ${apiStores.length} 家`);

// ── 台账字段覆盖率 ──
const hasMt = plan.filter((r) => r.meituanId && String(r.meituanId).trim());
const hasEl = plan.filter((r) => r.elemeId && String(r.elemeId).trim());
const hasBoth = plan.filter((r) => r.meituanId?.trim() && r.elemeId?.trim());
console.log(`\n台账里有 美团ID 的 ${hasMt.length} 条`);
console.log(`台账里有 饿了么ID 的 ${hasEl.length} 条`);
console.log(`两边都有ID 的 ${hasBoth.length} 条`);

const uniqMt = new Set(hasMt.map((r) => String(r.meituanId).trim()));
const uniqEl = new Set(hasEl.map((r) => String(r.elemeId).trim()));
console.log(`台账 美团ID 去重后 ${uniqMt.size} 个`);
console.log(`台账 饿了么ID 去重后 ${uniqEl.size} 个`);

// ── 匹配美团接口 ──
let hit = 0, miss = 0;
const missed = [];
for (const id of uniqMt) {
  if (apiIds.has(id)) hit++;
  else {
    miss++;
    const row = hasMt.find((r) => String(r.meituanId).trim() === id);
    missed.push({ id, name: row?.meituanName || row?.code, status: row?.status });
  }
}
console.log(`\n美团：台账ID ∩ 接口ID = ${hit}   台账有但接口没有 = ${miss}`);
console.log(`接口有但台账没有 = ${[...apiIds].filter((i) => !uniqMt.has(i)).length}`);

if (missed.length) {
  console.log(`\n台账有、接口无 的前 25 条：`);
  for (const m of missed.slice(0, 25)) console.log(`   ${m.id}  ${m.name ?? ""}  [${m.status ?? ""}]`);
}

// ── 台账内部状态/分类分布 ──
const dist = (key) => {
  const m = {};
  for (const r of plan) m[r[key] ?? "(空)"] = (m[r[key] ?? "(空)"] ?? 0) + 1;
  return m;
};
console.log(`\n台账 status 分布: ${JSON.stringify(dist("status"))}`);
console.log(`台账 kind 分布:   ${JSON.stringify(dist("kind"))}`);
console.log(`台账 reason 分布: ${JSON.stringify(dist("reason"))}`);
console.log(`台账 city 分布:   ${JSON.stringify(dist("city"))}`);

// ── 美团接口侧营业状态 ──
console.log(`\n美团接口营业状态: ${JSON.stringify(mt.storeStatusDist)}`);
