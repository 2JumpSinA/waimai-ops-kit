/**
 * 把一个浏览器里的「商家后台可见菜单/功能」抓出来，用于 A/B 对比。
 *   node src/probe-console-ui.mjs --port=9223 --label=edge [--url=...]
 *
 * 用途：经营者反馈「品牌B Edge 里的美团后台不是完整版，很多功能缺失」。
 * cookie 对比已排除账号上下文问题，所以要在**渲染层**找差异 ——
 * 把两边页面实际显示出来的导航/菜单文字抽出来 diff。
 *
 * ⚠️ 只读页面文字，不做任何点击/写操作。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9223"));
const LABEL = arg("label", `port${PORT}`);
const URL_ = arg("url", "https://yiyao.meituan.com/page/home?ignoreSetRouterProxy=true");

const cdp = await connectToPage(PORT);
const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
console.log(`[${LABEL}] port ${PORT}  ${ver.Browser}`);

await cdp.send("Page.navigate", { url: URL_ });
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 60_000 }).catch(() => null);
// 后台是 SPA，菜单要等接口回来才渲染；给足时间
await new Promise((r) => setTimeout(r, 12_000));

const raw = await evaluate(
  cdp,
  `(() => {
     // 1) 可见文字（按行去重，过滤空白）
     const lines = (document.body?.innerText || '')
       .split('\\n').map(s => s.trim()).filter(s => s.length > 0);
     // 2) 链接与菜单项
     const links = [...document.querySelectorAll('a[href]')]
       .map(a => ({ text: (a.innerText || '').trim().slice(0, 40), href: a.getAttribute('href') }))
       .filter(x => x.text);
     const menuish = [...document.querySelectorAll('[role="menuitem"],[class*="menu" i] li,[class*="nav" i] li')]
       .map(e => (e.innerText || '').trim().split('\\n')[0].slice(0, 40))
       .filter(Boolean);
     return JSON.stringify({
       url: location.href, title: document.title,
       userAgent: navigator.userAgent,
       innerW: innerWidth, innerH: innerHeight,
       lineCount: lines.length,
       lines: [...new Set(lines)],
       menuish: [...new Set(menuish)],
       linkCount: links.length,
       links: links.slice(0, 200),
     });
   })()`,
);
const data = JSON.parse(raw);
const dir = join(ROOT, "_recon", "ui-compare");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${LABEL}.json`);
writeFileSync(out, JSON.stringify(data, null, 2), "utf8");

console.log(`  URL       : ${data.url}`);
console.log(`  UA        : ${data.userAgent.slice(0, 110)}`);
console.log(`  视口      : ${data.innerW} x ${data.innerH}`);
console.log(`  可见文字行: ${data.lineCount}`);
console.log(`  菜单项    : ${data.menuish.length}`);
console.log(`  链接      : ${data.linkCount}`);
console.log(`  落盘      : ${out}`);
console.log(`\n  —— 可见文字前 60 行 ——`);
for (const l of data.lines.slice(0, 60)) console.log(`    ${l}`);

await cdp.close();
