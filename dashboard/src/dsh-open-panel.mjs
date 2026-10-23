/**
 * 把 DSH 面板作为一个标签页开进**调试浏览器窗口**里。
 *   node src/dsh-open-panel.mjs [--port=9222] [--dry]
 *
 * 背景：经营者希望「DSH 开发面板」和「商家端」在同一个窗口里。
 *   一个浏览器窗口只能属于一个 profile，所以不能把两个 Chrome 窗口"合并"；
 *   正确的做法是把 DSH 当作一个**标签页**开在调试 Chrome 窗口里。
 *
 * ⚠️ DSH Web 需要鉴权：裸开 http://127.0.0.1:3080/ 只会得到
 *    "dsh web authentication required; reopen the URL printed by dsh web."
 *    `dsh web` 启动时打印的 URL 里带 token，本脚本从 $DSH_HOME/web-daemon.out 里取。
 *
 * 🔒 token 是凭据：**本脚本绝不打印它**，只打印脱敏后的形态。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9222"));
const DRY = process.argv.includes("--dry");

const mask = (u) =>
  u.replace(/([?&](?:token|t|auth|key|code)=)([^&\s]+)/gi, (m, a, b) => `${a}${b.slice(0, 3)}***(${b.length})`);

const home = process.env.DSH_HOME;
if (!home) {
  console.error("DSH_HOME 未设置");
  process.exit(1);
}

// 按优先级找候选文件：daemon 的 stdout 最可能有 `dsh web` 打印的 URL
const CANDIDATES = ["web-daemon.out", "web-daemon.out.prev", "web-daemon.log", "web-watchdog.log"];
let found = null;
for (const f of CANDIDATES) {
  const p = join(home, f);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, "utf8");
  const urls = [...text.matchAll(/https?:\/\/127\.0\.0\.1:3080[^\s"'<>`]*/g)].map((m) => m[0]);
  const withToken = urls.find((u) => /[?&](token|t|auth|key|code)=/i.test(u));
  console.log(`${f}: 找到 ${urls.length} 个 URL，其中带 token 的 ${withToken ? 1 : 0} 个`);
  for (const u of [...new Set(urls)].slice(0, 4)) console.log(`   ${mask(u).slice(0, 130)}`);
  if (withToken && !found) found = withToken;
}

if (!found) {
  console.error("\n⛔ 没有找到带 token 的 URL。");
  console.error("   请在你的终端里跑一次 `dsh web`，它会打印带 token 的完整地址。");
  console.error("   或者：直接在调试浏览器窗口里手动打开那个地址（一次即可，之后 token 会留在该 profile）。");
  process.exit(2);
}

console.log(`\n已取得带 token 的 URL（脱敏）：${mask(found).slice(0, 120)}`);

mkdirSync(join(ROOT, "_recon"), { recursive: true });
writeFileSync(join(ROOT, "_recon", "dsh-url.txt"), found, "utf8");
console.log("已写入 _recon/dsh-url.txt（供你手动打开用；token 未打印到对话）");

if (DRY) {
  console.log("\n--dry，未打开标签页");
  process.exit(0);
}

const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(found)}`, { method: "PUT" });
if (!r.ok) {
  console.error(`\n⛔ 打开标签页失败：HTTP ${r.status}`);
  process.exit(1);
}
const t = await r.json();
console.log(`\n✅ 已在端口 ${PORT} 的窗口里新开标签页（id=${t.id}）`);

// 稍等后确认它渲染成功（读的是标题，不含 token）
await new Promise((r) => setTimeout(r, 6000));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter((x) => x.type === "page");
console.log(`\n该窗口当前标签页：`);
for (const p of pages) {
  const label = /127\.0\.0\.1:3080/.test(p.url) ? "  ← DSH 面板" : "";
  console.log(`   ${(p.title || "(无标题)").slice(0, 34).padEnd(36)} ${p.url.replace(/\?.*$/, "?…").slice(0, 46)}${label}`);
}
