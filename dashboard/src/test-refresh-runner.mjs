/**
 * 验证 RefreshRunner：**文件 stdio 启动 powershell** 这条路径能不能走通。
 *   node src/test-refresh-runner.mjs
 *
 * 为什么必须单独验这个：
 *   本机沙箱**不允许程序打开命名管道** —— `spawn(..., stdio:'pipe')` 会直接 EPERM。
 *   所以 RefreshRunner 故意用 `stdio:['ignore', fd, fd]`（文件句柄，不是管道）。
 *   这是整个「按钮刷新」功能的关键假设，不验就等于赌。
 *
 * 用替身脚本 `src/test-fixtures/fake-refresh.ps1`（入参形状与 refresh-all.ps1 一致），
 * 不打真接口、不碰浏览器。
 */
import { RefreshRunner } from "./lib/refresh-runner.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIXTURE = join(HERE, "test-fixtures", "fake-refresh.ps1");

if (!existsSync(FIXTURE)) { console.error(`缺 ${FIXTURE}`); process.exit(1); }

const runner = new RefreshRunner({ scriptPath: FIXTURE });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ck = (cond, name, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

console.log("── 1. 初始状态 ──");
let st = runner.status();
ck(st.running === false, "未运行");
ck(st.exitCode === null, "exitCode 为 null");

console.log("\n── 2. 启动（文件 stdio 启 powershell） ──");
const t0 = Date.now();
let started;
try {
  started = runner.start("quanyi");
} catch (e) {
  console.error(`  ❌ 启动抛错：${e.code ?? ""} ${e.message}`);
  console.error(`     —— 如果这是 EPERM/ENOTSUP，说明文件 stdio 这条假设不成立，必须换方案。`);
  process.exit(1);
}
ck(started.running === true, "状态立刻变成 running", `scope=${started.scope}`);
ck(started.scope === "quanyi", "scope 记录正确");
ck(started.scopeLabel === "品牌A", "scopeLabel 正确", started.scopeLabel);

console.log("\n── 3. 重复启动必须被拒（不能并发跑两次刷新） ──");
try {
  runner.start("both");
  ck(false, "重复启动被拒");
} catch (e) {
  ck(e.code === "ALREADY_RUNNING", "重复启动被拒", `code=${e.code}`);
}

console.log("\n── 4. 非法 scope 必须被拒 ──");
const r2 = new RefreshRunner({ scriptPath: FIXTURE });
try {
  r2.start("../../evil");
  ck(false, "非法 scope 被拒");
} catch (e) {
  ck(e.code === "BAD_SCOPE", "非法 scope 被拒", `code=${e.code}`);
}

console.log("\n── 5. 等它跑完 ──");
let waited = 0;
while (waited < 60_000) {
  st = runner.status();
  if (!st.running) break;
  await sleep(400);
  waited += 400;
}
ck(!st.running, "已结束", `等了 ${(waited / 1000).toFixed(1)}s`);
ck(st.exitCode === 0, "退出码 0", `exitCode=${st.exitCode}`);
ck(st.elapsedMs > 0 && st.elapsedMs < 60_000, "用时合理", `${st.elapsedMs}ms`);

console.log("\n── 6. 日志（走文件，不是管道） ──");
console.log("  日志文件: " + st.logFile);
ck(existsSync(st.logFile), "日志文件存在");
const logText = readFileSync(st.logFile, "utf8");
ck(logText.includes("=== 看板内刷新"), "含本次运行的抬头（说明是截断后新写的）");
ck(logText.includes("Only=quanyi"), "替身收到了 -Only quanyi 参数");
ck(logText.includes("NoPause=True"), "替身收到了 -NoPause（无控制台时绝不能等按键）");
ck(logText.includes("ALL STEPS OK"), "替身输出被写进日志");
ck(logText.includes("结束，退出码 0"), "runner 追加了结束行");
ck(Array.isArray(st.log) && st.log.length > 3, "status().log 返回行数组", `${st.log?.length} 行`);

console.log("\n── 7. 结束后可以再次启动（不能被上一次卡死） ──");
try {
  const again = runner.start("yifeng");
  ck(again.running === true, "再次启动成功", `scope=${again.scope}`);
  runner.dispose();
} catch (e) {
  ck(false, "再次启动成功", e.message);
}

console.log("");
if (fail === 0) {
  console.log("✅ 全部通过 —— 文件 stdio 启 powershell 这条路在本沙箱里可用。");
  process.exit(0);
}
console.log(`❌ ${fail} 项失败`);
process.exit(1);
