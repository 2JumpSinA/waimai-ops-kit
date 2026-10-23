/**
 * 对比「旧品牌B Chrome profile」与「新品牌B Edge profile」的 cookie，
 * 找出可能导致后台功能缺失的差异。
 *   node src/probe-account-context.mjs
 *
 * 背景：经营者反馈「品牌B Edge 里的美团后台不是完整版，很多功能缺失」。
 * 决定「连锁后台 vs 单店后台」的通常是一批**配置类 cookie**：
 *   isChain / existBrandPoi / brandId / account_businesstype / acctMode /
 *   brandScaleType / isOfflineSelfOpen / newCategory / region_id / wmPoiId ...
 * 这些值不同，同一个账号进去看到的菜单就完全不同。
 *
 * 对比基准：
 *   旧 = `.secrets/meituan-yifeng.cookie.txt`（从**能正常工作**的 Chrome profile 导出）
 *   新 = Edge profile（端口 9223）里的活 cookie
 *
 * ⚠️ token / bsid / 签名类值一律只报「长度 + 前 4 位」，不打印明文。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectBrowser, getAllCookies } from "./lib/cdp.mjs";
import { parseCookieString } from "./lib/cookie.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 9223);
const HOST = "yiyao.meituan.com";

/** 敏感值遮罩：只留长度与前缀 */
const SECRET_RE = /token|bsid|sig|sign|secret|key|passwd|password|session|_lxsdk|uuid|device/i;
const show = (name, v) => {
  const s = String(v ?? "");
  if (SECRET_RE.test(name)) return `len=${s.length} 前4=${s.slice(0, 4)}…`;
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
};

/** 旧值：从静态快照读（那是从能用的 Chrome profile 导出的） */
const stem = "meituan-yifeng";
const snapPath = join(ROOT, ".secrets", `${stem}.cookie.txt`);
const oldMap = new Map();
if (existsSync(snapPath)) {
  const { cookies } = parseCookieString(readFileSync(snapPath, "utf8"));
  for (const [k, v] of Object.entries(cookies)) oldMap.set(k, v);
  console.log(`旧（静态快照 ${stem}.cookie.txt）：${oldMap.size} 项\n`);
} else {
  console.log(`⚠️ 找不到 ${snapPath}\n`);
}

/** 新值：从 Edge profile 读活 cookie */
const cdp = await connectBrowser(PORT);
const all = await getAllCookies(cdp);
await cdp.close();
const norm = (s) => String(s ?? "").replace(/^\./, "");
const mine = all.filter((c) => {
  const d = norm(c.domain);
  return HOST === d || HOST.endsWith("." + d);
});
const newMap = new Map();
for (const c of mine) newMap.set(c.name, c.value);
console.log(`新（Edge profile:${PORT} @ ${HOST}）：${mine.length} 项\n`);

// ── 重点关注：决定「后台形态」的配置项 ──
const KEY = [
  "acctId", "acctLogin", "acct_name", "acctSource", "acct_source", "acctMode",
  "account_businesstype", "brandId", "brandScaleType", "isChain", "existBrandPoi",
  "isOfflineSelfOpen", "newCategory", "controlType", "wmPoiId", "wmPoiName",
  "city_id", "region_id", "region_version", "ignore_set_router_proxy",
  "realAccountId", "accountSource", "accountId", "platformSource",
];

console.log("════ 关键配置项对比 ════");
console.log(`  ${"cookie".padEnd(26)} ${"旧(Chrome)".padEnd(26)} 新(Edge)`);
let diff = 0;
for (const k of KEY) {
  const o = oldMap.get(k);
  const n = newMap.get(k);
  if (o === undefined && n === undefined) continue;
  const same = String(o) === String(n);
  if (!same) diff++;
  console.log(`  ${(same ? "  " : "≠ ") + k.padEnd(24)} ${show(k, o ?? "(无)").padEnd(26)} ${show(k, n ?? "(无)")}`);
}

// ── 名字集合差异（能看出功能开关类 cookie 是否整批缺失）──
const onlyOld = [...oldMap.keys()].filter((k) => !newMap.has(k));
const onlyNew = [...newMap.keys()].filter((k) => !oldMap.has(k));

console.log(`\n════ cookie 名字集合差异 ════`);
console.log(`  只有旧的（${onlyOld.length} 项）：`);
console.log("    " + (onlyOld.slice(0, 40).join(", ") || "(无)"));
console.log(`  只有新的（${onlyNew.length} 项）：`);
console.log("    " + (onlyNew.slice(0, 40).join(", ") || "(无)"));

// ── 特别关注：以 com.sankuai. 开头的「灰度/策略」cookie ──
const isStrategy = (k) => /^com\.sankuai\.|strategy|grey|gray/i.test(k);
const stratOld = [...oldMap.keys()].filter(isStrategy);
const stratNew = [...newMap.keys()].filter(isStrategy);
console.log(`\n════ 灰度/策略类 cookie（决定功能开关）════`);
console.log(`  旧 ${stratOld.length} 项，新 ${stratNew.length} 项`);
const stratOnlyOld = stratOld.filter((k) => !newMap.has(k));
if (stratOnlyOld.length) {
  console.log(`  ⚠️ 只有旧 profile 有、新 profile 缺失的 ${stratOnlyOld.length} 项：`);
  for (const k of stratOnlyOld.slice(0, 25)) console.log(`     - ${k}`);
}

console.log(`\n════ 小结 ════`);
console.log(`  关键配置项不同的：${diff} 个` + (diff ? "  ← 很可能就是「后台不是完整版」的原因" : ""));
console.log(`  旧独有 cookie：${onlyOld.length} 项；新独有：${onlyNew.length} 项`);
console.log(`  灰度/策略 cookie 缺失：${stratOnlyOld.length} 项`);
