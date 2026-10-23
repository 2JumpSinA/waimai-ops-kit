/**
 * 收割淘宝闪购 cookie —— 用 browser 级 CDP，**不依赖渲染进程**。
 *   node src/capture-cookies.mjs [--port=9222]
 *
 * 为什么不用 F12 手工复制、也不用页面级 CDP：
 *   1. `nr.ele.me` 的关键 cookie（`_m_h5_tk` / `_m_h5_tk_enc` / 会话 token）挂在 `.ele.me` 父域，
 *      手工复制极易漏项
 *   2. 本环境会拦 Chrome 的**渲染进程**（page 域命令无响应），
 *      但 `Storage.getCookies` 是 **browser 级**命令，不受影响
 *
 * 前置：你双击 start-chrome-taobao.cmd，在弹出的窗口里登录，窗口保持打开。
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectBrowser, getAllCookies, launchChromeLite } from "./lib/cdp.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9222"));

/** 只收割这些域 */
const KEEP = /(^|\.)(ele\.me|taobao\.com|alibaba\.com|alibabacorp\.com|mmstat\.com)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. 连接（连不上就自己拉一个）──
let cdp;
let selfLaunched = false;
try {
  cdp = await connectBrowser(PORT);
} catch (e) {
  console.log(`端口 ${PORT} 不可用（${e.message}）`);
  console.log("尝试用持久化 profile 自行拉起浏览器…");
  const r = await launchChromeLite({ port: PORT, headless: true });
  cdp = r.cdp;
  selfLaunched = true;
}
console.log(`✅ 已连接 ${PORT}（${cdp.browser}）${selfLaunched ? " [自启]" : ""}\n`);

/** 最多等 N 秒，直到出现 `_m_h5_tk`（登录并走过一次 MTOP 通路后才有） */
async function harvestOnce() {
  const cookies = await getAllCookies(cdp);
  const mine = cookies.filter((c) => KEEP.test(c.domain));
  const byName = new Map();
  for (const c of mine) {
    const prev = byName.get(c.name);
    if (!prev || c.domain.length > prev.domain.length) byName.set(c.name, c);
  }
  return { cookies, mine, byName };
}

let { cookies, mine, byName } = await harvestOnce();

if (!byName.has("_m_h5_tk")) {
  console.log("⏳ 还没看到 `_m_h5_tk`。这通常表示尚未登录，或登录后还没走过一次 MTOP 通路。");
  console.log("   等待中（最多 120 秒）… 请确认已在浏览器窗口里登录。\n");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(4000);
    ({ cookies, mine, byName } = await harvestOnce());
    if (byName.has("_m_h5_tk")) break;
    process.stdout.write(`   …已看到 ${byName.size} 个 ele.me cookie\r`);
  }
  console.log("");
}

// ── 2. 落盘 ──
const picked = [...byName.values()];
const dropped = picked.filter((c) => !/^[\x20-\x7E]*$/.test(c.value)).map((c) => c.name);
const usable = picked.filter((c) => /^[\x20-\x7E]*$/.test(c.value));
const header = usable.map((c) => `${c.name}=${c.value}`).join("; ");

await mkdir(join(ROOT, ".secrets"), { recursive: true });
const out = join(ROOT, ".secrets", "taobao.cookie.txt");
await writeFile(out, header + "\n", "utf8");

console.log("════ cookie 收割结果 ════");
const domains = [...new Set(mine.map((c) => c.domain))];
console.log(`  命中域 ${domains.length} 个：${domains.join(", ")}`);
console.log(`  保留 ${usable.length} 项（去重后），剔除非 ASCII ${dropped.length} 项${dropped.length ? "：" + dropped.join(", ") : ""}`);
console.log(`  文件 ${Buffer.byteLength(header)} 字节 → .secrets/taobao.cookie.txt`);

const names = picked.map((c) => c.name).sort();
console.log(`\n  cookie 键名（共 ${names.length}，只打键名不打值）：`);
console.log("    " + names.join(", "));

const CRITICAL = ["_m_h5_tk", "_m_h5_tk_enc", "_m_h5_c", "WMSTOKEN", "cookie2", "_l_g_", "cna", "sgcookie"];
console.log("\n  关键项自检：");
for (const k of CRITICAL) console.log(`    ${byName.has(k) ? "✅" : "— "} ${k}`);

// ── 3. 真实 MTOP 调用验证（纯 Node，不需要浏览器）──
const cookieObj = Object.fromEntries(usable.map((c) => [c.name, c.value]));
if (!cookieObj["_m_h5_tk"]) {
  console.log("\n⛔ 缺 `_m_h5_tk`，无法验签。请确认已在浏览器里登录成功后重跑。");
  await cdp.close();
  process.exit(1);
}

console.log("\n════ MTOP 验签（真实调用）════");
const TESTS = [
  ["账号信息", "mtop.ele.newretail.ebai.AccountShopCookieService.getAccountInfo", {}],
  ["登录节点", "mtop.ele.newretail.ebai.MultiLevelMtopService.getloginnode", {}],
  ["门店信息", "mtop.ele.newretail.ebai.ShopReadMtopService.getShopInfo", {}],
];
let anyOk = false;
for (const [label, api, data] of TESTS) {
  const r = await mtopCall({ api, data, cookies: cookieObj });
  const icon = r.ok ? "✅" : "⛔";
  console.log(`${icon} ${label.padEnd(8)} ret=${r.ret} attempts=${r.attempts}`);
  if (r.ok) {
    anyOk = true;
    const d = r.data;
    const shape = d && typeof d === "object" ? `keys=${JSON.stringify(Object.keys(d).slice(0, 12))}` : JSON.stringify(d)?.slice(0, 120);
    console.log(`        ${shape}`);
    // 自愈后要把新 token 写回
    if (r.cookies._m_h5_tk !== cookieObj._m_h5_tk) {
      console.log("        ⚠️ 服务端下发了新的 _m_h5_tk，需写回凭据");
      cookieObj._m_h5_tk = r.cookies._m_h5_tk;
    }
  }
}

console.log(
  anyOk
    ? "\n🎉 签名链路打通 —— 后续所有 MTOP 接口都可以纯 Node 调用，不需要浏览器。"
    : "\n⛔ 验签未通过。若 ret 含 TOKEN/ILLEGAL_ACCESS，多半是 cookie 不完整或会话未生效。",
);

await cdp.close();
