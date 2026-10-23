/* ══════ 分片 70-refresh.js · 刷新契约：服务模式可用 / file:// 下禁用并给出提示 ══════ */
/* ════════════════════════════════════════════════════════════════════════
   刷新按钮
   ════════════════════════════════════════════════════════════════════════
   ⛔ 硬约束先说清楚：本页平时是**双击用 file:// 打开**的静态单文件。
      浏览器里的页面不能启动 Node、不能写磁盘、不能开 CDP ——
      所以「点一下同步数据」在 file:// 下**物理上做不到**，不是没实现。

   服务模式（node src/serve-dashboard.mjs）下，服务把 token 与可选范围
   注入成 window.__DSH_REFRESH__，此时按钮才可用：点击 → POST /api/refresh
   → 轮询 /api/status 回显日志 → 跑完自动重载本页。
   两种模式的看板都是同一份 dashboard.html，file:// 的离线可用性没有被破坏。
   ──────────────────────────────────────────────────────────────────────── */
function initRefresh() {
  const cfg = window.__DSH_REFRESH__ ?? null;
  const btn = $("refreshBtn");
  const sel = $("refreshScope");
  const hint = $("refreshHint");
  const chip = $("runChip");
  const panel = $("runPanel");
  const logEl = $("runLog");
  const titleEl = $("runTitle");
  const metaEl = $("runMeta");
  const spin = $("runSpin");

  if (!cfg) {
    // file:// 模式：明确说清为什么不能用，以及怎么办
    btn.disabled = true;
    sel.style.display = "none";
    hint.textContent =
      "刷新需在服务模式下打开 —— 双击桌面「看板」（服务版），或跑 node src/serve-dashboard.mjs";
    return;
  }

  // 范围选项：当前项目（动态跟随切换器）/ 两个项目
  // ⚠️ value 用 `current` 而不是某个项目键 —— 否则切了项目之后这个选项的名字就骗人了
  const opts = [
    { key: "current", label: "当前项目" },
    { key: "both", label: "两个项目" },
  ];
  for (const o of opts) {
    const el = document.createElement("option");
    el.value = o.key; el.textContent = o.label;
    sel.appendChild(el);
  }
  sel.onchange = () => { sel.title = sel.value === "current" ? `刷新「${VM.projects[CUR_PROJ].label}」` : "刷新两个项目"; };

  const scopeOf = () => (sel.value === "current" ? CUR_PROJ : sel.value);
  const fmtDur = (ms) => {
    const s = Math.round((ms ?? 0) / 1000);
    return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  };
  const fmtAgo = (ms) => (ms == null ? "?" : ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60000)} 分`);

  let timer = null;
  let sawRunning = false;

  const renderLog = (st) => {
    const lines = st.log ?? [];
    logEl.innerHTML = lines
      .map((l) => {
        const esc = l.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
        const cls = /exit=\d+/.test(l) && !/exit=0/.test(l) ? "err" : /✅|ALL STEPS OK|exit=0/.test(l) ? "ok" : "";
        return cls ? `<span class="${cls}">${esc}</span>` : esc;
      })
      .join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  };

  const setRunning = (st) => {
    btn.disabled = true;
    btn.textContent = "刷新中…";
    spin.style.display = "";
    chip.style.display = st.scopeLabel ? "" : "none";
    if (st.scopeLabel) chip.textContent = st.scopeLabel;
    /**
     * ⭐ 进度分两路显示，因为**日志会缓冲**：
     *   子进程 stdout 非 TTY 时是攒块才写的，所以「日志几分钟没动」不等于卡住。
     *   数据文件的 mtime 是**不经过缓冲**的硬证据 —— 实测就发生过：用户以为卡死
     *   3 分钟，其实 exposure-quanyi.json 正在被写。
     */
    const parts = [];
    if (st.elapsedMs != null) parts.push(`已用 ${fmtDur(st.elapsedMs)}`);
    const pr = st.progress;
    if (pr && pr.changedCount > 0) {
      parts.push(`已更新 ${pr.changedCount} 个数据文件 · 最近 ${pr.newest.file}（${fmtAgo(pr.newest.msAgo)}前）`);
    } else {
      parts.push("还没有数据文件被改写（可能在等浏览器起来 / 校验登录）");
    }
    metaEl.textContent = parts.join(" · ");
  };

  const setDone = (st) => {
    btn.disabled = false;
    btn.textContent = "刷新数据";
    spin.style.display = "none";
    chip.style.display = "none";
    if (st.exitCode === 3) {
      // 单实例锁：refresh-all.ps1 拒绝并发运行
      titleEl.textContent = "已有另一个刷新在进行中，本次没有启动";
      metaEl.textContent = "";
      hint.textContent = "请等那个刷新跑完（别同时点按钮和双击「刷新数据」）。";
      return;
    }
    const okRun = st.exitCode === 0;
    titleEl.textContent = okRun ? "刷新完成，正在重新载入…" : `刷新结束（退出码 ${st.exitCode ?? "?"}）—— 数据可能只更新了一部分`;
    metaEl.textContent = `用时 ${fmtDur(st.elapsedMs)}`;
    if (okRun) {
      // 数据已重建，重载以显示新数字
      setTimeout(() => location.reload(), 1200);
    } else {
      hint.textContent = "失败了？看下面的日志；常见原因：调试浏览器没开、登录态过期（node src/check-sessions.mjs）。";
    }
  };

  const poll = async () => {
    let st;
    try {
      st = await (await fetch("/api/status", { cache: "no-store" })).json();
    } catch {
      metaEl.textContent = "与服务失联 —— 服务窗口是不是被关了？";
      clearInterval(timer); timer = null;
      btn.disabled = false; btn.textContent = "刷新数据"; spin.style.display = "none";
      return;
    }
    renderLog(st);
    if (st.running) { sawRunning = true; setRunning(st); return; }
    // 从未见过 running，且已有结束时间 → 是上一次的残留状态，别误报
    if (st.finishedAt) {
      clearInterval(timer); timer = null;
      setDone(st);
    } else {
      clearInterval(timer); timer = null;
      btn.disabled = false; btn.textContent = "刷新数据"; spin.style.display = "none";
      titleEl.textContent = "空闲";
    }
  };

  btn.onclick = async () => {
    const scope = scopeOf();
    panel.style.display = "";
    /**
     * ⚠️ 必须**预先说清要多久**。一个项目的全量刷新要跑 门店清单→今日→曝光(约3.5分)
     *    →推广→收入→闪购，5~15 分钟很正常。不说的话用户等 3 分钟就会以为卡死
     *    —— 这正是这次的实际反馈。
     */
    titleEl.textContent = "正在刷新…（一个项目约 5~15 分钟；下面会给进度，别重复点）";
    metaEl.textContent = "";
    logEl.textContent = "（正在启动…）";
    hint.textContent = "⚠️ 刷新期间**别关「看板」那个命令行窗口**（它现在就停得住了，但关了会看不到进度）。";
    spin.style.display = "";
    btn.disabled = true;
    try {
      const r = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Refresh-Token": cfg.token },
        body: JSON.stringify({ scope }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        titleEl.textContent = `没能开始刷新：${j.error ?? r.status}`;
        spin.style.display = "none";
        btn.disabled = false;
        return;
      }
      sawRunning = true;
      timer = setInterval(poll, 1500);
      poll();
    } catch (e) {
      titleEl.textContent = `请求失败：${e.message}`;
      spin.style.display = "none";
      btn.disabled = false;
    }
  };

  $("runToggle").onclick = () => {
    const hide = logEl.style.display !== "none";
    logEl.style.display = hide ? "none" : "";
    $("runToggle").textContent = hide ? "展开" : "收起";
  };

  // 页面打开时如果已有任务在跑（比如另开的标签页触发的），自动接上
  poll();
}

