/**
 * 验证「DSH 面板能在官方 Chromium 里正常打开」。
 *   node src/verify-chromium-dsh.mjs
 *
 * 做法：用与快捷方式相同的参数启动 Chromium，**额外加一个临时调试端口**，
 * 读页面标题/正文确认渲染成功，然后关掉。
 * 🔒 不回显 token。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { BROWSER_CANDIDATES } from "./lib/cdp.mjs";

// 曾经写死某个固定盘符的 Chromium 目录；改为环境变量 > 自动探测，与取数共用候选表。
const CHROMIUM = (() => {
  const cands = [
    process.env.DSH_CHROMIUM_EXE,
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
    ...BROWSER_CANDIDATES,
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) ?? cands[0];
})();
const PROFILE = process.env.DSH_CHROMIUM_PROFILE || join(process.cwd(), "_recon", "dsh-profile");
const PORT = 9556;

const mask = (u) => u.replace(/([?&](?:token|t|auth|key|code)=)([^&\s]+)/gi, "$1***");

function findDshUrl() {
  const home = process.env.DSH_HOME;
  if (!home) return null;
  for (const f of ["web-daemon.out", "web-daemon.out.prev", "web-daemon.log"]) {
    const p = join(home, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const urls = [...text.matchAll(/https?:\/\/127\.0\.0\.1:3080[^\s"'<>`]*/g)].map((m) => m[0]);
    const t = urls.find((u) => /[?&](token|t|auth|key|code)=/i.test(u));
    if (t) return t;
  }
  return null;
}

const url = findDshUrl() ?? "http://127.0.0.1:3080/";
console.log(`chromium : ${CHROMIUM}`);
console.log(`url      : ${mask(url)}`);
if (!existsSync(CHROMIUM)) {
  console.error("chromium 不存在");
  process.exit(1);
}

const proc = spawn(
  CHROMIUM,
  [
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1500,1000",
    url,
  ],
  { stdio: "ignore", detached: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 30; i++) {
  await sleep(700);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      const v = await r.json();
      console.log(`\n✅ Chromium 已启动：${v.Browser}（${((i + 1) * 0.7).toFixed(1)}s）`);
      up = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
}
if (!up) {
  console.error("\n⛔ 调试端口未就绪");
  try { proc.kill(); } catch { /* ignore */ }
  process.exit(1);
}

await sleep(6000);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /127\.0\.0\.1:3080/.test(t.url));
console.log(`标签页标题 : ${page ? page.title : "(没找到 DSH 标签页)"}`);
console.log(`标签页 URL : ${page ? mask(page.url) : "-"}`);

// 直接问页面正文，确认不是「需要鉴权」那一句
if (page?.webSocketDebuggerUrl) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws fail")), { once: true });
  });
  const send = (id, method, params = {}) =>
    new Promise((resolve) => {
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        ws.removeEventListener("message", onMsg);
        resolve(m.result);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send(1, "Runtime.enable");
  const r = await send(2, "Runtime.evaluate", {
    expression: `JSON.stringify({
      title: document.title,
      len: ((document.body && document.body.innerText) || '').length,
      needsAuth: /authentication required/i.test((document.body && document.body.innerText) || ''),
      head: ((document.body && document.body.innerText) || '').replace(/\\s+/g,' ').trim().slice(0, 120),
    })`,
    returnByValue: true,
  });
  const info = JSON.parse(r.result.value);
  console.log(`\n页面标题   : ${info.title || "(空)"}`);
  console.log(`正文长度   : ${info.len}`);
  console.log(`需要鉴权   : ${info.needsAuth ? "是 ⛔" : "否 ✅"}`);
  console.log(`正文开头   : ${info.head}`);
  ws.close();
}

console.log("\n（Chromium 窗口保持打开，你可以直接用它）");
