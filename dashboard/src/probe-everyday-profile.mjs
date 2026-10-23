/**
 * 探测：**用户日常浏览器 profile** 里能否读到登录态。
 *   node src/probe-everyday-profile.mjs --port=9333 --host=yiyao.meituan.com [--nav=https://...]
 *
 * 背景：经营者说他日常在 Chrome 登品牌A、Edge 登品牌B，想问这样能否免去更新 cookie。
 * 关键问题：`start-chrome.ps1` 用的是**独立 profile**（`_recon\user-chrome`），
 * 与他日常的 `%LOCALAPPDATA%\...\User Data` 完全无关 —— 所以日常登录**默认读不到**。
 *
 * 本脚本用来判定：如果把调试端口加在**日常 profile** 上，能不能读到可用登录态。
 *
 * ⚠️ 用两种方式读（`Storage.getCookies` 是 browser 级，`Network.getAllCookies` 是页级），
 *    因为实测 browser 级在浏览器刚起来时可能返回 0 —— 那时看着像「没登录」，其实是没读完。
 */
import { connectBrowser, connectToPage, getAllCookies, evaluate } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9333"));
const HOST = arg("host", "yiyao.meituan.com");
const NAV = arg("nav", "");
const REQUIRED = (arg("required", "token,acctId") || "").split(",").filter(Boolean);
const DAY = 86400_000;

const fmtLeft = (e) => {
  if (e === undefined || e === null || e === -1) return "会话级";
  if (e < 0) return "永久";
  const left = e * 1000 - Date.now();
  if (left <= 0) return `⛔已过期${(-left / DAY).toFixed(1)}天`;
  return left < DAY ? `⚠️${(left / 3600_000).toFixed(1)}小时` : `${(left / DAY).toFixed(1)}天`;
};
const applicable = (c, host) => {
  const d = String(c.domain ?? "").replace(/^\./, "");
  return host === d || host.endsWith("." + d);
};

// ── 方式 1：browser 级 Storage.getCookies ──
console.log("── 方式 1：browser 级 `Storage.getCookies` ──");
let browserCookies = [];
try {
  const b = await connectBrowser(PORT);
  browserCookies = await getAllCookies(b);
  await b.close();
  console.log(`   读到 ${browserCookies.length} 项`);
} catch (e) {
  console.log(`   失败：${e.message}`);
}

// ── 方式 2：页级 Network.getAllCookies（先导航，让浏览器把 cookie 载入内存）──
let pageCookies = [];
if (NAV) {
  console.log(`\n── 方式 2：导航到 ${NAV} 后，页级 Network.getAllCookies ──`);
  try {
    const p = await connectToPage(PORT);
    await p.send("Page.navigate", { url: NAV });
    await new Promise((r) => setTimeout(r, 9000));
    const r = await p.send("Network.getAllCookies");
    pageCookies = r?.cookies ?? [];
    const title = await evaluate(p, "document.title + ' | ' + location.href").catch(() => "?");
    console.log(`   读到 ${pageCookies.length} 项；当前页：${String(title).slice(0, 90)}`);
    await p.close();
  } catch (e) {
    console.log(`   失败：${e.message}`);
  }
}

const all = pageCookies.length ? pageCookies : browserCookies;
console.log(`\n════ ${HOST} 下可用的 cookie（共 ${all.length} 项里筛）════`);
const mine = all.filter((c) => applicable(c, HOST));
console.log(`   命中 ${mine.length} 项`);
if (mine.length) {
  const names = new Set(mine.map((c) => c.name));
  const missing = REQUIRED.filter((r) => !names.has(r));
  console.log(`   关键项：${REQUIRED.map((r) => `${r}=${names.has(r) ? "有" : "缺"}`).join(" ")}`);
  console.log(`   → 判定：${missing.length ? "⛔ 不完整，缺 " + missing.join(",") : "✅ 有可用登录态"}`);
  console.log(`\n   关键项寿命：`);
  for (const c of mine) {
    if (!REQUIRED.includes(c.name)) continue;
    console.log(`      ${c.name.padEnd(16)} domain=${String(c.domain).padEnd(26)} path=${String(c.path).padEnd(6)} ${fmtLeft(c.expires)}`);
  }
}
