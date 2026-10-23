/**
 * 给 refresh-account.ps1 用的状态记录入口。
 *
 * 为什么单独做一个 CLI 包装：PowerShell 那层只拿得到「退出码 + 耗时 + 步骤名」，
 * 拿不到 Node 进程内部的记录数/输出哈希。先把这三样最关键的落盘
 * （成败 / 连续失败次数 / 最后成功时间），产出物层面的变化等 fetch 脚本内部调用
 * lib/atomic.mjs 的 writeJsonGuarded 时再补 —— 那是下一阶段的事。
 *
 * 用法：
 *   node src/lib/record-step.mjs --account=yifeng --step=exposure --exit=1 --ms=12345 [--note="..."]
 *
 * 设计上**永不 exit 非 0**：它只是旁路记录，记录失败绝不能反过来把刷新任务搞挂。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordStep } from "./runstate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(a.indexOf("=") + 1) : d;
};

try {
  const account = arg("account");
  const step = arg("step");
  if (!account || !step) {
    console.error("[record-step] 缺 --account 或 --step，跳过记录");
    process.exit(0);
  }
  const exitCode = Number(arg("exit", "0")) || 0;
  const ms = Number(arg("ms", "0")) || null;

  recordStep({
    root: ROOT,
    account,
    step,
    exitCode,
    durationMs: ms,
    records: null,
    outputs: [],
    note: arg("note", "") || "",
  });
} catch (e) {
  // 旁路记录失败不影响主流程
  console.error("[record-step] 记录失败：" + e.message);
}
process.exit(0);
