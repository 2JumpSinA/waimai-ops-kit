/**
 * 探测：同名 cookie 为什么寿命不同（domain / path 差异）。
 *   node src/probe-cookie-dup.mjs [--port=9222]
 *
 * 起因：品牌A profile 里 `token` / `bsid` / `acctId` 都有**两份同名、寿命差 30 倍**的 cookie
 * （一份剩 29.9 天，一份只剩 21.9 小时）。
 *
 * HTTP 语义：同名 cookie 靠 **path 长短**决定谁生效（长 path 优先）。
 * 如果把两份都拼进同一个请求头（`token=A; ...; token=B`），
 * 哪个赢取决于解析方是「先见先得」还是「后见覆盖」—— **这就是脆弱的根源**。
 *
 * 推测这正是「cookie 频繁失效」的真正原因：
 * 从 DevTools「Copy as cURL」导出的快照，抓到的是**当时那一次请求实际发送的那一份**，
 * 若恰好是短命的那份，不到一天就死了 —— 而浏览器 profile 里其实还有一份能活 30 天的。
 *
 * ⚠️ 只打印 domain / path / 寿命，**不回显任何 cookie 值**。
 */
import { connectBrowser, getAllCookies } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9222"));
const DAY = 86400_000;

const KEY = ["token", "bsid", "acctId", "acctLogin", "wmPoiId", "device_uuid", "account_businesstype"];

const fmtLeft = (e) => {
  if (e === undefined || e === null || e === -1) return "会话级";
  if (e < 0) return "永久";
  const left = e * 1000 - Date.now();
  if (left <= 0) return `已过期 ${(-left / DAY).toFixed(1)}天`;
  return left < DAY ? `${(left / 3600_000).toFixed(1)}小时` : `${(left / DAY).toFixed(1)}天`;
};

const cdp = await connectBrowser(PORT);
const all = await getAllCookies(cdp);
await cdp.close();

console.log(`端口 ${PORT}：浏览器全域 cookie ${all.length} 项\n`);

for (const name of KEY) {
  const hits = all.filter((c) => c.name === name);
  if (!hits.length) continue;
  console.log(`── ${name}（${hits.length} 份）──`);
  for (const c of hits) {
    const val = String(c.value ?? "");
    const shape = val.length <= 8 ? `len=${val.length}` : `len=${val.length} 前4=${val.slice(0, 4)}…`;
    console.log(
      `   domain=${String(c.domain).padEnd(28)} path=${String(c.path).padEnd(22)} ` +
        `${fmtLeft(c.expires).padEnd(12)} ${shape}`,
    );
  }
  if (hits.length > 1) {
    const byPath = [...new Set(hits.map((c) => c.path))];
    console.log(`   ⚠️ 同名多份，path 有 ${byPath.length} 种：${byPath.join(" / ")}`);
    const byDom = [...new Set(hits.map((c) => c.domain))];
    console.log(`   ⚠️ domain 有 ${byDom.length} 种：${byDom.join(" , ")}`);
    console.log(`   → 它们服务**不同的子域**，不能简单拼进同一个请求头（同名会互相覆盖）`);
  }
  console.log("");
}

// 汇总：按 path 分布
console.log("── 按 (domain, path) 统计重复度 ──");
const map = new Map();
for (const c of all) {
  const k = `${c.domain}\t${c.path}`;
  const s = map.get(k) ?? { n: 0, names: new Set() };
  s.n++;
  s.names.add(c.name);
  map.set(k, s);
}
const dupNames = new Map();
for (const c of all) dupNames.set(c.name, (dupNames.get(c.name) ?? 0) + 1);
const dup = [...dupNames.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
console.log(`  浏览器全域有 ${dup.length} 个重名 cookie：`);
for (const [n, c] of dup.slice(0, 25)) console.log(`     ${n.padEnd(42)} ${c} 份`);
