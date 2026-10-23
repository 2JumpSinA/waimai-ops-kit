/**
 * 标签页内存回收 · 方案 C（休眠式回收）
 * ============================================================================
 * 把「已经采完、超出闲置阈值」的页面导航到一个**离线休眠提示页**，再向浏览器
 * 施加一次内存压力建议，让 renderer 真正 GC 并把文档树 / JS 堆 / 站点遗留
 * worker 的内存还给系统。**标签页本身保留**，点刷新（F5）即可恢复原页面，
 * 登录态是 cookie（在浏览器进程里），不受影响。
 *
 * ⛔ 本模块的红线（违反任意一条都是事故，不是 bug）：
 *   1. **绝不关标签页** —— 只用 `Page.navigate`，全程不调 `/json/close`、
 *      不调 `Target.closeTarget`、不调 `Page.close`。
 *   2. **绝不 kill 进程** —— 模块内没有任何进程操作。
 *   3. **绝不动 cookie** —— 不碰 Network.* / Storage.* / document.cookie。
 *   4. **绝不碰正在被采集的页面** —— 见下方三道闸门。
 *
 * ---------------------------------------------------------------------------
 * 三道闸门（任何一道不过 → 整轮放弃，返回 skipped=true，一个页面都不动）
 *   A. 采集锁 —— `_recon/refresh.lock`（与 refresh-all.ps1 同格式 `pid|started|scope`）
 *   B. 采集时间窗 —— 默认 08:25–08:40
 *   C. 逐页闲置阈值 —— 页面 `performance.timeOrigin` 距今 ≥ `minAliveMin`（默认 60min）
 *
 * ⚠️ **关于 `only:"hidden"` 的勘误（2026-10-22，mem-verifier 独立复核推翻）**：
 *   本模块第一版把 `visibilityState === "hidden"` 当作「用户没在看」的判据。
 *   这是**伪安全**：两个调试浏览器窗口平时就压在后台/不在最前，它们的页面
 *   **永远**是 hidden。实测 7/7 页面全 hidden —— 该判据在真实场景等价于
 *   「全都回收」。所以它**不能**作为默认放行依据。
 *   现在 `only="hidden"` 仅作为**附加**条件保留（默认不启用），真正的门槛是
 *   `minAliveMin`（页面存活时长）+ `maxPerRound`（单轮上限）。
 *
 * ⚠️ **只导航不压力 = 几乎没效果（同轮实测）**：
 *   只做 `Page.navigate → 空白页`，renderer WorkingSet 基本不降（三档对照：
 *   业务页 1884MB → 仅导航 1986MB，反而 +5%）。原因是站点遗留的 Dedicated
 *   Worker 不随顶层文档销毁，仍占着 renderer。必须补一次
 *   `Memory.simulatePressureNotification(level:"critical")` + `HeapProfiler.collectGarbage`，
 *   实测降到 1147MB（-39%，9222 -55%）。这就是本模块 `pressure:true` 默认打开的原因。
 */

import { readFileSync, existsSync, statSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_LOCK = resolve(ROOT, "_recon", "refresh.lock");
const DEFAULT_LOG = resolve(ROOT, "_recon", "reclaim.log");

/** 采集窗口：这段时间内一律不回收（采集正在用页面）。与 keepalive 同口径。 */
export const COLLECT_WINDOW = { startMin: 8 * 60 + 25, endMin: 8 * 60 + 40 };

/** 默认闲置阈值（分钟）：页面存活不足这么久的不回收。 */
export const DEFAULT_MIN_ALIVE_MIN = 60;
/** 默认单轮上限：每次最多休眠几个页面（宁可多次小步，不要一把清空）。 */
export const DEFAULT_MAX_PER_ROUND = 2;

/**
 * 数据页标记：休眠页 URL 以它开头，用于「恢复原 URL」与「识别已休眠」。
 * 纯 `data:` URL，不发起任何网络请求。
 */
export const SLEEP_DATA_PREFIX = "data:text/html;charset=utf-8,";

/** 休眠提示页 HTML（离线自包含，无任何外链）。 */
export function sleepPageHtml({ url = "", reclaimedAt = "" } = {}) {
  const safeUrl = String(url).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  /**
   * ⚠️ 关键行为澄清（实测 2026-10-22）：
   *   `data:` 文档上按 **F5 只会重新加载这个休眠页本身**，不会回到原页面
   *   （data: URL 不会被 page.reload「退回」到上一个 http 页面）。
   *   所以页面上必须放一个**真实可点的链接**指向原 URL —— 点击它才是真正的恢复。
   *   文案不能再说「按 F5 恢复」，那会骗人。
   */
  const href = safeUrl.startsWith("http") ? safeUrl : "#";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>已休眠 · 点链接即可恢复</title>
<style>
  html,body{margin:0;height:100%}
  body{display:flex;align-items:center;justify-content:center;
       font:16px/1.7 "Microsoft YaHei",system-ui,sans-serif;
       background:#f5f6f8;color:#333}
  .box{max-width:600px;padding:40px 32px;text-align:center;
       background:#fff;border-radius:14px;box-shadow:0 2px 20px rgba(0,0,0,.07)}
  h1{font-size:22px;margin:0 0 14px;color:#1f2430}
  .k{color:#0b7a3e;font-weight:600}
  p{margin:8px 0;color:#555}
  a.restore{display:inline-block;margin:20px 0 6px;padding:11px 26px;border-radius:9px;
    background:#2b5bd7;color:#fff;text-decoration:none;font-weight:600;font-size:16px}
  a.restore:hover{background:#1f47ab}
  a.plain{color:#2b5bd7;font-size:13px;word-break:break-all}
  .hint{margin-top:20px;font-size:13px;color:#8a8f99;line-height:1.6}
  .tag{display:inline-block;margin-top:18px;padding:5px 14px;border-radius:99px;
       background:#eef3ff;color:#2b5bd7;font-size:13px}
</style></head>
<body><div class="box">
  <h1>💤 此页面已休眠</h1>
  <p>为了给这台机器腾内存，这个标签页的内容已被释放。</p>
  <p class="k">登录态不受影响，不需要重新登录。</p>
  <a class="restore" href="${href}" target="_self">点击这里恢复原页面</a>
  <div class="hint">
    标签页没有被关闭，它只是睡着了。<br>
    注意：<b>按 F5 不会恢复</b>（刷新只会重新显示这个提示页），请点上面的按钮或链接。
  </div>
  <a class="plain" href="${href}" target="_self">${safeUrl}</a>
  <div class="tag">休眠时间：${reclaimedAt || "—"}</div>
</div></body></html>`;
}

/** 生成休眠页 data: URL（encodeURIComponent 编码，保证中文正确）。 */
export function sleepPageUrl(info) {
  return SLEEP_DATA_PREFIX + encodeURIComponent(sleepPageHtml(info));
}

/** 是否已经是我们放的休眠页。 */
export function isSleepUrl(url) {
  return typeof url === "string" && url.startsWith(SLEEP_DATA_PREFIX);
}

/** 空白页判定：这些 URL 视为「已经是空的」，无需再动。 */
export function isBlankUrl(url) {
  if (!url) return true;
  return (
    url === "about:blank" ||
    url === "" ||
    url.startsWith("chrome://newtab") ||
    url.startsWith("edge://newtab") ||
    url === "about:newtab" ||
    isSleepUrl(url)
  );
}

/** 这个 target 是否值得回收（只有 http/https 业务页才有回收价值）。 */
export function isReclaimable(url) {
  return /^https?:\/\//i.test(url || "");
}

/* ------------------------------------------------------------------ *
 * 闸门 A：采集锁
 * ------------------------------------------------------------------ */

/**
 * 检查 `_recon/refresh.lock`。
 * 格式见 refresh-all.ps1：`<pid>|<started ISO>|<scope>`。
 * @returns {{locked:boolean, reason?:string, pid?:number, ageMin?:number}}
 */
export function checkRefreshLock({ lockPath = DEFAULT_LOCK, staleMin = 15 } = {}) {
  if (!existsSync(lockPath)) return { locked: false };
  let raw = "";
  try {
    raw = readFileSync(lockPath, "utf8").split(/\r?\n/)[0] ?? "";
  } catch {
    return { locked: true, reason: "refresh.lock 存在但读不到（保守视为采集进行中）" };
  }
  const pid = Number((raw.split("|")[0] ?? "").trim());
  let ageMin = null;
  try {
    ageMin = (Date.now() - statSync(lockPath).mtimeMs) / 60000;
  } catch {
    /* ignore */
  }
  if (Number.isInteger(pid) && pid > 0) {
    let alive = false;
    try {
      process.kill(pid, 0); // 0 号信号 = 只探测存活，不发送任何信号
      alive = true;
    } catch (e) {
      alive = e?.code === "EPERM"; // 权限不足 = 进程存在
    }
    if (alive) return { locked: true, pid, ageMin, reason: `refresh.lock 持有者 pid ${pid} 仍存活` };
    return {
      locked: false, stale: true, pid, ageMin,
      reason: `refresh.lock 是残留（pid ${pid} 已退出${ageMin == null ? "" : `，文件 ${ageMin.toFixed(1)} 分钟前`}）`,
    };
  }
  if (ageMin != null && ageMin <= staleMin) {
    return { locked: true, ageMin, reason: `refresh.lock 仅 ${ageMin.toFixed(1)} 分钟且无可用 pid（保守视为采集进行中）` };
  }
  return { locked: false, stale: true, ageMin, reason: "refresh.lock 无法解析且已过期" };
}

/* ------------------------------------------------------------------ *
 * 闸门 B：采集时间窗
 * ------------------------------------------------------------------ */

export function inCollectWindow(now = new Date(), win = COLLECT_WINDOW) {
  const min = now.getHours() * 60 + now.getMinutes();
  return min >= win.startMin && min <= win.endMin;
}

/* ------------------------------------------------------------------ *
 * 逐页探测 / 导航 / 压力（只读探测 + 唯一的写动作）
 * ------------------------------------------------------------------ */

/** 通过 target ws 读页面状态。只读。 */
export function probePage(t, { timeoutMs = 4000 } = {}) {
  return new Promise((resolveProbe) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch { /* ignore */ }
      resolveProbe(v);
    };
    let ws;
    try {
      ws = new WebSocket(t.webSocketDebuggerUrl);
    } catch (e) {
      return resolveProbe({ ok: false, err: `WebSocket 构造失败: ${e?.message ?? e}` });
    }
    const timer = setTimeout(() => finish({ ok: false, err: "probe 超时" }), timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: {
          expression:
            "JSON.stringify({vis:document.visibilityState,focus:document.hasFocus()," +
            "t0:Math.round(performance.timeOrigin),href:location.href.slice(0,300)})",
          returnByValue: true,
        },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id !== 1) return;
        clearTimeout(timer);
        const val = m.result?.result?.value;
        if (!val) return finish({ ok: false, err: m.result?.exceptionDetails?.text ?? "无返回值" });
        const o = JSON.parse(val);
        finish({
          ok: true, vis: o.vis, focus: !!o.focus,
          aliveMin: o.t0 ? Math.round((Date.now() - o.t0) / 60000) : null,
          href: o.href,
        });
      } catch (e) {
        clearTimeout(timer);
        finish({ ok: false, err: `解析失败: ${e?.message ?? e}` });
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, err: "ws 错误" }); };
    ws.onclose = () => { clearTimeout(timer); finish({ ok: false, err: "ws 提前关闭" }); };
  });
}

/** 发送一串 CDP 命令并在最后一响后等 settleMs。 */
function cdpBatch(t, calls, { timeoutMs = 9000, settleMs = 300 } = {}) {
  return new Promise((resolveCall) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch { /* ignore */ }
      resolveCall(v);
    };
    let ws;
    try {
      ws = new WebSocket(t.webSocketDebuggerUrl);
    } catch (e) {
      return resolveCall({ ok: false, err: `WebSocket 构造失败: ${e?.message ?? e}` });
    }
    const timer = setTimeout(() => finish({ ok: false, err: "CDP 超时" }), timeoutMs);
    let left = calls.length;
    const errors = [];
    ws.onopen = () => {
      let id = 1;
      for (const c of calls) ws.send(JSON.stringify({ id: id++, method: c.method, params: c.params ?? {} }));
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id == null) return;
        if (m.error) errors.push(`${calls[m.id - 1]?.method ?? "?"}: ${m.error.message}`);
        if (--left <= 0) {
          clearTimeout(timer);
          setTimeout(() => finish({ ok: errors.length === 0, errors }), settleMs);
        }
      } catch {
        /* 事件帧，忽略 */
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, err: "ws 错误" }); };
    ws.onclose = () => { clearTimeout(timer); finish({ ok: done ? true : false, err: done ? undefined : "ws 提前关闭" }); };
  });
}

/**
 * 把单个 target 导航到休眠提示页。
 * ⚠️ 只发 `Page.navigate`；**不发** `Page.close` / `Target.closeTarget` / `/json/close`。
 */
export function navigateToSleep(t, url, { timeoutMs = 9000 } = {}) {
  return cdpBatch(t, [
    { method: "Page.enable" },
    { method: "Page.navigate", params: { url } },
  ], { timeoutMs, settleMs: 400 });
}

/**
 * 向一个仍存活的 target 施加内存压力，促使浏览器 GC。
 *
 * ⚠️ **这不是「无害只读」操作，别当随时可发的玩具**（2026-10-22 复核实测）：
 *   - `Memory.simulatePressureNotification(level:"critical")` 会让**整个浏览器
 *     实例**进入内存紧张态（不只是这个 tab），Chrome/Edge 会因此丢弃各处的
 *     缓存、触发全实例 GC。
 *   - 真正让 renderer **退出**的主要是这条压力通知；`HeapProfiler.collectGarbage`
 *     只对当前文档做一次显式 GC，作用有限。
 *   - **实测出的副作用（重要）**：压力之后，**未被回收的其他业务页会被冻结**
 *     —— 浏览器层完全正常（`/json/version`、`Target.getTargets`、标题都在），
 *     但对该 page 域发 CDP 命令会超时（3s 不响应）持续数分钟。
 *     解法：对该 target 发一次 `Target.activateTarget` 立即唤醒（实测 3007ms 超时 → 3ms OK）。
 *     本模块在 `pressure` 之后会自动做这一步（见 `wakeFrozenPages()`），
 *     避免留下「看着还在、点开才活」的假死标签页。
 *   - 但它是**建议**不是强杀：不会崩溃、不动 cookie、不动其他标签的内容。
 *
 *   因此：只在「刚把一个页面休眠掉」这个明确的时机发，不要周期性地对全浏览器发。
 */
export function sendMemoryPressure(t, { timeoutMs = 8000 } = {}) {
  return cdpBatch(t, [
    { method: "Memory.simulatePressureNotification", params: { level: "critical" } },
    { method: "HeapProfiler.collectGarbage" },
  ], { timeoutMs, settleMs: 500 });
}

/**
 * 唤醒被内存压力冻住的页面（**副作用修复**）。
 *
 * 实测（mem-verifier，2026-10-22）：施压后未被回收的其他业务页会「假死」——
 * 浏览器层健康、target 在、标题在，但对它发 CDP 命令 3s 超时，持续数分钟。
 * 发一次 `Target.activateTarget` 立即恢复（实测 3007ms 超时 → 3ms OK）。
 *
 * 做法（极轻，约 10ms/页）：
 *   1. 对每个 **未回收** 的 page target 发 `Runtime.evaluate('1')`，3s 超时
 *   2. 超时的 → 发 `Target.activateTarget` 唤醒，再复测一次
 *
 * ⚠️ `Target.activateTarget` 只是把标签**切到前台**（等同用户点一下那个标签），
 *    不导航、不改内容、不关页。为了减少对用户视觉的打扰，本函数只在
 *    「探不到（超时）」时才激活，探得到的一律不动。
 *
 * @returns {Promise<{checked:number, frozen:number, woken:number, details:Array}>}
 */
export async function wakeFrozenPages(port, { excludeIds = [], probeTimeoutMs = 3000 } = {}) {
  const skip = new Set(excludeIds);
  const details = [];
  let checked = 0, frozen = 0, woken = 0;

  let pages;
  try {
    pages = await fetchPages(port);
  } catch {
    return { checked: 0, frozen: 0, woken: 0, details, error: "列表不可达" };
  }

  for (const t of pages) {
    if (skip.has(t.id)) continue;
    checked++;

    // 1) 只读探测：能 eval 就说明没冻，直接跳过
    const alive = await cdpBatch(t, [
      { method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } },
    ], { timeoutMs: probeTimeoutMs, settleMs: 0 }).catch(() => ({ ok: false }));

    if (alive?.ok) { details.push({ id: t.id, state: "ok" }); continue; }

    frozen++;
    // 2) 冻住了 → 激活唤醒（等同用户点一下这个标签）
    const act = await cdpBatch(t, [
      { method: "Target.activateTarget", params: { targetId: t.id } },
    ], { timeoutMs: probeTimeoutMs, settleMs: 200 }).catch(() => ({ ok: false }));

    // 3) 再探一次确认
    const again = await cdpBatch(t, [
      { method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } },
    ], { timeoutMs: probeTimeoutMs, settleMs: 0 }).catch(() => ({ ok: false }));

    if (again?.ok) {
      woken++;
      details.push({ id: t.id, state: "woken" });
    } else {
      details.push({ id: t.id, state: "still-frozen", activateOk: act?.ok ?? false });
    }
  }

  return { checked, frozen, woken, details };
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

async function fetchPages(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const all = await r.json();
  return all.filter((t) => t.type === "page" && !String(t.url || "").startsWith("devtools://"));
}

/**
 * 休眠某个端口下的标签页。
 *
 * @param {number} port
 * @param {object} opts
 * @param {boolean} opts.dryRun         默认 **true**。false 才真的导航。
 * @param {number}  opts.minAliveMin    闲置阈值（分钟），默认 60。页面存活不足的不碰。
 * @param {number}  opts.maxPerRound    单轮最多休眠几个，默认 2。0 = 不限。
 * @param {string}  opts.only           "age"（默认，只看闲置阈值）| "age+hidden"（额外要求不可见）
 * @param {boolean} opts.pressure       导航后是否追发内存压力，默认 true（关掉几乎无收益）
 * @param {boolean} opts.force          跳过闸门 A/B（仍需闸门 C）。默认 false
 * @param {string[]} opts.whitelist     这些 URL 前缀的页面永不回收
 * @param {string}  opts.lockPath       自定义锁路径（测试用）
 * @param {string}  opts.logPath        回收日志路径；null = 不写
 *
 *   日志格式（UTF-8、Tab 分隔）：`ISO时间  :端口  targetId  存活Nmin  压力=sent|failed  原URL`。
 *   ⚠️ 读法：文件本身是 **UTF-8**。用 PowerShell 读必须
 *   `Get-Content -LiteralPath _recon\reclaim.log -Encoding UTF8`，
 *   否则默认按 GBK 解码会显示成 `瀛樻椿` 之类乱码（**文件没坏**）。
 */
export async function reclaimTabs(port, opts = {}) {
  const {
    dryRun = true,
    minAliveMin = DEFAULT_MIN_ALIVE_MIN,
    maxPerRound = DEFAULT_MAX_PER_ROUND,
    only = "age",
    pressure = true,
    force = false,
    whitelist = [],
    lockPath = DEFAULT_LOCK,
    logPath = DEFAULT_LOG,
  } = opts;

  const out = {
    port, dryRun, skipped: false, skipReason: null,
    minAliveMin, maxPerRound, only, pressure,
    pages: [], lock: null, checkedAt: new Date().toISOString(),
  };

  /* ---- 闸门 A：采集锁 ---- */
  const lock = checkRefreshLock({ lockPath });
  out.lock = lock;
  if (lock.locked && !force) {
    out.skipped = true;
    out.skipReason = `采集进行中：${lock.reason}`;
    return out;
  }

  /* ---- 闸门 B：时间窗 ---- */
  if (inCollectWindow() && !force) {
    out.skipped = true;
    out.skipReason = "处于采集时间窗 08:25–08:40 内（采集正在用页面）";
    return out;
  }

  let pages;
  try {
    pages = await fetchPages(port);
  } catch (e) {
    out.skipped = true;
    out.skipReason = `端口 ${port} 不可达：${e?.message ?? e}`;
    return out;
  }

  // 收集候选：先全部探测，再按门槛筛，最后按存活时间从长到短取 maxPerRound 个
  const candidates = [];
  for (const t of pages) {
    const rec = {
      id: t.id, title: (t.title || "").slice(0, 50), url: t.url,
      before: t.url, after: t.url, action: "keep", probe: null, err: null,
    };
    out.pages.push(rec);

    if (!isReclaimable(t.url)) { rec.action = "skip:非业务页"; continue; }
    if (isSleepUrl(t.url)) { rec.action = "skip:已是休眠页"; continue; }
    if (whitelist.some((w) => w && t.url.startsWith(w))) { rec.action = "skip:白名单"; continue; }

    const probe = await probePage(t);
    rec.probe = probe;
    if (!probe.ok) {
      rec.action = "skip:探测失败（状态不明，保守不碰）";
      rec.err = probe.err;
      continue;
    }
    if (probe.aliveMin == null) {
      rec.action = "skip:取不到页面存活时间（保守不碰）";
      continue;
    }
    if (probe.aliveMin < minAliveMin) {
      rec.action = `skip:存活 ${probe.aliveMin}min < 阈值 ${minAliveMin}min`;
      continue;
    }
    if (only === "age+hidden" && probe.vis === "visible") {
      rec.action = "skip:用户正在看（visible）";
      continue;
    }
    rec.action = "candidate";
    candidates.push({ t, rec, aliveMin: probe.aliveMin });
  }

  // 单轮限量：存活越久越优先
  candidates.sort((a, b) => b.aliveMin - a.aliveMin);
  const limit = maxPerRound > 0 ? maxPerRound : candidates.length;
  const chosen = new Set(candidates.slice(0, limit).map((c) => c.rec.id));
  for (const c of candidates) {
    if (!chosen.has(c.rec.id)) {
      c.rec.action = `skip:超出单轮上限 ${limit}（按存活时长排队，下轮优先）`;
    }
  }
  out.candidates = candidates.length;
  out.chosen = chosen.size;

  /* ---- 执行 ---- */
  for (const c of candidates) {
    if (!chosen.has(c.rec.id)) continue;
    if (dryRun) { c.rec.action = "would-reclaim"; continue; }

    const sleepUrl = sleepPageUrl({ url: c.rec.before, reclaimedAt: new Date().toLocaleString("zh-CN", { hour12: false }) });
    const nav = await navigateToSleep(c.t, sleepUrl);
    if (nav.ok) {
      c.rec.action = "reclaimed";
      c.rec.after = SLEEP_DATA_PREFIX + "(休眠页)";
      c.rec.sleepUrlLen = sleepUrl.length;
    } else {
      c.rec.action = "failed";
      c.rec.err = nav.err ?? (nav.errors ?? []).join("; ");
    }
  }

  /* ---- 压力 + 日志 ---- */
  if (!dryRun && out.chosen > 0) {
    if (pressure) {
      /**
       * ⚠️ 必须在**导航之后重新抓一次 target 列表**再发压力。
       *   复用导航前的 `c.t` 对象是不可靠的：它的 `webSocketDebuggerUrl` 指向的
       *   调试会话在 Page.navigate 之后通常已随旧文档销毁，发过去多半被丢弃，
       *   于是「导航了但没回收」，看起来像方案完全无效（本轮实测过这个坑）。
       *   重新抓列表拿到的 ws 才是当前（休眠页）文档的会话。
       *
       * ⚠️ 而且**发送本身也可能失败**（target 会话正在换、ws 提前关闭）。
       *   实测：pressure=failed 的那一轮，内存完全不降 —— 这正是「静默失效」。
       *   所以这里：失败 → 重抓列表 → 最多补发 2 次；仍失败则记 warn，
       *   并把 `pressure:"failed"` 留在结果里，让调用方/日志看得见，绝不静默。
       */
      const MAX_ATTEMPTS = 3;
      for (const c of candidates) {
        if (c.rec.action !== "reclaimed") continue;
        if (!pressure) continue;
        let lastErr = null;
        let sent = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !sent; attempt++) {
          try {
            const fresh = await fetchPages(port);
            const t = fresh.find((x) => x.id === c.rec.id);
            if (!t) { lastErr = "重抓列表找不到该 target（可能已被采集复用）"; break; }
            const r = await sendMemoryPressure(t).catch((e) => ({ ok: false, err: String(e?.message ?? e) }));
            if (r?.ok) sent = true;
            else lastErr = r?.err ?? (r?.errors ?? []).join("; ") ?? "unknown";
          } catch (e) {
            lastErr = String(e?.message ?? e);
          }
          if (!sent && attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 400));
        }
        c.rec.pressure = sent ? "sent" : "failed";
        if (!sent) {
          c.rec.pressureError = lastErr;
          c.rec.warn = `内存压力发送失败（已重试 ${MAX_ATTEMPTS} 次）：${String(lastErr).slice(0, 100)} —— 该页已休眠但内存可能没降`;
        }
      }
      out.pressureFailed = candidates.filter((c) => c.rec.pressure === "failed").length;
      out.pressureSent = candidates.filter((c) => c.rec.pressure === "sent").length;

      /**
       * ⚠️ 必做的副作用修复（2026-10-22 复核实测）：
       *   内存压力会让**未被回收的其他业务页被冻结** —— 浏览器层健康（target 在、
       *   标题在），但对该 page 发 CDP 命令超时数分钟，用户点开才"活过来"。
       *   这不致命（不丢数据、不掉登录、不影响采集），但会留下「看着还在、
       *   点开才活」的假死标签页，比空白页更难理解。
       *   所以压完立刻把没被回收的页面探一遍，冻住的用 Target.activateTarget 唤醒。
       *   约 10ms/页；探得到的一律不动（不会打扰用户）。
       */
      try {
        const wk = await wakeFrozenPages(port, { excludeIds: [...chosen] });
        out.wake = { checked: wk.checked, frozen: wk.frozen, woken: wk.woken, details: wk.details };
        for (const p of out.pages) {
          const d = wk.details?.find((x) => x.id.startsWith(p.id.slice(0, 8)));
          if (d) p.wakeState = d.state;
        }
      } catch (e) {
        out.wake = { error: String(e?.message ?? e) };
      }
    }
    if (logPath) {
      try {
        for (const c of candidates) {
          if (c.rec.action !== "reclaimed") continue;
          appendFileSync(
            logPath,
            `${new Date().toISOString()}\t:${port}\t${c.rec.id}\t存活${c.aliveMin}min\t` +
              `压力=${c.rec.pressure ?? "-"}\t${c.rec.before}\n`,
            "utf8",
          );
        }
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
  }

  return out;
}

/** 人类可读的一行摘要。 */
export function summarize(r) {
  const n = r.pages.filter((p) => p.action === "reclaimed" || p.action === "would-reclaim").length;
  return `:${r.port} ${r.dryRun ? "[dry-run] " : ""}${r.skipped ? `跳过(${r.skipReason})` : `${n}/${r.pages.length} 待休眠`}`;
}
