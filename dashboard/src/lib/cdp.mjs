/**
 * 无头 Chrome + CDP 直连（不依赖 Playwright）。
 *
 * 为什么需要它：美团医药的部分路由（manageHome / poiInfo / businessStatus /
 * health center）是**网关级硬校验签名**，实测与参数、Referer、合成 mtgsig 都无关，
 * 一律返回 `403 openresty`。签名由页面内的风控 SDK（`window.H5guard`）hook XHR
 * 时自动追加 —— 所以正确做法是**借页面自己的手发请求**。
 *
 * Node 24 自带全局 `WebSocket`，因此直连 CDP 即可，无需 300MB 的 Playwright。
 *
 * ⚠️ 实测走通的连接方式（踩过坑，别改回去）：
 *   直连 **page target 自己的** `webSocketDebuggerUrl`，**不带 `sessionId`**。
 *   试过 `Target.attachToTarget{flatten:true}` + 在 browser 级 WS 上带 `sessionId` 发命令 ——
 *   Chrome 152 对此**完全不回包**（只有 `Target.*` 有响应），表现为 `Page.enable` 超时。
 *   排查线索：单独发 browser 域命令正常、带 sessionId 的命令石沉大海。
 *
 * 其它每条都对应一个「看起来像别的问题」的坑：
 *   - `--remote-allow-origins=*` 必加，否则 Chrome 111+ 拒绝 CDP 握手
 *   - spawn 必须 `stdio: 'ignore'`：受限沙箱下 piped stdio 会 EPERM
 *   - `Runtime.evaluate` 必须 `awaitPromise: true`，否则 Promise 直接返回 `{}`，
 *     表现为「接口没数据」，让人误以为 cookie 失效
 *   - 不要用 `toISOString()` 取本地日期（东八区晚 8 点后会变成明天）
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  throw new Error("未找到 Chrome/Edge。已查：\n" + BROWSER_CANDIDATES.join("\n"));
}

/** 一个 CDP 连接（直连某个 page target，命令不带 sessionId）。 */
export class Cdp {
  constructor(ws, proc) {
    this.ws = ws;
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.listeners = new Map(); // CDP 事件名 → Set<handler>

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return; // 非 JSON 帧，忽略
      }
      // 事件帧（无 id）：分发给订阅者
      if (!msg.id && msg.method) {
        const set = this.listeners.get(msg.method);
        if (set) for (const fn of set) { try { fn(msg.params); } catch { /* 单个订阅者出错不影响其它 */ } }
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        /**
         * ⭐ "Inspected target navigated or closed" 单独解释。
         * 这个报错本身完全看不出原因，实际绝大多数是**登录态失效后站点把我们重定向走了**
         * （我为此白查过一轮）。在这里统一附上提示，所有脚本都受益。
         */
        const m = String(msg.error.message ?? "");
        const hint = /navigated or closed|Target closed|Session closed/i.test(m)
          ? "\n  ↳ 页面在求值过程中离开了（多半是**登录态失效**被重定向到登录页）。\n" +
            "    先跑：node src/check-sessions.mjs  确认 profile 里还有没有 token；\n" +
            "    若已失效，请在调试浏览器窗口里重新登录后重试。"
          : "";
        p.reject(new Error(`CDP ${p.method} 失败：${m}${hint}`));
      } else {
        p.resolve(msg.result);
      }
    });

    // 连接断开要**明确报错**，否则一律表现为「超时」，会被误判成命令写错
    ws.addEventListener("close", (e) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`CDP 连接已关闭（code=${e.code}），${p.method} 未完成`));
      this.pending.clear();
    });
  }

  /** 订阅 CDP 事件（如 `Network.requestWillBeSent`）。 */
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  /**
   * 发一条 CDP 命令。
   *
   * ⚠️ `timeoutMs` 默认 45s，但对**页内长循环**必须显式调大 ——
   *    `Runtime.evaluate` 是一发一收：页内跑的循环越久，这里等得越久。
   *    实测：给订单列表加了「列表标签错误」自退避重试后（最多 10 次，退避 1.2s×n，
   *    光 sleep 就 66s），45s 直接被打爆，报 `CDP 超时：Runtime.evaluate`，
   *    现象是「脚本刚打印完签名就绪就挂」。
   *
   * ⚠️⚠️ **超时定时器必须随 Promise 一起收掉**。这是本项目最贵的隐形耗时
   *    （2026-09-21 量出来，之前一直以为是「取数本身慢」）：
   *      待触发的 `setTimeout` 会**把 Node 的事件循环钉住**，进程要等它到期才退出。
   *      于是 `timeoutMs: 240_000` 的今日取数写成：
   *        「活干完 4.9 秒，脚本总耗时 242.8 秒」—— 剩下 238 秒全在等定时器。
   *      曝光（timeout 180s）实测 207.3s、今日（240s）实测 242.8s，
   *      **每个数字都等于「真实工作时间 + timeout」**。
   *    两道防线：① 成功/失败都 `clearTimeout`；② 定时器 `unref()`，
   *    即使将来又有人在某条路径上忘了清，它也不再能拖住进程退出。
   */
  send(method, params = {}, { timeoutMs = 45_000 } = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP 连接已关闭，无法发送 ${method}`));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      // 不 unref 的话，它会让进程活到超时时刻才退出
      timer.unref?.();
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
    });
  }

  /**
   * 断开连接。
   *
   * ⚠️ 只断 WS，**不杀浏览器进程**（proc 为 null 说明是连到「用户自己启动的 Chrome」）。
   * 另外：如果这个会话**自己新开了标签页**（`createdTarget`），收尾时把它关掉，
   * 免得在你的日常浏览器里越积越多标签。
   */
  async close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    if (this.createdTarget && this.port) {
      const ok = await closeTarget(this.port, this.createdTarget);
      untrackTarget(this.port, this.createdTarget);
      /**
       * 超时不代表没关掉（请求已发出，Chrome 会照做），所以这里如实区分：
       * 拿到了确认就报「已关闭」，否则报「已发出请求」——
       * 不把「没等到回话」说成「已经关了」，也不说成「失败了」。
       */
      if (ok) console.log("   ↳ 已关闭本次工作用的标签页");
      else console.log("   ↳ 已发出关闭标签页的请求（未等确认，避免像以前那样卡几分钟）");
    }
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
    await sleep(400);
  }
}

/** 列出某个调试端口上的所有 target。 */
export async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!r.ok) throw new Error(`端口 ${port} /json/list 返回 HTTP ${r.status}`);
  return await r.json();
}

/**
 * 在**不碰你现有标签页**的前提下新开一个标签页，并返回它的 target。
 *
 * 为什么需要：如果直接复用浏览器里已有的 page target，
 * 我们一句 `Page.navigate` 就会把**你正在看的页面**导航走。
 * 当目标是「你自己的日常浏览器」时这不可接受（你可能正开着商家端/文档）。
 *
 * ⚠️ Chrome 111+ 禁用了 `GET /json/new`，必须用 **PUT**；这里 PUT 优先、GET 兜底。
 */
export async function openNewPage(port, url = "about:blank") {
  const u = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  let r = await fetch(u, { method: "PUT" }).catch(() => null);
  if (!r || !r.ok) r = await fetch(u).catch(() => null);
  if (!r || !r.ok) throw new Error(`创建新标签页失败：HTTP ${r ? r.status : "fetch failed"}`);
  const t = await r.json();
  if (!t?.webSocketDebuggerUrl) throw new Error("新标签页没有 webSocketDebuggerUrl");
  return t;
}

/**
 * 关掉某个 target（用于收拾我们新开的那个标签页）。
 *
 * ⚠️⚠️ **必须带超时**。这是本项目最贵的一个隐形耗时（2026-09-21 量出来的）：
 *   实测某个取数脚本「活干完只要 4.9 秒，脚本却跑了 242.5 秒」——
 *   剩下 237 秒全卡在这一行 `fetch('/json/close/...')` 上。
 *   机理：被关的标签页是美团控制台（开着 IM/推送 WebSocket + 重型微应用），
 *   Chrome 要等它 unload 完才回这个 HTTP 请求，而这里原本**没有超时**。
 *   对比：关一个轻页面（比如 about:blank）是毫秒级，所以这个问题只在
 *   「关的是繁忙业务页」时暴露，很容易被当成「取数本身慢」。
 *
 * ⚠️ 超时**不等于没关掉**：请求已经发出去，Chrome 会照做，我们只是不再等它回话。
 */
export async function closeTarget(port, targetId, { timeoutMs = 3000 } = {}) {
  if (!targetId) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 选一个 page target。
 *
 * ⚠️ 关于「抢占标签页」：如果端口后面是**用户日常浏览器**（标签页很多），
 * 直接复用现有页面会把用户正在看的页面导航走。所以：
 *   - 有 `about:blank` 就用它（最安全）
 *   - 否则若页面数超过 `busyThreshold`，**新开一个标签页**，用完关掉
 *   - 否则（专用调试浏览器，只有一两个页面）复用现有页面
 */
/** 我们新开过的「工作标签页」登记表：port -> Set<targetId> */
const LIVE_TARGETS = new Map();
let cleanupInstalled = false;

/**
 * 保证「脚本崩了也要把工作标签页收掉」。
 *
 * ⚠️ 为什么需要：取数脚本有 top-level await，一旦中途抛错（例如订单列表重试耗尽），
 *    就**走不到结尾的 `await cdp.close()`**，新开的标签页就留在用户的浏览器里。
 *    实测每跑一次泄漏一个（6→7→8…）。
 *    装了这两个处理器后，异常路径也会先清理再退出。
 */
function installCleanupOnCrash() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const cleanup = async () => {
    for (const [port, ids] of LIVE_TARGETS) {
      for (const id of ids) await closeTarget(port, id).catch(() => false);
    }
    LIVE_TARGETS.clear();
  };
  const onFatal = async (err) => {
    await cleanup();
    console.error(err);
    process.exit(1);
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
}

const trackTarget = (port, id) => {
  if (!id) return;
  if (!LIVE_TARGETS.has(port)) LIVE_TARGETS.set(port, new Set());
  LIVE_TARGETS.get(port).add(id);
};
const untrackTarget = (port, id) => LIVE_TARGETS.get(port)?.delete(id);

async function attachPageWs(port, { freshTab = "auto", busyThreshold = 3 } = {}) {
  const list = await listTargets(port);
  const pages = list.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));

  /**
   * ⚠️ 顺序很重要：**先判「忙不忙」，再找 about:blank**。
   * 反过来写的话，在你的日常浏览器里只要有一个空白标签页就会被复用并导航走 ——
   * 那个空白页很可能正是你刚按 Ctrl+T 准备用的。
   * 忙的时候一律**新开一个**，用完关掉，做到零足迹。
   */
  const busy = freshTab === true || (freshTab === "auto" && pages.length >= busyThreshold);
  let target = null;
  let createdId = null;

  if (busy) {
    target = await openNewPage(port, "about:blank");
    createdId = target.id;
    installCleanupOnCrash();
    trackTarget(port, createdId);
    console.log(
      `   ↳ 该端口有 ${pages.length} 个标签页，看起来是你的日常浏览器 —— 新开一个标签页工作，**不动你现有的任何页面**`,
    );
  } else {
    target = pages.find((t) => t.url === "about:blank") ?? pages[0];
  }
  target ??= list.find((t) => t.type === "page");

  if (!target?.webSocketDebuggerUrl) {
    throw new Error(
      `端口 ${port} 上没有可用 page target。现有：` +
        list.map((t) => `${t.type}:${t.url}`).join(", "),
    );
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP WebSocket 连接失败")), { once: true });
  });
  return { ws, target, createdId };
}

/**
 * 让一个已就绪的 Cdp 会话进入可驱动状态，并**验证渲染器真的会回话**。
 *
 * 这一步很关键：受限环境里 Chrome 的渲染子进程可能被静默拦截 ——
 * 表现为 WS 连得上、browser 域命令正常，但**所有 page 域命令石沉大海**。
 * 不主动验证的话，后续会误判成「cookie 失效」或「接口没数据」。
 * 实测（本机 DSH 沙箱）：`--dump-dom` 输出 0 字节且退出码为空，
 * 即渲染器根本没起来。
 */
async function preparePage(cdp) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  try {
    const v = await Promise.race([
      cdp.send("Runtime.evaluate", { expression: "1+1", returnByValue: true }),
      sleep(6000).then(() => null),
    ]);
    if (!v || v.result?.value !== 2) throw new Error("no-reply");
  } catch {
    throw new Error(
      "Chrome 渲染进程无响应（page 域命令收不到回复）。\n" +
        "  这通常意味着当前环境拦截了 Chrome 的渲染子进程，而不是代码或 cookie 的问题。\n" +
        "  验证方法：命令行跑 `chrome --headless=new --dump-dom https://example.com`，\n" +
        "  若输出 0 字节且退出码为空，即确认是环境拦截。\n" +
        "  对策：改由**你在自己的终端里**启动 Chrome，再用 connectToPage() 连上去。",
    );
  }
}

/**
 * 连接 **browser 级** CDP（而不是 page target）。
 *
 * 用途：`Storage.getCookies` / `Network.getAllCookies` 这类**不依赖渲染进程**的命令。
 *
 * ⭐ 为什么需要它：受限环境里 Chrome 的**渲染进程**可能被拦（page 域命令无响应），
 * 而且浏览器进程本身也可能在命令结束时被回收。
 * 但「读 cookie 存储」只需要 browser 级命令 + 几秒钟的存活时间，两者都不受影响。
 * 配合**持久化 profile**（登录态存在 `--user-data-dir` 里），
 * 即使 Chrome 反复重启，也能把登录态捞出来。
 */
export async function connectBrowser(port = 9222) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!r.ok) throw new Error(`端口 ${port} 无响应：HTTP ${r.status}`);
  const version = await r.json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("browser 级 CDP WebSocket 连接失败")), { once: true });
  });
  const cdp = new Cdp(ws, null);
  cdp.browser = version.Browser;
  return cdp;
}

/**
 * 用 Node 启动 Chrome 并**只等调试端口就绪**（不校验渲染器）。
 *
 * ⚠️ 与 `launchChrome` 的区别：这里**不调 `preparePage`**，所以
 * 即使渲染进程被环境拦截，只要端口能绑上就能用于「读 cookie」这类 browser 级操作。
 *
 * @returns {{ cdp: Cdp, proc: import('node:child_process').ChildProcess }}
 */
export async function launchChromeLite({ port = 9222, profile, headless = false, url = "about:blank" } = {}) {
  const exe = findBrowser();
  const profileDir = profile ?? join(ROOT, "_recon", "user-chrome");
  await mkdir(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "--disable-blink-features=AutomationControlled",
    `--user-data-dir=${profileDir}`,
    `--user-agent=${DESKTOP_UA}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    url,
  ];
  if (headless) args.unshift("--headless=new");

  const proc = spawn(exe, args, { stdio: "ignore", detached: false, windowsHide: false });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const cdp = await connectBrowser(port);
        return { cdp, proc };
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  try { proc.kill(); } catch { /* ignore */ }
  throw new Error(`Chrome 未在 25s 内绑定调试端口 ${port}`);
}

/** 读浏览器 cookie 存储（不需要渲染进程）。 */
export async function getAllCookies(cdp) {
  const r = await cdp.send("Storage.getCookies");
  return r?.cookies ?? [];
}

/**
 * 连接一个**已经在你机器上运行**的 Chrome/Edge。
 *
 * 启动方式（在你的终端里跑一次）：
 *   "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
 *     --remote-debugging-port=9222 --remote-allow-origins=* ^
 *     --user-data-dir="<项目根>\_recon\user-chrome" --no-first-run about:blank
 *
 * 之后 cookie 由脚本通过 CDP 注入，**不需要你在这个窗口里登录**。
 *
 * ⚠️ `freshTab` 默认 **"auto"**：专用调试浏览器（标签页少）**复用**现有标签页，
 *    不新开、不闪现；日常浏览器（标签页多，>= busyThreshold）才新开一个用完关掉。
 *    本项目 9222/9223 是**专用**调试浏览器（品牌A→Chrome、品牌B→Edge），复用即可，
 *    不会再「每次刷新都弹一个新标签页」。取数脚本会 `Page.navigate`，所以复用
 *    只影响专用浏览器里那个 about:blank/残留页，不碰任何人在看的页面。
 *    传 `{ freshTab: true }` 强制每次新开；`{ freshTab: false }` 强制复用。
 *
 * ⚠️ 本函数会校验渲染进程可用性（`preparePage`）。若环境拦截渲染进程，
 * 会抛出明确错误 —— 此时若只需要「读 cookie」，改用 `connectBrowser` / `launchChromeLite`。
 */
export async function connectToPage(port = 9222, { freshTab = "auto" } = {}) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const { ws, createdId } = await attachPageWs(port, { freshTab });
  const cdp = new Cdp(ws, null); // proc=null → close() 不会杀掉你的浏览器
  cdp.browser = version.Browser;
  cdp.port = port;
  cdp.createdTarget = createdId; // 收尾时关掉我们自己开的标签页
  await preparePage(cdp);
  return cdp;
}

/**
 * 启动无头 Chrome（停在 about:blank）并连上 page target。
 * @param {object} opts
 * @param {number}  [opts.port]     远程调试端口
 * @param {boolean} [opts.headless] false = 可见窗口（排障用）
 * @param {string}  [opts.profile]  用户数据目录（独立 profile，绝不碰用户日常浏览器）
 */
export async function launchChrome({ port = 9226, headless = true, profile } = {}) {
  const exe = findBrowser();
  const profileDir = profile ?? join(ROOT, "_recon", "chrome-profile");
  await mkdir(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*", // ⭐ 少了它 CDP 握手直接 403
    "--disable-blink-features=AutomationControlled",
    `--user-data-dir=${profileDir}`,
    `--user-agent=${DESKTOP_UA}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--window-size=1440,900",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");

  // ⚠️ stdio 必须是 ignore：沙箱下 piped stdio 会 EPERM
  const proc = spawn(exe, args, { stdio: "ignore", detached: false, windowsHide: true });

  // 等调试端口可用
  const deadline = Date.now() + 30_000;
  let version;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  if (!version) throw new Error(`Chrome 未在 30s 内就绪（端口 ${port}）`);

  // ⭐ 连 page target 自己的调试端点，而不是 browser 级的
  let ws;
  const tDeadline = Date.now() + 10_000;
  while (Date.now() < tDeadline && !ws) {
    try {
      ({ ws } = await attachPageWs(port));
    } catch {
      await sleep(300);
    }
  }
  if (!ws) {
    proc.kill();
    throw new Error("未找到可用的 page target");
  }

  const cdp = new Cdp(ws, proc);
  try {
    await preparePage(cdp);
  } catch (e) {
    await cdp.close(); // 自己启动的要负责收拾干净，别留孤儿进程
    throw e;
  }
  return cdp;
}

/**
 * 逐个注入 cookie —— 注入完页面就带登录态，**用户不必再手动登录**。
 *
 * ⚠️ `domain` 可以是数组：阿里系（melody.shop.ele.me）的关键 cookie
 * （`pf-token` / `bx-umidtoken`）常挂在 **`.ele.me` 父域**上，
 * 只按 `melody.shop.ele.me` 注入会漏掉，表现为"注入了却还是未登录"。
 *
 * ⛔⛔ **但传父域是有代价的，2026-09-22 真踩炸过一次，用之前务必看完**：
 *   本函数把 header 里的**每一个** cookie 写到**每一个**传入域上。
 *   闪购的会话 cookie（`WMSTOKEN` / `_m_h5_tk` / `_m_h5_tk_enc` / `biz_token` …）
 *   本来就挂在 `nr.ele.me`；一旦额外传了 `.ele.me` / `faas.ele.me`，
 *   就会在那些域上**复制出同名 cookie**，而且副本是**会话级、无过期时间**的，
 *   会**遮蔽服务端下发的正本**：
 *     · 正本（`.ele.me`）到期后，MTOP 的**票据自愈**（靠 Set-Cookie 换新）被副本挡住 →
 *       一直用废票据 → 整个闪购后台报 **`FAIL_SYS_ILLEGAL_ACCESS::非法请求`**
 *       + 「商户信息获取失败」，**看起来像掉登录，其实 `WMSTOKEN` 是好的**。
 *   **要把 cookie 投到 `.ele.me` 之前，先确认它本来就属于那个域**；拿不准就用单域。
 *   排查/修复工具：`_recon/_diag-cookies.mjs`（只读列出同名重复）、
 *   `_recon/_fix-cookies.mjs --apply`（删掉重复的 `_m_h5_tk*`，服务端会重新下发）。
 *
 * @param {string} cookieHeader `name=value; name=value`
 * @param {string|string[]} domain 一个或多个域，逐个注入
 */
export async function setCookies(cdp, cookieHeader, domain) {
  const domains = Array.isArray(domain) ? domain : [domain];
  let n = 0;
  for (const part of cookieHeader.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const i = seg.indexOf("=");
    if (i <= 0) continue;
    const name = seg.slice(0, i).trim();
    const value = seg.slice(i + 1).trim();
    for (const d of domains) {
      try {
        await cdp.send("Network.setCookie", { name, value, url: `https://${d}/`, domain: d });
      } catch {
        /* 某个域不接受（如带前导点的写法差异）时跳过，不要中断整体注入 */
      }
    }
    n++;
  }
  return n;
}

/**
 * 在页面上下文里求值；awaitPromise 必开，否则 Promise 直接变 `{}`。
 *
 * `timeoutMs` 默认 45s，**页内长循环务必调大**（含重试/翻页的循环很容易超过 45s）。
 */
export async function evaluate(cdp, expression, { timeoutMs = 45_000 } = {}) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    { timeoutMs },
  );
  if (r.exceptionDetails) {
    throw new Error(
      "页面内求值异常：" +
        (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)),
    );
  }
  return r.result.value;
}

/**
 * 判断一个 URL 是不是「被踢到登录页」了。
 *
 * ⭐ 2026-10-21 补全。此前只认 `/login|passport|\/sso\//`，而实测品牌B掉登录时的
 *    真实路径是**三段式**，第一段完全不含这些词：
 *      1) https://yiyao.meituan.com/main/frame      ← 我们导航的目标，200，看起来正常
 *      2) https://waimaie.meituan.com/              ← ~3s 后 SPA 自己跳走（不含 login/passport！）
 *      3) https://waimaie.meituan.com/?defaultLogonType=1&epassport_addr=…  ← 真正的登录网关
 *    然后第 3 段会**每 1.1 秒自刷新一次**，无限循环。
 *    所以判据必须把第 2 段也覆盖进来，否则在这一段落上会判成"没跳登录页"。
 *
 * 判据来源都是实测：`waimaie.meituan.com` 只出现在「需要登录」的兜底跳转里，
 * 医药/闪购的正常落地页分别是 `yiyao.meituan.com` 和 `nr.ele.me`。
 */
export function looksLikeLoginPage(href) {
  const h = String(href ?? "");
  if (!h) return false;
  // 通用特征
  if (/\/login|passport|\/sso\/|logonType|login_gw/i.test(h)) return true;
  // 美团商家端登录网关：裸根域，或带 defaultLogonType
  if (/^https?:\/\/waimaie\.meituan\.com\/?(\?|$)/i.test(h)) return true;
  return false;
}

/**
 * 导航后确认**没被踢到登录页**。
 *
 * ⭐ 为什么必须有这个检查：
 *   登录态失效时站点会 302 到 `waimaie.meituan.com/new_fe/login_gw#/login`。
 *   不拦的话，紧接着的 `Runtime.evaluate` 会抛
 *   **"Inspected target navigated or closed"** —— 这个报错完全看不出真正原因，
 *   我为此白查了一轮（还以为是自己脚本的连接问题）。
 *
 * ⚠️⚠️ **它只能当"快速闸门"，不能当"体检"**（2026-10-21 的教训）：
 *   实测那个跳转发生在 `Page.navigate` 之后 **约 3 秒**，而本函数在 navigate 返回后
 *   ~0.2s 就执行 —— 那一刻 location.href 还停在 `yiyao.meituan.com/main/frame`，
 *   于是**放行**，接着 `waitSignedReady` 才撞上跳转。
 *   所以真正的兜底检测在 `waitSignedReady` 里（它天然要轮询好几秒），
 *   本函数只负责「跳得很快」的那部分。
 *
 * @returns {Promise<string>} 当前 location.href
 */
export async function assertNotLoginRedirect(cdp, { label = "美团商家端" } = {}) {
  let href = "";
  try {
    href = await evaluate(cdp, "location.href", { timeoutMs: 15_000 });
  } catch (e) {
    throw new Error(
      `页面无法求值（${String(e.message).slice(0, 90)}）。\n` +
        `  最常见的原因是**登录态已失效**，站点把我们重定向走了。\n` +
        `  先跑：node src/check-sessions.mjs   确认 profile 里还有没有 token。`,
    );
  }
  if (looksLikeLoginPage(href)) {
    throw new Error(
      `⛔ 登录态已失效 —— 被重定向到：\n     ${href}\n` +
        `   请在该调试浏览器窗口里重新登录「${label}」，然后重跑本脚本。`,
    );
  }
  return href;
}

/**
 * 等风控 SDK 就绪。
 *
 * ⭐ 判据不用「对象存在」（`typeof window.H5guard !== 'undefined'` 不够 ——
 * 对象存在 ≠ 初始化完成，抢跑会拿到 403）。
 * 最可靠的判据是**在页内真的打一次签名接口，看它是不是 200**：
 * 成功了就说明签名链路确定是通的，此时再批量取数才稳。
 *
 * ⭐⭐ 2026-10-21：本函数**同时承担「掉登录」的最终检测**。
 *
 *   为什么放在这里：它是导航后唯一「天然要停留好几秒」的地方（每 1.5s 轮询一次），
 *   而掉登录的跳转发生在 navigate 之后约 3s —— `assertNotLoginRedirect` 在 0.2s
 *   就执行完了，根本等不到。实测品牌B 2026-10-14 起连续 7 天全挂，报错却是
 *   `CDP Runtime.evaluate 失败：Inspected target navigated or closed`（看不出真因），
 *   5 个 step 每个都在 3.5s 左右失败 —— 时间点正是这里的第一次或第二次轮询。
 *
 *   所以：轮询期间若 evaluate 抛「导航/目标已关闭」类错误，就**再读一次
 *   location.href 看它到底跳去了哪**：
 *     · 命中登录页特征 → 抛「⛔ 登录态已失效 —— 被重定向到 …」，一眼可读
 *     · 不命中但反复跳 → 抛「页面反复跳转，无法稳定求值」，附最后位置
 *     · 偶发一次 → 等一会儿重试（别把瞬时重排当故障）
 *
 * @param {string} probePath 用来验证签名链路的路由
 * @param {{timeoutMs?:number, label?:string}} [opts] label 只用于报错文案
 */
export async function waitSignedReady(cdp, probePath, { timeoutMs = 90_000, label = "美团商家端" } = {}) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let last = "(未开始)";
  let navHits = 0;

  while (Date.now() < deadline) {
    let out;
    try {
      out = await evaluate(
        cdp,
        `(async () => {
          const hasSdk = typeof window.H5guard !== 'undefined';
          let status = 0, err = null;
          try {
            const r = await fetch(${JSON.stringify(probePath)}, { credentials: 'include' });
            status = r.status;
          } catch (e) { err = String(e && e.message); }
          return { hasSdk, status, err, url: location.href, title: document.title };
        })()`,
      );
    } catch (e) {
      const msg = String(e && e.message);
      if (!/navigated or closed|Target closed|Session closed|Cannot find context/i.test(msg)) throw e;

      // 页面在求值过程中离开了 —— 问它去了哪
      navHits++;
      let href = "";
      try {
        href = await evaluate(cdp, "location.href", { timeoutMs: 8_000 });
      } catch {
        /* 又跳了，拿不到就先算了 */
      }
      if (looksLikeLoginPage(href)) {
        throw new Error(
          `⛔ 登录态已失效 —— 页面自己跳到了登录页：\n     ${href}\n` +
            `   请在该调试浏览器窗口里重新登录「${label}」，然后重跑本脚本。\n` +
            `   自查：node src/check-sessions.mjs   （注意它现在会告诉你「本域专属 cookie」有几项）`,
        );
      }
      if (navHits >= 4) {
        throw new Error(
          `页面反复跳转，无法稳定求值（已 ${navHits} 次）。最后位置：${href || "未知"}\n` +
            `   若不是登录问题，多半是站点在做一个密集的客户端重定向链，请附此日志排查。`,
        );
      }
      await sleep(1200);
      continue;
    }

    last = JSON.stringify(out);
    if (out.status === 200) return { ok: true, waitedMs: Date.now() - started, ...out };
    // 非 403/0 的其它状态说明签名链路已通，只是该路由本身另有问题
    if (out.status && out.status !== 403) {
      return { ok: true, partial: true, waitedMs: Date.now() - started, ...out };
    }
    await sleep(1500);
  }
  throw new Error(`等待签名就绪超时（${timeoutMs}ms），最后状态：${last}`);
}

/**
 * 等页面**真正稳定**（而不是固定 sleep 猜一个数）。
 *
 * ⭐ 为什么需要（2026-10-21）：`fetch-ka.mjs` 原来在 `Page.navigate` 之后写死
 *    `await sleep(9000)`。单独跑一直没问题，但放进 `refresh-account.ps1` 的
 *    步骤序列里就偶发失败：
 *
 *      Error: CDP Runtime.evaluate 失败：Inspected target navigated or closed
 *
 *    原因是这个 promote 步骤紧跟在 exposure 之后、共用同一个浏览器：上一个
 *    进程刚放手、页面还在导航，ka 自己的 SSO 也可能在 9 秒之后才慢跳一次。
 *    固定 sleep 对「9.1 秒才发生的事」无能为力。
 *
 *    改成轮询 `location.href` + `document.readyState`：
 *      · 连续 `stableMs` 毫秒 href 不变且 readyState=complete → 认为稳定
 *      · 期间若 context 被销毁（页面在跳）→ 不算失败，继续等
 *      · 跳到了登录页 → 立刻给可读报错，不让你看天书
 *
 * ⚠️ 它只保证「页面不再乱跳」，**不保证 SPA 的业务初始化已完成**。
 *    所以不要把原有的 sleep 直接删掉（那是在等前端把接口层准备好），
 *    而是在 sleep 之后再调它兜底。
 */
export async function waitPageSettled(cdp, { timeoutMs = 20_000, stableMs = 800, label = "页面" } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastHref = "";
  let stableSince = 0;

  while (Date.now() < deadline) {
    let out;
    try {
      out = await evaluate(cdp, "({ href: location.href, state: document.readyState })", { timeoutMs: 8_000 });
    } catch (e) {
      const msg = String(e && e.message);
      if (/navigated or closed|Target closed|Session closed|Cannot find context/i.test(msg)) {
        // 页面正在跳 —— 这正是我们要等的情况，不算失败
        stableSince = 0;
        await sleep(600);
        continue;
      }
      throw e;
    }
    const href = String(out?.href ?? "");
    if (looksLikeLoginPage(href)) {
      throw new Error(
        `⛔ 登录态已失效 —— 页面跳到了登录页：\n     ${href}\n` +
          `   请重新登录「${label}」后重跑本脚本。`,
      );
    }
    if (href === lastHref && out?.state === "complete") {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return { href, waitedMs: Date.now() - started };
    } else {
      lastHref = href;
      stableSince = 0;
    }
    await sleep(400);
  }
  throw new Error(`等待${label}稳定超时（${timeoutMs}ms），最后位置：${lastHref || "未知"}`);
}

/**
 * 在页面里批量发请求（签名由 SDK 自动加）。
 *
 * ⚠️ 分页务必**在页内循环**，别来回跑 CDP；返回体先在页内精简再回传，
 * 否则大列表会把 CDP 消息撑爆。
 *
 * @param {Array<{key:string, path:string, method?:string, form?:object, limit?:number}>} specs
 */
export async function pageFetchAll(cdp, specs) {
  const raw = await evaluate(
    cdp,
    `(async () => {
      const specs = ${JSON.stringify(specs)};
      const out = {};
      for (const s of specs) {
        const rec = { key: s.key, path: s.path };
        try {
          const init = { credentials: 'include', headers: {} };
          if (s.method === 'POST') {
            init.method = 'POST';
            if (s.json !== undefined) {
              init.headers['Content-Type'] = 'application/json';
              init.body = JSON.stringify(s.json);
            } else {
              init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
              init.body = new URLSearchParams(s.form || {}).toString();
            }
          }
          const r = await fetch(s.path, init);
          rec.status = r.status;
          const text = await r.text();
          try {
            const j = JSON.parse(text);
            rec.code = j.code;
            rec.msg = j.msg;
            let d = j.data;
            const cap = s.limit || 500;
            if (Array.isArray(d) && d.length > cap) d = d.slice(0, cap);
            rec.data = d;
          } catch {
            rec.text = text.slice(0, 300);
          }
        } catch (e) {
          rec.error = String((e && e.message) || e);
        }
        out[s.key] = rec;
      }
      return JSON.stringify(out);
    })()`,
  );
  return JSON.parse(raw);
}
