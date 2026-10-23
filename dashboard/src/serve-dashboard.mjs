/**
 * 看板的**本地服务模式**：让 dashboard.html 上的「刷新」按钮真正能同步数据。
 *
 *   node src/serve-dashboard.mjs [--port=8790] [--no-open]
 *
 * ⛔ 为什么非要有服务：
 *   `dashboard.html` 平时是**双击用 file:// 打开**的静态单文件。
 *   浏览器里的页面**不可能**启动 Node、写磁盘、开 CDP —— 所以「点一下同步数据」
 *   在 file:// 下**物理上做不到**。这不是实现偷懒，是浏览器的安全模型。
 *
 * ✅ 但这是**加法**，不是替换：
 *   · file:// 打开 → 照样能看，离线可用；按钮显示「需在服务模式下打开」并给出命令
 *   · 服务模式打开 → 按钮可用，点击触发 refresh-all.ps1，日志实时回显，完成后自动重载
 *
 * 安全（本地服务也当公网对待，成本很低）：
 *   1. 只绑 127.0.0.1，不监听外网
 *   2. 校验 Host 头 ∈ {127.0.0.1, localhost, [::1]} —— 挡 DNS rebinding
 *   3. POST /api/refresh 必须带 `X-Refresh-Token`（启动时随机生成，注入到页面里）。
 *      **自定义头**跨站带不上，且我们从不回 CORS 头，所以浏览器预检会挡住 CSRF。
 *   4. 命令与参数全是代码里的字面量，请求只能选白名单 scope，**绝不拼接执行**
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, statSync, readdirSync, openSync, closeSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RefreshRunner, SCOPE_KEYS, scopeLabel, refreshLogPath } from "./lib/refresh-runner.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD = join(ROOT, "dashboard.html");
const RAW_DIR = join(ROOT, "data", "raw");

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "8790"));
const NO_OPEN = process.argv.includes("--no-open");
const DEFAULT_SCOPE = arg("scope", "current");
/**
 * `--script=<路径>` —— 把刷新换成别的脚本，**仅供测试**（默认就是 refresh-all.ps1）。
 * 有了它，就能用替身脚本端到端验证「点按钮 → 起进程 → 回显日志 → 完成」整条路，
 * 而不必真的跑一次十几分钟的刷新。是命令行参数，**不从 HTTP 取**，所以不构成注入面。
 */
const SCRIPT = arg("script", join(ROOT, "refresh-all.ps1"));

const TOKEN = randomBytes(18).toString("hex");
const runner = new RefreshRunner({ scriptPath: SCRIPT });
// 新服务从干净日志开始，避免页面在点刷新前显示上一次的残留
runner.resetLog("（服务已启动，尚未刷新）");

const HOST_OK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const hostOf = (req) => String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

/**
 * ⭐ 自愈：若数据文件比 dashboard.html 新，就自动重建一次。
 *
 * 为什么需要它：
 *   刷新有可能被**中途杀掉**（最典型：用户在刷新期间关掉了「看板」控制台窗口，
 *   子进程与它共用控制台，CTRL_CLOSE_EVENT 会连子进程一起杀）。
 *   结果是数据文件更新了、看板没重建 —— 用户看到「数据还是没有更新」。
 *   与其要求用户别关窗口（做不到），不如**打开看板时自动对齐一次**：
 *   数据新于看板 → 重建；否则秒过。build-dashboard 是纯本地计算，安全。
 */
function autoRebuildIfStale() {
  let newestData = 0;
  try {
    for (const f of readdirSync(RAW_DIR)) {
      if (!f.endsWith(".json")) continue;
      try { newestData = Math.max(newestData, statSync(join(RAW_DIR, f)).mtimeMs); } catch { /* ignore */ }
    }
  } catch { return; }
  const dashMtime = existsSync(DASHBOARD) ? statSync(DASHBOARD).mtimeMs : 0;
  if (newestData <= dashMtime) return; // 看板已是最新

  console.log("  [自愈] 数据比看板新，先重建看板再让你看…");
  try {
    const fd = openSync(join(ROOT, "_recon", "auto-rebuild.log"), "w");
    const t0 = Date.now();
    const child = spawn(process.execPath, ["src/build-dashboard.mjs"], {
      cwd: ROOT, stdio: ["ignore", fd, fd], windowsHide: true,
    });
    child.on("exit", (code) => {
      try { writeSync(fd, `\n[自愈] build exit ${code}, ${Date.now() - t0}ms\n`); } catch { /* ignore */ }
      try { closeSync(fd); } catch { /* ignore */ }
      console.log(`  [自愈] ${code === 0 ? "看板已重建 ✅" : `重建失败 exit ${code}，看日志 _recon/auto-rebuild.log`}`);
    });
  } catch (e) {
    console.log(`  [自愈] 重建启动失败：${e.message}`);
  }
}

/** 把 token 与默认范围注入静态页；**不写回文件**，dashboard.html 保持自包含 */
function serveHtml(res) {
  if (!existsSync(DASHBOARD)) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("dashboard.html 不存在，先跑：node src/build-dashboard.mjs");
    return;
  }
  let html = readFileSync(DASHBOARD, "utf8");
  const inject =
    `<script>window.__DSH_REFRESH__=${JSON.stringify({
      token: TOKEN,
      defaultScope: DEFAULT_SCOPE,
      scopes: SCOPE_KEYS.map((k) => ({ key: k, label: scopeLabel(k) })),
    })};</script>`;
  html = html.includes("</head>") ? html.replace("</head>", inject + "\n</head>") : inject + html;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store", // 重新构建后刷新页面就能看到新数据
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

const server = createServer((req, res) => {
  const host = hostOf(req);
  if (!HOST_OK.has(host)) {
    json(res, 403, { error: `Host 不被允许：${host}` });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) { serveHtml(res); return; }

  if (req.method === "GET" && path === "/api/status") { json(res, 200, runner.status()); return; }

  if (req.method === "GET" && path === "/api/ping") {
    json(res, 200, { ok: true, version: 1, scopes: SCOPE_KEYS, logFile: refreshLogPath });
    return;
  }

  if (req.method === "POST" && path === "/api/refresh") {
    /**
     * ⛔ 自定义头 = CSRF 防线。跨站点请求无法设置自定义头，
     *    而浏览器会先发预检；我们**从不返回 CORS 头**，预检必然失败。
     */
    if (req.headers["x-refresh-token"] !== TOKEN) { json(res, 403, { error: "token 不对" }); return; }

    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let scope = DEFAULT_SCOPE;
      try { scope = JSON.parse(body || "{}").scope ?? DEFAULT_SCOPE; } catch { /* 用默认 */ }
      /**
       * ⚠️ 页面负责把「当前项目」解析成真实项目键再发过来 —— 服务端不知道你在看哪个项目。
       *    所以这里**不猜**：`current` 之类一律 400，免得刷错账号还看不出来。
       */
      if (!SCOPE_KEYS.includes(scope)) {
        json(res, 400, { error: `scope 不合法：${scope}（应为 ${SCOPE_KEYS.join(" / ")}）` });
        return;
      }
      try {
        const st = runner.start(scope);
        console.log(`[refresh] 开始 · ${scopeLabel(scope)}`);
        json(res, 202, st);
      } catch (e) {
        json(res, e.code === "ALREADY_RUNNING" ? 409 : 500, { error: e.message, code: e.code ?? null });
      }
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n⛔ 端口 ${PORT} 已被占用 —— 可能已经有一个看板服务在跑。`);
    console.error(`   直接打开它打印的地址即可；或换端口：node src/serve-dashboard.mjs --port=8791\n`);
  } else {
    console.error(`\n⛔ 服务启动失败：${e.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/?token=${TOKEN}`;
  console.log("");
  console.log("  看板服务已启动（服务模式下「刷新」按钮可用）");
  console.log(`  地址： ${url}`);
  console.log(`  日志： ${refreshLogPath}`);
  console.log("");
  console.log("  · ⚠️ 刷新期间不要关这个窗口 —— 关掉会把正在跑的刷新一起杀掉");
  console.log("    （子进程与它共用控制台）。看板本身仍可双击用 file:// 打开。");
  console.log("  · 只想刷新不想开页面：双击 refresh.cmd 也一样");
  console.log("");

  // 启动即自愈（放在 listen 之后，不阻塞首屏）
  autoRebuildIfStale();

  if (!NO_OPEN) {
    // best-effort：失败不影响服务本身
    try {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch { /* 用户可手动打开打印出的地址 */ }
  }
});

const bye = () => { runner.dispose(); server.close(() => process.exit(0)); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
