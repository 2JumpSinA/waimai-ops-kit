/**
 * 登录态**保活** —— profile 体检 + 对健康账号做「打开首页 → 停留 ≥N 秒 → 关闭」，
 * 让平台自己的活跃心跳把凭证有效期往后推。
 *   node src/keepalive-sessions.mjs [--dwell=秒] [--dry-run] [--json] [--ignore-window] [--port=9223:9333]
 *
 * ⚠️ 用户参数一律写在**脚本名之后**：写在 `node` 前面会被 node 自己的参数解析吃掉
 *    （实测 `node --port=... src/x.mjs` 直接报 `bad option`）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 定位：`check-sessions.mjs` 只回答「坏没坏」，本脚本回答「顺手续命」。
 *   - 判据**不是**这里写的，而是 `src/lib/sessions.mjs` 的 `checkTarget()`，与体检脚本同一份代码。
 *     两套判据打架时没有任何一方会报警（2026-10-21 品牌B挂 7 天的根因）。
 *   - 参考「访问保活」思路：检测成功后**停留数秒**，页面自己发业务请求，
 *     服务端据此刷新会话活跃时间 —— 我们不需要主动发任何东西。
 *
 * ⛔ 六条硬纪律（违反会静默损坏登录态或与采集打架）：
 *   1. **绝不注入 / 删除 cookie**。只用页面自己的请求。曾因注入 157 条把 jar 污染到 19.8KB，
 *      导致每次请求 400 `Cookie Too Large`、看起来像全员掉登录。
 *   2. **只导航各平台首页**，不点菜单、不填表单、不提交任何东西。
 *   3. **不健康就不导航**。掉登录时导航只会被踢到登录页，既无用又多一条失败记录。
 *   4. **端口 DOWN 必须如实报「不可测」**，绝不当成健康静默成功。
 *   5. ⛔ **08:25–08:40 避让采集窗口**（`WaimaiDashboardRefresh` 08:30:01 起跑，实测 98–280 秒，
 *      最晚到 08:34:39）。采集**没有端口互斥**，且 `refresh-account.ps1` 会 kill 占端口的进程 ——
 *      两边同时动同一端口会互相拆台。落在这个窗口内就直接报「不可测」并以退出码 2 结束，
 *      **不做任何导航**（用 `--ignore-window` 可强制跑，仅供人工排障）。
 *   6. ⛔ **不 kill 任何进程、不导航采集正在用的标签页**：走 `connectToPage()`，
 *      它自己判断「忙不忙」（专用调试浏览器 1-2 页时复用、忙时新开一个用完关掉）。
 *
 * ── 登录页判定（评审实测校准，别改回「导航后立刻看 href」）──
 *   美团掉登录是 **navigate 后约 3 秒**才跳（`cdp.mjs` / HANDOVER 均有记录），
 *   而 `assertNotLoginRedirect` 在 0.2s 就放行了。所以本脚本：
 *     · 跳转判定用 `looksLikeLoginPage()`（已覆盖 `waimaie.meituan.com` 裸根域与三段式）；
 *     · **不早退**：即使中途看到登录页，也继续观察到「停留时长用完」，
 *       并要求**最后 ≥4 秒内 href 稳定**才算数 —— 慢跳不会漏，正常重定向链也不会误判。
 *
 * ── 退出码（本脚本自定义，因为 check-sessions.mjs 恒 exit 0，不能靠它报警）──
 *   0  **全部正常**：每个账号都健康并已保活
 *   1  **可疑**：没有失效账号，但有账号因「端口没开 / 保活导航失败 / 采集窗口冲突」没做成
 *   2  **失效**：至少一个账号需重新登录（人工动作，脚本不代做登录）
 *   3  **不可测**：脚本参数非法或自身异常（连体检都没跑完）
 *   计划任务判读：`0` 安静；`1` 记一条 WARN；`2` 必须人工介入。
 *
 * ⚠️ 传 `--json` 时 stdout 只有一段 JSON，便于包装脚本/其他工具解析。
 */
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToPage, evaluate, looksLikeLoginPage } from "./lib/cdp.mjs";
import { TARGETS, checkTarget, makeProfileReader } from "./lib/sessions.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = resolve(ROOT, ".secrets");
const REFRESH_LOCK = resolve(ROOT, "_recon", "refresh.lock");

// ── 参数 ──
const argOf = (name) => process.argv.find((a) => a.startsWith(`--${name}=`));
/** 默认停留 10 秒：8–12 是稳妥区间 —— 太短页面还没发出业务心跳，太长纯占采集的时间窗。 */
const DEFAULT_DWELL = 10;
/**
 * 稳定观察窗：要求「**最后** STABLE_MS 毫秒内 href 没变过」才算正常。
 *
 * 评审实测（2026-10-22 第二轮）暴露了上一版的错：
 *   我原来把停留 5 秒时的窗降到 3 秒，以为能避免误报 —— **无效**。
 *   连跑两次两个 ka 账号都报 suspicious，第二次连品牌B美团医药也可疑，
 *   因为 ka（SSO）的落地稳定只有 **0.9–1.1 秒**，无论 3 秒还是 4 秒窗都不达标。
 * 所以改成两条：
 *   - `--dwell` 下限提到 **8 秒**（原本 5）：5 秒的停留窗本身就不够，
 *     而且跑两次都误报，属于「给了个坏选项」，不如直接拒掉；
 *   - SSO 型（ka）**不参与稳定窗判定** —— 它的落地页是自动鉴权重定向链，
 *     天然一直在跳，稳定窗对它没有意义。对它只用「是否落到登录页」判。
 */
const stableWindowMs = (sec) => Math.min(4000, Math.max(3000, Math.round(sec * 1000 * 0.6)));
/** 采集窗口（本地时刻，分钟数）。避让理由见头注释第 5 条。 */
const COLLECT_WINDOW = { startMin: 8 * 60 + 25, endMin: 8 * 60 + 40 };

const dwellArg = argOf("dwell");
const DWELL_SEC = (() => {
  if (!dwellArg) return DEFAULT_DWELL;
  const v = Number(dwellArg.split("=")[1]);
  // 下限 8 秒：实测 5 秒时 SSO 落地稳定仅 0.9–1.1s，稳定窗必然不达标 → 次次误报。
  if (!Number.isFinite(v) || v < 8 || v > 120) {
    console.error(
      `⛔ --dwell 取值应为 8-120 秒，收到：${dwellArg.split("=")[1]}\n` +
        `   （下限 8 不是随手定的：实测停留 5 秒时 SSO 落地只稳定 0.9–1.1s，` +
        `稳定窗必然不达标，会把健康账号误报成可疑。默认 10 秒。）`,
    );
    process.exit(3);
  }
  return v;
})();
const STABLE_MS = stableWindowMs(DWELL_SEC);
const DRY_RUN = process.argv.includes("--dry-run");
const AS_JSON = process.argv.includes("--json");
const IGNORE_WINDOW = process.argv.includes("--ignore-window");
/** `--port=9223:9333`（冒号分隔，避免和 node 的 `--port` 撞车）：把目标端口 9223 指到实际 9333 —— 只用于**降级隔离测试**。 */
const portOverride = {};
for (const a of process.argv.filter((x) => x.startsWith("--port="))) {
  const [from, to] = a.split("=")[1].split(":").map(Number);
  if (from && to) portOverride[from] = to;
  else {
    console.error(`⛔ --port 格式应为 --port=目标:实际（如 --port=9223:9333），收到：${a}`);
    process.exit(3);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ⛔ `--json` 模式下 stdout **必须是纯净的一段 JSON**（本文件头注释承诺过）。
 *
 * 坑（评审 2026-10-22 复验发现）：`cdp.mjs` 的 `connectToPage()` 会直接
 * `console.log("↳ 该端口有 N 个标签页…")`，那些提示**不经过本脚本的 `log()`**，
 * 于是混在 JSON 前面（实测 12 行），解析器必须先剥前缀才能用。
 *
 * 修法：把 `console.log` 整体改道到 **stderr**，但**先把原始实现存下来** `stdoutRaw`，
 * 供最后那一段 JSON 专用（否则 JSON 自己也会被改道走，stdout 变成空 —— 我第一次就这么写错了）。
 *   - 覆盖的是**全局** console，所以 `cdp.mjs`、`cookie.mjs` 等所有下游模块的
 *     `console.log` 一并被拦住，无需逐个改（也不该去改那些共用模块的行为）。
 *   - 提示信息仍然**没有丢**：人看终端时 stderr 一样可见，只是不再污染 stdout。
 *   - 必须在参数解析**之后**、任何下游调用**之前**执行。
 */
const AS_JSON_EARLY = process.argv.includes("--json");
const stdoutRaw = console.log.bind(console);
if (AS_JSON_EARLY) {
  console.log = (...a) => console.error(...a);
}

const log = (...a) => { if (!AS_JSON) console.log(...a); };

/**
 * 采集窗口避让。
 * 除「本地时刻落在 08:25–08:40」之外，也认 `_recon/refresh.lock`：
 * 锁存在 = 采集正在跑，此时任何导航都可能撞车。
 *
 * ⚠️ 锁文件里若是上一个进程崩掉留下的**陈旧锁**，会挡住保活。所以按 mtime 判：
 *    超过 15 分钟就认为陈旧，忽略（refresh-all 单次最长实测 280 秒，15 分钟足够宽松）。
 */
function collectWindowReason() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (!IGNORE_WINDOW && mins >= COLLECT_WINDOW.startMin && mins <= COLLECT_WINDOW.endMin) {
    return `本地时刻 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} 落在采集窗口 08:25–08:40 内`;
  }
  if (!IGNORE_WINDOW && existsSync(REFRESH_LOCK)) {
    try {
      const ageMin = (Date.now() - statSync(REFRESH_LOCK).mtimeMs) / 60000;
      if (ageMin <= 15) return `_recon/refresh.lock 存在且仅 ${ageMin.toFixed(1)} 分钟（采集正在跑）`;
    } catch {
      /* 读不到就当没有 */
    }
  }
  return null;
}

/**
 * 一次「打开首页 → 停留 → 关闭」。
 *
 * ⛔⛔ **A19：必须 `freshTab: true`**（2026-10-22 评审实测的副作用，不是猜测）。
 *
 *   `connectToPage()` 默认 `freshTab:"auto"`，而 `busyThreshold = 3` ——
 *   调试浏览器常态只有 **2 个 page**，于是 `busy=false`，走
 *   `pages.find(about:blank) ?? pages[0]`（`cdp.mjs:297`），**直接 navigate pages[0]**。
 *   评审用 `performance.timeOrigin` 拿到硬证据：跑完保活后，经营者原来开着的
 *   `nr.ele.me` / `yiyao` 页面存活仅 15s / 10s、`navType=navigate` —— **被整页重载了**；
 *   target id 前后 4/4 全同，正是「复用而非新建」的反证。
 *
 *   危害两条：① 采集进行中若被复用同一 page，正是
 *   `Inspected target navigated or closed`（与掉登录同形）的触发路径；
 *   ② 经营者正在看的页面被刷掉。
 *
 *   所以这里**强制新开标签页**，用完由 `cdp.close()`（内部走 `closeTarget`）关掉。
 *   代价是调试浏览器里会短暂多一个 tab，远小于「刷掉用户页面」的代价。
 *
 * 停留期间**只读地**轮询 location/title/readyState（无任何交互），同时记录
 * 「最后一次 href 变化时刻」，用于最后判断有没有稳定 ≥STABLE_MS。
 *
 * ⭐ A5：返回值带 `href` / `title` / `navType` —— 让日志能**自证**
 *   「真导航到目标页了」而不是「空跑报 ok」。
 *
 * `fatal: true` 表示「这个端口整体不可用」（连不上 / 无页面 / 渲染进程被拦），
 * 此时同端口后续账号不必再试；**单个账号的慢跳/超时不是 fatal**，不能连坐。
 */
async function dwellHomepage(t, seconds) {
  const started = Date.now();
  const deadline = started + seconds * 1000;
  let cdp = null;
  let lastHref = "";
  let lastTitle = "";
  let navType = "";
  let lastChangeAt = started;
  let requests = 0;
  let navHits = 0;
  const fatalOf = (msg) => /fetch failed|ECONNREFUSED|没有可用 page target|渲染进程无响应|WebSocket|CDP 连接已关闭/i.test(msg);
  try {
    // ⛔ freshTab: true —— 见上面 A19 的长注释。绝不复用经营者/采集正在用的页面。
    cdp = await connectToPage(t.port, { freshTab: true });
    // ⛔ 只导航首页。不点菜单、不填表单、不提交。
    const nav = await cdp.send("Page.navigate", { url: t.homeUrl }, { timeoutMs: 25_000 });
    if (nav?.errorText) throw new Error(`导航失败：${nav.errorText}`);

    while (Date.now() < deadline) {
      await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
      let snap;
      try {
        snap = await evaluate(
          cdp,
          `({ href: location.href, title: document.title, state: document.readyState,
              res: (performance.getEntriesByType('resource')||[]).length,
              navType: (performance.getEntriesByType('navigation')[0]||{}).type || '' })`,
          { timeoutMs: 8000 },
        );
      } catch (e) {
        const msg = String(e?.message ?? "");
        // 站点密集重定向：本身是不健康信号，别硬等
        if (/navigated or closed|Target closed|Session closed|Cannot find context/i.test(msg)) {
          if (++navHits >= 6) throw new Error(`页面反复跳转，无法稳定求值（${navHits} 次）`);
          continue;
        }
        throw e;
      }
      const href = String(snap?.href ?? "");
      if (snap?.title) lastTitle = String(snap.title);
      if (snap?.navType) navType = String(snap.navType);
      if (href && href !== lastHref) {
        lastHref = href;
        lastChangeAt = Date.now();
      }
      requests = Math.max(requests, Number(snap?.res ?? 0));
    }

    /**
     * ⭐ 判定放在**停留结束之后**，不是导航后立刻看 ——
     *    评审实测：`waimaie.meituan.com` 裸根域是正常的过渡段，早期判定两头翻车
     *    （正常慢跳被误判，真失效被漏判）。两道判据：
     *      ① 落到登录页 → 失效；
     *      ② 最后 STABLE_MS 内 href 一直没变 → 稳定，正常；
     *      ③ 一直变到最后一个采样点 → 「未稳定」，报可疑而不是正常。
     */
    const stableMs = Date.now() - lastChangeAt;
    const kicked = looksLikeLoginPage(lastHref);
    /**
     * ⭐ SSO 型（ka）**不参与稳定窗判定**：它的落地页是自动鉴权重定向链，
     *    实测稳定只有 0.9–1.1s，天然一直在跳。对这类只用「是否落到登录页」判 ——
     *    硬套稳定窗只会把健康账号误报成可疑（评审 2026-10-22 第二轮实测）。
     *    ⚠️ 其他平台（美团医药 / 闪购）**保留**稳定窗，那里才是 3 秒慢跳的真实场景。
     */
    const ssoType = !!t.sso;
    const ok = !kicked && (ssoType || stableMs >= STABLE_MS);
    return {
      ok,
      kicked,
      stableMs,
      href: lastHref,
      title: lastTitle,
      navType,
      totalMs: Date.now() - started,
      requests,
      reason: kicked
        ? "导航后落到登录页"
        : !ok ? `最后 ${(stableMs / 1000).toFixed(1)}s 内页面仍在跳转（未稳定，需 ≥${(STABLE_MS / 1000).toFixed(0)}s）` : "",
    };
  } catch (e) {
    const msg = String(e?.message ?? e);
    return { ok: false, kicked: false, stableMs: 0, href: lastHref, title: lastTitle, navType, totalMs: Date.now() - started, requests, error: msg, fatal: fatalOf(msg) };
  } finally {
    // ⚠️ 无论成败都断开：cdp.close() 会顺手关掉我们**自己新开**的标签页（如果开过）
    if (cdp) await cdp.close().catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════════
const startedAt = Date.now();
log(`登录态保活 · ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
log(`停留 ${DWELL_SEC}s/账号 · 稳定观察窗 ${STABLE_MS / 1000}s${DRY_RUN ? " · DRY-RUN（只体检不导航）" : ""}`);
if (Object.keys(portOverride).length) log(`⚠️ 端口覆盖（测试用）：${Object.entries(portOverride).map(([a, b]) => `${a}→${b}`).join(" ")}`);
log("═".repeat(96));

/**
 * ⛔ 采集窗口：整轮直接不跑。此时**连体检都不做导航**，只报状态。
 *    注意仍然会读 cookie（只读、不写），所以报告里能看到体检结论 —— 只是没续期。
 */
const winReason = collectWindowReason();

const readProfile = makeProfileReader(portOverride);
const results = [];
/** 已被判定不可用的端口 → 原因。同端口后面的账号不再导航（TOCTOU 防护）。 */
const badPorts = new Map();

const effPort = (t) => Number(portOverride[t.port] ?? t.port);

for (const t of TARGETS) {
  const row = {
    label: t.label, platform: t.platform, port: t.port, status: "?", action: "", ms: 0,
    detail: "", keyInfo: "", loginCmd: t.loginCmd ?? null,
    // ⭐ A5：证据字段 —— 让日志能自证「真导航了」而不是「空跑报 ok」
    href: "", title: "", navType: "", kind: "", requests: null, stableMs: null, dwellMs: null,
  };
  const t0 = Date.now();
  try {
    const c = await checkTarget(t, readProfile, SECRETS);
    row.detail = c.detail;
    row.keyInfo = c.keyInfo;
    row.source = c.source;
    row.kind = c.kind;
    if (c.retried) row.detail += `（冷启动重试 ${c.retried} 次后取到）`;

    if (c.kind === "down") {
      // ⛔ 绝不静默成功：端口不通就明确报「不可测」，退出码会变成 1
      row.status = "untestable";
      row.action = `不可测：端口 ${effPort(t)} 不通（${String(c.portError ?? "").slice(0, 70)}）`;
      badPorts.set(t.port, `端口 ${effPort(t)} 不通`);
    } else if (badPorts.has(t.port)) {
      row.status = "untestable";
      row.action = `不可测：本端口中途不可用（${badPorts.get(t.port)}）`;
    } else if (c.kind === "dead" || c.kind === "noauth") {
      /** ⛔ 不健康 → **不做无谓导航**，直接把「双击哪个启动器」写进报告。登录是人的动作。 */
      row.status = "expired";
      row.action = t.loginCmd ? `需重新登录 → 双击 ${t.loginCmd}` : "需重新登录（无对应启动器，请手动打开该调试浏览器登录）";
    } else if (winReason) {
      // 采集窗口内：状态健康，但**本轮没有保活**
      row.status = "deferred";
      row.action = `未保活：${winReason}`;
    } else if (DRY_RUN) {
      row.status = "ok";
      row.action = "DRY-RUN：健康，未导航";
    } else {
      // 健康（ok / ok-parent / ok-static）或 SSO（cookie 层定不了论）→ 打开首页停留
      const r = await dwellHomepage(t, DWELL_SEC);
      row.href = r.href ?? "";
      row.title = r.title ?? "";
      row.navType = r.navType ?? "";
      row.requests = r.requests ?? null;
      row.stableMs = r.stableMs ?? null;
      row.dwellMs = Math.round(r.totalMs ?? 0);
      if (r.kicked) {
        /**
         * cookie 层说健康、页面却落到登录页 —— **最需要报出来**的情况，
         * 正是 2026-10-21 品牌B那种假阳性。状态改判为「需重新登录」。
         */
        row.status = "expired";
        row.action = `⛔ 导航后落到登录页 → ` + (t.loginCmd ? `双击 ${t.loginCmd}` : "手动登录");
      } else if (r.ok) {
        row.status = "ok";
        const tag =
          c.kind === "sso" ? "，SSO 落首页未跳登录"
            : c.kind === "ok-parent" ? "，父域票据可用（MTOP 路径）"
              : c.kind === "ok-static" ? "，静态快照兜底" : "";
        row.action =
          `已保活：停留 ${(r.totalMs / 1000).toFixed(1)}s，资源请求 ${r.requests}，末尾稳定 ${(r.stableMs / 1000).toFixed(1)}s${tag}`;
      } else {
        row.status = "suspicious";
        row.action = `⚠️ 保活未确认：${String(r.error ?? r.reason ?? "未知").slice(0, 110)}`;
        /**
         * 只有「端口/渲染整体不可用」才把同端口后续账号也标成不可测；
         * **单个账号**的导航超时/未稳定不能连坐 —— 否则一个 SSO 账号慢跳会把同端口的其它平台也判死。
         */
        if (r.fatal) badPorts.set(t.port, "端口/渲染进程不可用");
      }
    }
  } catch (e) {
    // 单账号异常不外溢 —— 严格故障隔离，另一个平台照常
    row.status = "suspicious";
    row.action = `⚠️ 体检/保活异常：${String(e?.message ?? e).slice(0, 110)}`;
  }
  row.ms = Date.now() - t0;
  results.push(row);
}

// ════════════════════════════════════════════════════════════════════
// 报告：每个账号一行
// ════════════════════════════════════════════════════════════════════
const ICON = {
  ok: "✅ 正常",
  expired: "⛔ 失效",
  untestable: "⚪ 不可测",
  deferred: "🕗 延后",
  suspicious: "⚠️ 可疑",
};
let reclaimSummary = null;
if (process.argv.includes("--reclaim")) {
  try {
    const { reclaimTabs } = await import("./lib/tab-reclaim.mjs");
    const minAliveMin = Number((argOf("reclaim-min-alive") ?? "").split("=")[1] ?? 60) || 60;
    const maxPerRound = Number((argOf("reclaim-max") ?? "").split("=")[1] ?? 2);
    const ports = [...new Set(TARGETS.map((t) => effPort(t)))];
    reclaimSummary = [];
    for (const port of ports) {
      const r = await reclaimTabs(port, {
        dryRun: DRY_RUN,
        minAliveMin,
        maxPerRound: Number.isFinite(maxPerRound) ? maxPerRound : 2,
      });
      reclaimSummary.push({
        port,
        skipped: r.skipped,
        skipReason: r.skipReason,
        candidates: r.candidates ?? 0,
        chosen: r.chosen ?? 0,
        reclaimed: r.pages.filter((p) => p.action === "reclaimed").length,
        pages: r.pages.filter((p) => p.action !== "skip:非业务页").map((p) => ({
          id: p.id.slice(0, 8), action: p.action, before: p.before, after: p.after,
        })),
      });
      if (!AS_JSON) {
        if (r.skipped) {
          log(`   :${port} 休眠回收跳过 —— ${r.skipReason}`);
        } else {
          const done = r.pages.filter((p) => p.action === "reclaimed").length;
          log(
            `   :${port} 休眠回收${DRY_RUN ? "（DRY-RUN）" : ""}：候选 ${r.candidates ?? 0} · ` +
              `本轮 ${r.chosen ?? 0} · ${DRY_RUN ? "将休眠" : "已休眠"} ${DRY_RUN ? r.chosen ?? 0 : done} 个（阈值 ${minAliveMin}min / 上限 ${maxPerRound}）`,
          );
        }
      }
    }
  } catch (e) {
    // 回收失败绝不影响保活结论
    log(`   ⚠️ 休眠回收异常（已忽略，不影响保活结果）：${String(e?.message ?? e).slice(0, 120)}`);
    reclaimSummary = { error: String(e?.message ?? e) };
  }
}


const by = (s) => results.filter((r) => r.status === s);
const ok = by("ok"), expired = by("expired"), untestable = by("untestable"), deferred = by("deferred"), susp = by("suspicious");

/** 退出码优先级：失效(2) > 可疑(1) > 正常(0)。延后算「可疑」—— 保活没做成，不能沉默。 */
const exitCode = expired.length ? 2 : untestable.length || susp.length || deferred.length ? 1 : 0;

if (AS_JSON) {
  // ⚠️ 必须用 stdoutRaw：`console.log` 在 --json 下已被改道到 stderr（见上方注释）。
  stdoutRaw(JSON.stringify({ dwellSec: DWELL_SEC, dryRun: DRY_RUN, window: winReason, exitCode, results, reclaim: reclaimSummary, totalMs: Date.now() - startedAt }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.label.padEnd(3)} ${r.platform.padEnd(8)} ${(ICON[r.status] ?? r.status).padEnd(6)} ${r.action}  ·  ${(r.ms / 1000).toFixed(1)}s`);
    /**
     * ⭐ A5：终值 URL / title / navType 单独一行，**缩进 + 截断**。
     *    评审的判据是「日志必须能自证真导航了」，所以这行不是装饰：
     *      · href 能看出落到了哪一页（首页 vs 登录页 vs 别处）
     *      · title 与 href 互相印证（导航失败时常是空标题）
     *      · navType=navigate 证明是**真导航**，不是复用了某个已经加载好的页面
     */
    if (r.href || r.title || r.navType) {
      const href = r.href.length > 110 ? r.href.slice(0, 110) + "…" : r.href;
      console.log(`      ↳ @${href || "(空)"}${r.title ? ` · title=${r.title.slice(0, 40)}` : ""}${r.navType ? ` · navType=${r.navType}` : ""}`);
    }
    if (r.status === "expired") for (const line of String(r.detail).split("\n")) console.log(`      ${line.trim()}`);
    else if (r.kind === "ok-parent" && r.keyInfo) console.log(`      ↳ 父域票据：${r.keyInfo}`);
  }

  console.log("═".repeat(96));
  console.log(
    `正常 ${ok.length} · 失效 ${expired.length} · 不可测 ${untestable.length} · 延后 ${deferred.length} · 可疑 ${susp.length}` +
      ` · 总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (expired.length) {
    const cmds = [...new Set(expired.map((r) => r.loginCmd).filter(Boolean))];
    console.log(`⛔ 需重新登录：${expired.map((r) => `${r.label}${r.platform}`).join("、")}`);
    if (cmds.length) console.log(`   修法：双击项目根目录下的 ${cmds.join(" / ")}，在可见窗口里登录后不要关它；再跑本脚本应转为 ✅。`);
    console.log(`   （登录必须由本人双击触发，本脚本**不代做登录**，也**不碰任何 cookie**。）`);
  }
  if (untestable.length) {
    const ports = [...new Set(untestable.map((r) => effPort(r)))];
    console.log(`⚪ 不可测（浏览器没开 → 本次**没有保活**，不代表凭证健康）：${untestable.map((r) => `${r.label}${r.platform}(:${effPort(r)})`).join("、")}`);
    console.log(`   修法：先双击 start-chrome.cmd / start-edge-yifeng.cmd 把 ${ports.map((p) => ":" + p).join(" / ")} 拉起来，或检查开机自启。`);
  }
  if (deferred.length) console.log(`🕗 延后（${winReason}）—— 本轮未做保活，避免与采集抢同一端口。`);
  if (susp.length) console.log(`⚠️ 可疑：${susp.map((r) => `${r.label}${r.platform}`).join("、")}（凭证可能没问题，是导航/渲染/稳定性问题）。`);
  if (!exitCode) console.log("✅ 全部平台正常，已完成本次保活。");
  console.log(`退出码 ${exitCode}（0=全部正常 / 1=可疑或不可测 / 2=有账号失效需重新登录）`);
}

/**
 * ── 保活跑完后的「标签页休眠回收」（方案 C，**默认关闭，需 --reclaim 显式打开**）──
 *
 * 为什么默认关闭：休眠会把页面内容换成一个提示页，对经营者是**可见的打扰**。
 * 他要求「可选，需确认」，所以这里只做成**开关**，不默认执行。
 *
 * 作用范围只限本脚本跑完后残留的页面，不碰采集主链路：
 *   - 采集锁 / 采集窗口 由 tab-reclaim.mjs 内部闸门再判一次（双保险）
 *   - `minAliveMin` 默认 60：刚打开、刚用过的页面不动
 *   - `maxPerRound` 默认 2：一轮最多休眠两个，从小步开始
 *   - 只导航到 data: 休眠页，**不关标签页、不 kill 进程、不碰 cookie**
 *
 * 说明：本脚本自己开的标签页由 cdp.close() 在 finally 里收尾，这里不重复处理；
 *       本步骤处理的是「经营者日常开着、但已经很久没动」的页面。
 */
process.exit(exitCode);
