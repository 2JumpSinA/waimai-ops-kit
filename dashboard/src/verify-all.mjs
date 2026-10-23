#!/usr/bin/env node
/**
 * 一条命令跑完整个验证流程 —— **专为省 token 而做**。
 *   node src/verify-all.mjs [--dynamic] [--with-fixture]
 *
 * 为什么要有它（2026-09-23 成本复盘）：
 *   以前每改一处代码，要分 6 次调用跑「构建 → 静态 → 5 个测试 → 动态」，
 *   每次的完整输出（几 KB）都留在对话上下文里，之后**每次调用都为它重新付费**。
 *   实测那次会话 98.6% 的花费是「重读上下文」。
 *
 * 所以本脚本做两件事：
 *   ① **合并**：6+ 步变 1 步 → 对话里少 5 次往返；
 *   ② **隔离**：各步完整输出写进 `_recon/verify-all.log`，**只把每步的结论行**打到 stdout，
 *      几 KB 的日志不进上下文（要看细节再去 grep 那个文件）。
 *
 * ⚠️ 子进程必须走**文件 fd**，不能用管道 —— 本沙箱开不了命名管道，`stdio:'pipe'` 会 EPERM。
 *    （与 `src/lib/refresh-runner.mjs` 同一个坑，同一个解法。）
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = resolve(ROOT, "_recon", "verify-all.log");
mkdirSync(dirname(LOG), { recursive: true });
writeFileSync(LOG, "", "utf8");

const DYNAMIC = process.argv.includes("--dynamic");
const WITH_FIXTURE = process.argv.includes("--with-fixture");
const PORT = (process.argv.find((a) => a.startsWith("--port=")) ?? "--port=9222").split("=")[1];

const STEPS = [
  ...(WITH_FIXTURE ? [["重建 parity 夹具", ["src/test-fixtures/make-parity-fixture.mjs"]]] : []),
  ["构建看板", ["src/build-dashboard.mjs"]],
  ["静态校验", ["src/verify-dashboard.mjs", "--static"]],
  ["单测·窗口", ["src/test-mt-window.mjs"]],
  ["单测·装配", ["src/test-mt-income-assemble.mjs"]],
  ["单测·刷新器", ["src/test-refresh-runner.mjs"]],
  ["单测·模型", ["src/test-dashboard-model.mjs"]],
  ["导播报指标", ["src/export-mini-metrics.mjs"]],
  ["单测·播报指标", ["src/test-mini-metrics.mjs"]],
  ["parity 指纹", ["src/test-dashboard-parity.mjs", "--templates"]],
  ...(DYNAMIC ? [["动态校验(开浏览器)", ["src/verify-dashboard.mjs", `--port=${PORT}`]]] : []),
];

/** 跑一步，输出写进日志文件，返回退出码 */
function run(args) {
  return new Promise((res) => {
    const fd = openSync(LOG, "a");
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", fd, fd] });
    p.on("close", (code) => res(code ?? 1));
    p.on("error", () => res(1));
  });
}

/** 从日志里抠出「这一步的结论」——优先要断言统计行 */
function digest(mark) {
  const txt = readFileSync(LOG, "utf8").slice(mark);
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const want =
    lines.find((l) => /校验(全部)?通过|校验失败/.test(l)) ??
    lines.find((l) => /^ℹ (pass|fail) /.test(l)) ??
    lines.find((l) => /✅ parity 通过|失败项合计/.test(l)) ??
    lines.find((l) => /已生成|落盘|OK/.test(l)) ??
    lines[lines.length - 1] ??
    "";
  // 顺手把 pass/fail 数抓出来（node:test 的输出）
  const pass = /^ℹ pass (\d+)/m.exec(txt)?.[1];
  const failN = /^ℹ fail (\d+)/m.exec(txt)?.[1];
  return { line: want.trim().slice(0, 110), pass, failN };
}

console.log(`验证流程（${STEPS.length} 步）· 完整输出 → _recon/verify-all.log\n`);
let bad = 0;
const rows = [];
for (const [name, args] of STEPS) {
  const mark = readFileSync(LOG, "utf8").length;
  const t0 = Date.now();
  const code = await run(args);
  const d = digest(mark);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (code !== 0) bad++;
  const stat = d.pass != null ? `${d.pass} 过${d.failN && d.failN !== "0" ? ` / ${d.failN} 挂` : ""}` : "";
  rows.push([code === 0 ? "✅" : "❌", name, `${secs}s`, stat, d.line]);
}
const w = (i) => Math.max(...rows.map((r) => String(r[i]).length));
console.log(rows.map((r) => `${r[0]} ${String(r[1]).padEnd(w(1))} ${String(r[2]).padStart(6)}  ${String(r[3]).padEnd(Math.max(w(3), 6))}  ${r[4]}`).join("\n"));
console.log(`\n${bad === 0 ? "✅ 全部通过" : `❌ ${bad} 步失败`}（${STEPS.length} 步）· 细节：grep _recon/verify-all.log`);
process.exit(bad === 0 ? 0 : 1);
