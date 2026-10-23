/**
 * 把调试浏览器 profile 里的**活 cookie 快照**落盘到 .secrets/*.cookie.txt。
 *   node src/save-cookies.mjs --account=quanyi [--platform=all|meituan|ka|taobao]
 *
 * ⭐ 为什么值得做：
 *   商家会话的 cookie 是**会话级**的 —— 浏览器一关就没了。
 *   而 `.secrets/*.cookie.txt` 是静态快照，**不会丢**。
 *   落一份快照后：
 *     · 闪购（纯 Node / MTOP）**完全不需要浏览器**，随时能跑；
 *     - 美团医药/推广仍需浏览器（要页面签名），但 profile 登录态万一丢了，
 *       还能回退到这份快照，不至于整段卡住。
 *
 * ⚠️ 这是凭据文件：写到 .secrets/ 下（已被 .gitignore 覆盖），**不打印 cookie 值**。
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectBrowser, getAllCookies } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};

const acct = resolveAccount(process.argv);
const PLATFORM = arg("platform", "all");

/** 每个平台：cookie 文件 stem、所在端口、目标 host 白名单 */
const P = acct.key === "quanyi"
  ? { meituan: { stem: "meituan", port: 9222, hosts: ["yiyao.meituan.com", "meituan.com"] },
      ka:      { stem: "ka",      port: 9222, hosts: ["ka.waimai.meituan.com", "meituan.com"] },
      taobao:  { stem: "taobao",  port: 9222, hosts: ["nr.ele.me", "ele.me"] } }
  : { meituan: { stem: "meituan-yifeng", port: 9223, hosts: ["yiyao.meituan.com", "meituan.com"] },
      ka:      { stem: "ka-yifeng",      port: 9223, hosts: ["ka.waimai.meituan.com", "meituan.com"] },
      taobao:  { stem: "taobao-yifeng",  port: 9223, hosts: ["nr.ele.me", "ele.me"] } };

const want = PLATFORM === "all" ? Object.keys(P) : [PLATFORM];
const SECRETS = join(ROOT, ".secrets");
mkdirSync(SECRETS, { recursive: true });

/** 按 (domain, path) 去重：同名多份时优先路径最长，其次寿命最长（与 loadCookieSmart 一致） */
function dedupe(list) {
  const best = new Map();
  for (const c of list) {
    const prev = best.get(c.name);
    if (!prev) { best.set(c.name, c); continue; }
    const pLen = String(c.path ?? "/").length, pPrev = String(prev.path ?? "/").length;
    const e = (x) => (typeof x.expires === "number" && x.expires > 0 ? x.expires : 0);
    if (pLen !== pPrev ? pLen > pPrev : e(c) > e(prev)) best.set(c.name, c);
  }
  return [...best.values()];
}

const DAY = 86400_000;
const lifeLabel = (e) => {
  if (typeof e !== "number" || e <= 0) return "(会话级)";
  const left = e * 1000 - Date.now();
  if (left <= 0) return "(已过期)";
  return left < DAY ? `${(left / 3600_000).toFixed(1)}h` : `${(left / DAY).toFixed(1)}d`;
};

let okCount = 0, failCount = 0;
for (const key of want) {
  const cfg = P[key];
  if (!cfg) { console.error(`未知平台 ${key}`); continue; }
  console.log(`\n════ ${acct.label} / ${key} ════`);
  let all;
  try {
    const cdp = await connectBrowser(cfg.port);
    try { all = await getAllCookies(cdp); } finally { await cdp.close(); }
  } catch (e) {
    console.log(`  ⛔ 端口 ${cfg.port} 连不上（${e.message}）—— 请先启动该账号的调试浏览器`);
    failCount++;
    continue;
  }
  const norm = (s) => String(s ?? "").replace(/^\./, "");
  const mine = all.filter((c) => cfg.hosts.some((h) => {
    const d = norm(c.domain);
    return d === h || d.endsWith("." + h);
  }));
  const kept = dedupe(mine);
  if (!kept.length) { console.log(`  ⛔ 该 host 下没有 cookie（未登录？）`); failCount++; continue; }

  const header = kept.map((c) => `${c.name}=${c.value}`).join("; ");
  const path = join(SECRETS, `${cfg.stem}.cookie.txt`);
  const before = existsSync(path) ? statSync(path).mtime.toLocaleString("zh-CN") : "(新建)";
  writeFileSync(path, header + "\n", "utf8");

  // 只报名字与寿命，**不打印值**
  const sess = kept.filter((c) => !(typeof c.expires === "number" && c.expires > 0));
  console.log(`  ✅ 已写入 .secrets/${cfg.stem}.cookie.txt   ${kept.length} 项（原文件时间 ${before}）`);
  console.log(`     会话级 ${sess.length} 项` + (sess.length ? `：${sess.map((c) => c.name).slice(0, 8).join(", ")}` : ""));
  for (const n of ["token", "acctId", "acct_name", "WMSTOKEN", "_m_h5_tk"]) {
    const c = kept.find((x) => x.name === n);
    if (c) console.log(`     ${n.padEnd(12)} ${lifeLabel(c.expires)}`);
  }
  okCount++;
}

console.log(`\n════ 小结 ════`);
console.log(`  成功 ${okCount} 个平台，失败 ${failCount} 个`);
console.log(`  ⚠️ 快照是**某一刻**的静态数据；浏览器 profile 里的活 cookie 仍优先使用。`);
console.log(`     快照主要用于：闪购免浏览器运行、以及 profile 登录态丢失时的兜底。`);
