/**
 * 看板「刷新」按钮的后端执行器：跑 refresh-all.ps1 并把日志写到文件。
 *
 * ⛔ 为什么子进程输出走**文件**而不是管道：
 *   1. 本机沙箱不允许程序打开命名管道 —— `stdio:'pipe'` 会直接 EPERM。
 *      这不是「换个写法就能过」的限制，是环境边界。
 *   2. 走文件反而更好：日志**随时可 tail**，服务重启后历史还在，
 *      而且不需要在内存里缓冲几十分钟的输出。
 *   所以用 `stdio: ['ignore', fd, fd]`（fd 是打开的文件句柄，不是管道）。
 *
 * ⛔ 安全：**绝不能**从请求里取命令或参数拼接执行。
 *   这里只认三个白名单 scope，命令与参数全是代码里写死的字面量。
 */
import { openSync, closeSync, writeSync, mkdirSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOG_DIR = join(ROOT, "_recon");
const LOG_FILE = join(LOG_DIR, "refresh-web.log");
const RAW_DIR = join(ROOT, "data", "raw");

/** ⭐ 命令与参数**全部写死**；scope 只用于在白名单里选一组字面量 */
const SCOPES = {
  quanyi: { label: "品牌A", args: ["-Only", "quanyi"] },
  yifeng: { label: "品牌B", args: ["-Only", "yifeng"] },
  both: { label: "两个项目", args: ["-Only", "both"] },
};

export const SCOPE_KEYS = Object.keys(SCOPES);
export const scopeLabel = (k) => SCOPES[k]?.label ?? k;

/** 保留日志末尾这么多字符（页面只展示尾部） */
const TAIL_CHARS = 20000;

export class RefreshRunner {
  constructor({ scriptPath = join(ROOT, "refresh-all.ps1") } = {}) {
    this.scriptPath = scriptPath;
    this.child = null;
    this.state = {
      running: false,
      scope: null,
      scopeLabel: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      logFile: LOG_FILE,
    };
    mkdirSync(LOG_DIR, { recursive: true });
  }

  /** 当前状态 + 日志尾部 + **文件级的进度证据** */
  status() {
    return {
      ...this.state,
      elapsedMs: this.state.startedAt
        ? (this.state.finishedAt ? new Date(this.state.finishedAt) : new Date()) - new Date(this.state.startedAt)
        : null,
      log: this.tailLog(),
      progress: this.progressByFiles(),
      scopes: SCOPE_KEYS.map((k) => ({ key: k, label: SCOPES[k].label })),
    };
  }

  /**
   * ⭐ **不依赖日志的**进度信号：本次运行开始后，data/raw 里有哪些文件被改写。
   *
   * 为什么需要它：子进程的 stdout 是**带缓冲**的（非 TTY 时 Node/PowerShell 都会攒够
   * 一块才写），所以「日志几分钟没动」**不等于**「卡住了」。实测就发生过：
   * 用户以为卡死 3 分钟，其实 exposure-quanyi.json 正在被写。
   * 文件 mtime 是**无条件可信**的进展证据 —— 它不经过任何缓冲。
   */
  progressByFiles() {
    if (!this.state.startedAt) return null;
    const since = new Date(this.state.startedAt).getTime();
    const out = [];
    try {
      for (const f of readdirSync(RAW_DIR)) {
        if (!f.endsWith(".json")) continue;
        const p = join(RAW_DIR, f);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.mtimeMs >= since) out.push({ file: f, mtime: st.mtime, size: st.size, msAgo: Date.now() - st.mtimeMs });
      }
    } catch { return null; }
    out.sort((a, b) => a.msAgo - b.msAgo);
    return { changedCount: out.length, newest: out[0] ?? null, files: out.slice(0, 12) };
  }

  /**
   * 服务启动时把日志清成一行说明。
   * 不这样做的话，新开的服务会读到**上一次运行**留下的日志，
   * 页面在点刷新前就可能显示一堆过期内容，看着像「正在跑」。
   */
  resetLog(note = "服务已启动，尚未刷新") {
    try {
      const fd = openSync(LOG_FILE, "w");
      writeSync(fd, `${note}\n`);
      closeSync(fd);
    } catch { /* 写不了就算了，status 会返回空日志 */ }
  }

  tailLog() {
    try {
      if (!existsSync(LOG_FILE)) return [];
      const buf = readFileSync(LOG_FILE, "utf8");
      const text = buf.length > TAIL_CHARS ? buf.slice(-TAIL_CHARS) : buf;
      /**
       * ⚠️ 必须**也按裸 `\r` 切**。
       *    取数脚本的进度是 `process.stdout.write("\r 已取 100/949 单…   ")` ——
       *    只有回车、没有换行。原先按 `/\r?\n/` 切，几十次进度会被压成**一整行**
       *    （实测日志 3 行、第 3 行是一坨几万个空格），页面上等于没有进度。
       */
      return text
        .split(/\r\n|\r|\n/)
        .map((l) => l.replace(/\s+$/, ""))
        .filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  }

  /**
   * 启动一次刷新。
   * @param {string} scope — 必须是 SCOPE_KEYS 之一（调用方负责校验，这里再校验一次）
   */
  start(scope) {
    if (this.state.running) {
      const err = new Error("已有刷新在进行中");
      err.code = "ALREADY_RUNNING";
      throw err;
    }
    if (!SCOPES[scope]) {
      const err = new Error(`未知范围：${scope}`);
      err.code = "BAD_SCOPE";
      throw err;
    }
    if (!existsSync(this.scriptPath)) {
      const err = new Error(`找不到 ${this.scriptPath}`);
      err.code = "NO_SCRIPT";
      throw err;
    }

    // 截断日志，让本次运行从干净状态开始（页面不会看到上一次的残留）
    const header =
      `=== 看板内刷新 ${new Date().toLocaleString("zh-CN")} · 范围=${SCOPES[scope].label} ===\n` +
      `（由 src/serve-dashboard.mjs 触发，等同于双击 refresh.cmd）\n\n`;

    /**
     * ⚠️ 必须用 `openSync` 拿**同步的 fd 数字**。
     *    我第一版用 `createWriteStream(...)` —— 它是**异步**打开的，
     *    进 `spawn` 时 `stream.fd` 还是 `null`，Node 直接报
     *    `The argument 'stdio' is invalid`。这不是沙箱问题，是 API 用法错了。
     */
    let fd;
    try {
      fd = openSync(LOG_FILE, "w");
    } catch (e) {
      const err = new Error(`打不开日志文件 ${LOG_FILE}：${e.message}`);
      err.code = "NO_LOG";
      throw err;
    }
    writeSync(fd, header);

    const args = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", this.scriptPath,
      ...SCOPES[scope].args,
      "-NoPause", // 无控制台，绝不能让它等按键
      "-NoOpen",  // 页面会自己 reload，别再弹第二个看板
    ];

    let child;
    try {
      /**
       * ⛔ **不要加 `detached: true`。**
       *
       * 我试过：目的是让刷新活过「看板」控制台被关（关窗口会给整个控制台发
       * CTRL_CLOSE_EVENT，把正在跑的刷新一起杀掉 —— 真实翻过这个车）。
       * 但对照实验（`_recon/_diag-detached.mjs`，同一替身脚本只改这一个参数）证明：
       *   detached=false → 230ms、写了标记、日志 41 字节  ✅
       *   detached=true  →  84ms、**零输出、零标记、日志 0 字节**，脚本根本没执行 ❌
       * 所以在本机 Windows + fd stdio 的组合下 detached 是坏的，不能用于生产。
       *
       * 改用**自愈**代替（见 serve-dashboard.mjs 启动时的 dashboardStale 检查）：
       * 数据比看板新就自动重建，所以「刷新被中途杀掉」不会再留下陈旧看板。
       */
      child = spawn("powershell", args, {
        cwd: ROOT,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
    } catch (e) {
      try { closeSync(fd); } catch { /* ignore */ }
      const err = new Error(`启动失败：${e.message}`);
      err.code = "SPAWN_FAILED";
      throw err;
    }

    this.child = child;
    this.state = {
      running: true,
      scope,
      scopeLabel: SCOPES[scope].label,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: null,
      logFile: LOG_FILE,
    };

    const finish = (code, error = null) => {
      if (!this.state.running) return;
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
      this.state.exitCode = code;
      this.state.error = error;
      this.child = null;
      try { writeSync(fd, `\n[serve] 结束，退出码 ${code}\n`); } catch { /* ignore */ }
      try { closeSync(fd); } catch { /* ignore */ }
    };

    child.on("error", (e) => {
      finish(null, e.message);
    });
    child.on("exit", (code) => {
      finish(code);
    });

    return this.status();
  }

  /** 服务退出时尽量收尾（不强杀：刷新跑一半被杀会留下半套数据） */
  dispose() {
    if (this.child && !this.child.killed) {
      this.child.unref?.();
    }
  }
}

export const refreshLogPath = LOG_FILE;
export const refreshLogSize = () => (existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0);
