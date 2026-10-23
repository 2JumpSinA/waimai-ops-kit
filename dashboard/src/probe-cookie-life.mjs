/**
 * 诊断：cookie 的寿命到底由什么决定。
 *   node src/probe-cookie-life.mjs
 *
 * 目的：回答「提供账号密码能否免去频繁更新 cookie」。
 * 要区分三件事：
 *   ① 静态 cookie 文件（.secrets/*.cookie.txt）—— 这是一份**快照**，不会自己变新
 *   ② 浏览器 profile 里的活 cookie —— 浏览器会按服务端 Set-Cookie 自动续期
 *   ③ 登录本身 —— 需要人机验证（滑块/短信/扫码），密码过不了
 *
 * ⚠️ 只输出统计（数量、名称、到期时间分布），**不回显任何 cookie 值**。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectBrowser, getAllCookies } from "./lib/cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = join(ROOT, ".secrets");

const DAY = 86400_000;
const fmtLeft = (expires) => {
  if (expires === undefined || expires === null) return "会话级(关浏览器即失效)";
  if (expires < 0) return "永久";
  const left = expires * 1000 - Date.now();
  if (left <= 0) return `已过期 ${(-left / DAY).toFixed(1)} 天`;
  if (left < DAY) return `${(left / 3600_000).toFixed(1)} 小时`;
  return `${(left / DAY).toFixed(1)} 天`;
};

// ───────── ① 静态文件：名字、数量、mtime ─────────
console.log("════ ① 静态 cookie 文件（.secrets/*.cookie.txt）════");
console.log("   ⚠️ 这种文件里**只有 name=value，没有到期时间** ——");
console.log("      所以脚本自己永远判断不出它是否快过期，只能等接口报错才知道。\n");
for (const f of ["meituan", "meituan-yifeng", "taobao", "ka-yifeng"]) {
  const p = join(SECRETS, `${f}.cookie.txt`);
  if (!existsSync(p)) {
    console.log(`   ${f.padEnd(18)} 不存在`);
    continue;
  }
  const txt = readFileSync(p, "utf8").trim();
  const names = txt.split(";").map((s) => s.split("=")[0].trim()).filter(Boolean);
  const st = statSync(p);
  const days = ((Date.now() - st.mtimeMs) / DAY).toFixed(1);
  console.log(`   ${f.padEnd(18)} ${String(names.length).padStart(3)} 项   文件最后更新 ${days} 天前`);
  // 只列名字，不列值
  console.log(`      ${names.slice(0, 14).join(", ")}${names.length > 14 ? ` … 另 ${names.length - 14} 项` : ""}`);
}

// ───────── ② 浏览器 profile 里的活 cookie ─────────
for (const [label, port, host] of [["品牌A", 9222, ".meituan.com"], ["品牌B", 9223, ".meituan.com"]]) {
  console.log(`\n════ ② ${label} profile（端口 ${port}）里 ${host} 的活 cookie ════`);
  let cdp;
  try {
    cdp = await connectBrowser(port);
  } catch (e) {
    console.log(`   连不上端口 ${port}：${e.message}`);
    continue;
  }
  let cookies = [];
  try {
    cookies = await getAllCookies(cdp);
  } catch (e) {
    console.log(`   读 cookie 失败：${e.message}`);
    await cdp.close();
    continue;
  }
  await cdp.close();

  const mine = cookies.filter((c) => String(c.domain).includes(host.replace(/^\./, "")));
  console.log(`   该域下共 ${mine.length} 项（浏览器全域共 ${cookies.length} 项）`);

  const buckets = { 已过期: [], "1天内": [], "1-7天": [], "7-30天": [], ">30天": [], 永久: [], 会话级: [] };
  for (const c of mine) {
    const e = c.expires;
    if (e === undefined || e === null || e === -1) { buckets["会话级"].push(c); continue; }
    if (e < 0) { buckets["永久"].push(c); continue; }
    const left = e * 1000 - Date.now();
    if (left <= 0) buckets["已过期"].push(c);
    else if (left < DAY) buckets["1天内"].push(c);
    else if (left < 7 * DAY) buckets["1-7天"].push(c);
    else if (left < 30 * DAY) buckets["7-30天"].push(c);
    else buckets[">30天"].push(c);
  }
  for (const [k, v] of Object.entries(buckets)) {
    if (!v.length) continue;
    console.log(`   ${k.padEnd(8)} ${String(v.length).padStart(3)} 项   ${v.slice(0, 10).map((c) => c.name).join(", ")}${v.length > 10 ? " …" : ""}`);
  }

  // 关键：登录态核心 cookie 的剩余寿命
  const KEY = ["token", "bsid", "acctId", "_l_g_", "cookie2", "_m_h5_tk", "WMSTOKEN", "sgcookie", "device_uuid"];
  console.log(`   ── 关键项剩余寿命 ──`);
  for (const c of mine) {
    if (!KEY.includes(c.name)) continue;
    console.log(`      ${c.name.padEnd(16)} ${fmtLeft(c.expires).padEnd(22)} httpOnly=${!!c.httpOnly}`);
  }
}

console.log(`\n════ 说明 ════`);
console.log(`   「会话级」cookie 在**关闭浏览器时就丢**；「永久」是持久化 cookie。`);
console.log(`   浏览器会按服务端返回的 Set-Cookie 自动刷新这些时间 —— 这就是 profile 比静态文件耐用的原因。`);
