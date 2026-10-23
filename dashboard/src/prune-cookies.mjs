/**
 * 清理某个调试 profile 里**用不到的 cookie**。
 *   node src/prune-cookies.mjs --port=9222 [--keep=meituan.com,ele.me,...] [--dry]
 *
 * 为什么需要：要把「日常浏览器的登录」搬进调试 profile，只能整份复制 Chrome 的
 * Cookies 数据库（cookie 值是加密的，没法挑着解）。复制过去意味着**你所有的网站登录**
 * （邮箱、银行、购物……）都进了 `_recon/` 这个项目目录。
 *
 * 所以搬完立刻把不相关的删掉，让调试 profile 只留本项目需要的域 —— 隐私上干净得多。
 *
 * ⚠️ 只删、不读值；输出里不出现任何 cookie 内容。
 */
import { connectBrowser, getAllCookies } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9222"));
const DRY = process.argv.includes("--dry");
/** 保留白名单：本项目要用的域（含子域） */
const KEEP = (arg("keep", "meituan.com,ele.me,eleme.me,waimai.meituan.com") || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const kept = (domain) => {
  const d = String(domain ?? "").replace(/^\./, "");
  return KEEP.some((k) => d === k || d.endsWith("." + k));
};

const cdp = await connectBrowser(PORT);
let all;
try {
  all = await getAllCookies(cdp);
} catch (e) {
  console.error(`读 cookie 失败：${e.message}`);
  await cdp.close();
  process.exit(1);
}

console.log(`端口 ${PORT}：共 ${all.length} 项 cookie`);
console.log(`保留白名单：${KEEP.join(", ")}\n`);

const keepList = all.filter((c) => kept(c.domain));
const dropList = all.filter((c) => !kept(c.domain));

// 按域汇总，只打印域名和数量，**不打印任何 cookie 值**
const byDomain = new Map();
for (const c of dropList) {
  const k = String(c.domain).replace(/^\./, "");
  byDomain.set(k, (byDomain.get(k) ?? 0) + 1);
}
const top = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);

console.log(`保留 ${keepList.length} 项，涉及域：`);
for (const d of [...new Set(keepList.map((c) => String(c.domain).replace(/^\./, "")))].sort()) {
  console.log(`   ✅ ${d}`);
}
console.log(`\n待删除 ${dropList.length} 项，涉及 ${byDomain.size} 个域，前 25 个：`);
for (const [d, n] of top.slice(0, 25)) console.log(`   ✂️  ${d.padEnd(40)} ${n} 项`);
if (top.length > 25) console.log(`   … 另 ${top.length - 25} 个域`);

if (DRY) {
  console.log("\n--dry 模式，未实际删除。");
  await cdp.close();
  process.exit(0);
}

let ok = 0, fail = 0;
for (const c of dropList) {
  const url = `http${c.secure ? "s" : ""}://${String(c.domain).replace(/^\./, "")}${c.path ?? "/"}`;
  try {
    await cdp.send("Network.deleteCookies", { name: c.name, url, path: c.path });
    ok++;
  } catch {
    fail++;
  }
}
console.log(`\n删除完成：成功 ${ok}，失败 ${fail}`);

const after = await getAllCookies(cdp);
console.log(`清理后剩余 ${after.length} 项`);
await cdp.close();
