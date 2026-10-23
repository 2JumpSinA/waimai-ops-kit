/**
 * 登录态自检 —— 一条命令看清哪些平台的凭据还好、哪些快过期。
 *   node src/check-sessions.mjs [--probe]
 *
 * `--probe` 会真的打一次接口（闪购走 MTOP，不需要浏览器；美团系只做 cookie 层检查，
 * 因为它的接口必须借页面签名）。
 *
 * 为什么需要它：`.secrets/*.cookie.txt` 里**只有 name=value，没有到期时间** ——
 * 脚本自己判断不出快过期，历来只能等接口报错（`非法令牌` / `403`）才发现。
 * 本工具改从浏览器 profile 读**带 expires 的活 cookie**，就能提前预警。
 *
 * ⛔ 2026-10-22：**判据已抽到 `src/lib/sessions.mjs`**，本文件只是它的报告壳。
 *    `keepalive-sessions.mjs` 用同一个 `assessTarget()` —— 两套判据打架时没有任何一方会报警
 *    （2026-10-21 品牌B挂 7 天就是这么来的）。改判据请改 lib，别在这里加分支。
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { TARGETS, assessTarget, makeProfileReader, staticFileState } from "./lib/sessions.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = join(ROOT, ".secrets");
const PROBE = process.argv.includes("--probe");

console.log("登录态自检" + (PROBE ? "（含接口探测）" : "（仅 cookie 层，加 --probe 会真打接口）"));
console.log("═".repeat(96));

const readProfile = makeProfileReader();

/**
 * ⭐ 闪购 MTOP 实探（只在不带 `--probe` 时跳过）。
 *
 * 为什么提到**主循环之前**：闪购判出 `ok-parent` 时，报告里能不能写
 * 「MTOP 实探可用」取决于这次探测的结果。探测放循环后的话，
 * 循环里只能写死「未实探」，等于把最有价值的那句话丢掉。
 * 探测本身不需要浏览器（纯 HTTP + 静态文件回退），成本很低。
 *
 * key: stem（`taobao` / `taobao-yifeng`）→ true/false
 */
const PROBE_OK = new Map();
if (PROBE) {
  const { mtopCall } = await import("./lib/mtop.mjs");
  for (const [stem, port] of [["taobao", 9222], ["taobao-yifeng", 9223]]) {
    try {
      const ck = (await loadCookieSmart({ stem, port, host: "nr.ele.me", required: ["_m_h5_tk", "WMSTOKEN"] })).cookies;
      const r = await mtopCall({
        api: "mtop.ele.newretail.ebai.AccountShopCookieService.getAccountInfo",
        data: {},
        cookies: ck,
      }).catch((e) => ({ ok: false, ret: String(e.message) }));
      PROBE_OK.set(stem, !!r.ok);
    } catch {
      PROBE_OK.set(stem, false); // 拿不到 cookie 也算探测失败，别让报告说谎
    }
  }
}

const rows = [];
for (const t of TARGETS) {
  const filePath = join(SECRETS, `${t.stem}.cookie.txt`);
  const fstate = staticFileState(filePath);

  const pinfo = await readProfile(t.port);
  const a = assessTarget(t, pinfo.cookies);

  /**
   * 判定顺序：失效 > SSO > 父域票据 > 有登录态 > 仅文件 > 无。
   *
   * `deadSession`（本域专属 cookie 不足）**优先于静态文件兜底**：
   * 静态文件是一份更老的快照，profile 都失效了它只会更死。
   * 这时报 🟡「仅文件」会误导人去等它自愈 —— 必须直接说「要重新登录」。
   *
   * ⭐ `ok-parent`（2026-10-22 评审裁定）：闪购的票据本来就下发到父域 `.ele.me`，
   * 本域 `nr.ele.me` 只有埋点。它**不是** dead（`--probe` 实打 MTOP 可用），
   * 但也不能和真健康账号显示成同一个 `✅ profile`——否则父域残骸在报告里没有区别。
   * 所以单列 `🟢 父域票据`：带 `--probe` 且实探通过才敢说「MTOP 实探可用」，
   * 不带 `--probe` 一律降为「未实探」。
   */
  const probeOk = a.kind === "ok-parent" && PROBE_OK.has(t.stem);
  const usable = a.deadSession
    ? "⛔ 需重新登录"
    : t.sso
      ? "❔ SSO（需实跑）"
      : a.kind === "ok" ? "✅ profile"
        : a.kind === "ok-parent"
          ? (PROBE
            ? (probeOk ? "🟢 父域票据（MTOP 实探可用）" : "🟢 父域票据（MTOP 实探失败）")
            : "🟢 父域票据（未实探）")
          : fstate.has ? "🟡 仅文件" : "⛔ 无";

  rows.push({ ...t, usable, profileState: a.detail, keyInfo: a.keyInfo, fileState: fstate.text, pinfo });
  const looksDaily = (pinfo.tabs ?? 0) >= 3;
  const who = pinfo.error
    ? `未开（${pinfo.error}）`
    : `${pinfo.browser ?? "?"} · ${pinfo.tabs ?? "?"} 个标签页 · ` +
      (looksDaily ? "标签页较多" : "标签页较少（专用调试浏览器？）");
  console.log(
    `\n${t.label.padEnd(4)} ${t.platform.padEnd(10)} ${usable}\n` +
      `     端口 ${t.port} 后面是: ${who}\n` +
      `     ${a.detail}${a.keyInfo ? "\n        " + a.keyInfo : ""}\n` +
      `     静态文件 .secrets/${t.stem}.cookie.txt: ${fstate.text}`,
  );
}

// ── 闪购真接口探测结果（探测已在主循环前跑完，这里只报告）──
if (PROBE) {
  console.log("\n" + "═".repeat(96));
  console.log("接口探测（闪购走 MTOP，无需浏览器）");
  for (const stem of ["taobao", "taobao-yifeng"]) {
    const name = stem === "taobao" ? "品牌A" : "品牌B";
    const okv = PROBE_OK.get(stem);
    console.log(`  ${name.padEnd(4)} ${stem.padEnd(15)} ${okv ? "✅ 可用" : "⛔ 失败（_m_h5_tk 可能已过期，下次访问闪购首页会自动续）"}`);
  }
}

// ── 结论 ──
console.log("\n" + "═".repeat(96));
const bad = rows.filter((r) => r.usable.startsWith("⛔"));
const warn = rows.filter((r) => r.usable.startsWith("🟡"));
if (!bad.length && !warn.length) {
  console.log("✅ 所有平台登录态可用。");
} else {
  if (bad.length) {
    console.log(`⛔ 完全不可用：${bad.map((r) => `${r.label}${r.platform}`).join("、")}`);
    /**
     * 直接给出「双击哪个文件」—— 登录这一步是**人**的动作（账号密码在经营者手上），
     * 报错里不写清楚，等于把问题原样退回给人。文件名取自 TARGETS.loginCmd。
     */
    const cmds = [...new Set(bad.map((r) => r.loginCmd).filter(Boolean))];
    if (cmds.length) {
      console.log(`   修法：双击项目根目录下的 ${cmds.join(" / ")}，在弹出的可见窗口里登录，`);
      console.log(`         登录后**不要关那个窗口**，重跑本检查应变成 ✅ profile。`);
      console.log(`         （登录必须由本人双击触发，脚本不代做。）`);
    }
  }
  if (warn.length) console.log(`🟡 仅靠静态文件（会过期，建议开一下对应调试浏览器让它续期）：${warn.map((r) => `${r.label}${r.platform}`).join("、")}`);
}

/**
 * 🟢 父域票据单独汇总一条。
 * 它不是错误、也不是 ✅ —— 闪购的票据设计上就落在 `.ele.me` 父域，本域没有属正常。
 * 但**必须让人看见**：一是解释为什么它不显示 ✅，二是提醒 `_m_h5_tk` 寿命可能很短。
 */
const parentRows = rows.filter((r) => String(r.usable).startsWith("🟢"));
if (parentRows.length) {
  console.log(`\n🟢 父域票据（闪购设计如此，不是异常）：${parentRows.map((r) => `${r.label}${r.platform}`).join("、")}`);
  console.log(
    PROBE
      ? "   已加 --probe：上面「接口探测」显示 MTOP 是否真能签名。"
      : "   加 --probe 可实打 MTOP 确认能签名；`_m_h5_tk` 寿命短是正常的（服务端随请求续发）。",
  );
}
console.log(`\n提示：打开对应调试浏览器后重跑本检查，profile 里若能读到登录态就会显示 ✅ profile。`);
console.log(`     浏览器 profile 的 cookie 由 Chrome 自动续期，这是「不用反复导出 cookie」的关键。`);
console.log(`     想让它们每天自动续期：node src/keepalive-sessions.mjs（详见 HANDOVER.md「① 保活」）。`);
