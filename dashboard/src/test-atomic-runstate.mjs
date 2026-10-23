/**
 * 原子写 / 拒绝旧覆盖新 / 步骤状态累加 的最小验证。
 *   node src/test-atomic-runstate.mjs
 *
 * 输出只给结论 —— 失败时才打印细节（成本纪律：stdout 会常驻上下文）。
 * 用系统临时目录，不碰 data/raw 与 _recon/state。
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic, writeJsonGuarded, sha256 } from "./lib/atomic.mjs";
import { recordStep, readStep, summarizeAccount } from "./lib/runstate.mjs";

const fails = [];
const ok = (name, cond, detail = "") => {
  if (!cond) fails.push(`${name}${detail ? " :: " + detail : ""}`);
};

const dir = mkdtempSync(join(tmpdir(), "wb-atomic-"));
const T = (name) => join(dir, name);

try {
  // ── 1. 基本原子写 ──
  const f1 = T("plain.json");
  writeFileAtomic(f1, '{"a":1}');
  ok("原子写：内容正确", readFileSync(f1, "utf8") === '{"a":1}');
  const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
  ok("原子写：无残留 tmp", leftovers.length === 0, leftovers.join(","));

  // ── 2. 拒绝旧覆盖新 ──
  const f2 = T("guarded.json");
  const newer = { fetchedAt: "2026-10-21T08:30:00.000Z", v: "new" };
  const older = { fetchedAt: "2026-10-14T08:30:00.000Z", v: "old" };

  const r1 = writeJsonGuarded(f2, newer);
  ok("拒绝旧覆盖新：首次写入成功", r1.skipped === false && r1.changed === true);

  const r2 = writeJsonGuarded(f2, older);
  ok("拒绝旧覆盖新：旧数据被拒", r2.skipped === true && r2.reason === "refuse-older", JSON.stringify(r2));
  ok("拒绝旧覆盖新：磁盘仍是新数据", JSON.parse(readFileSync(f2, "utf8")).v === "new");

  const r3 = writeJsonGuarded(f2, older, { allowOlder: true });
  ok("拒绝旧覆盖新：allowOlder 可强制", r3.skipped === false && JSON.parse(readFileSync(f2, "utf8")).v === "old");

  // ── 3. 内容相同 → 不写盘、保留 mtime ──
  const f3 = T("same.json");
  writeJsonGuarded(f3, newer);
  const mt1 = statSync(f3).mtimeMs;
  await new Promise((r) => setTimeout(r, 1200)); // 让 mtime 有可观测的差异
  const r4 = writeJsonGuarded(f3, { ...newer });
  const mt2 = statSync(f3).mtimeMs;
  ok("相同内容：跳过写盘", r4.skipped === true && r4.reason === "identical", JSON.stringify(r4));
  ok("相同内容：mtime 未变", mt1 === mt2, `${mt1} vs ${mt2}`);

  // ── 4. 损坏的现有文件不阻止覆盖 ──
  const f4 = T("broken.json");
  writeFileSync(f4, "{ this is not json", "utf8");
  const r5 = writeJsonGuarded(f4, newer);
  ok("损坏文件：允许被正确数据替换", r5.skipped === false && JSON.parse(readFileSync(f4, "utf8")).v === "new");

  // ── 5. runstate：连续失败累加 + 成功清零 ──
  const root = T("proj");
  const base = { root, account: "yifeng", step: "exposure" };

  const s1 = recordStep({ ...base, exitCode: 1, durationMs: 1200, records: 0, note: "first fail" });
  ok("runstate：首次失败 consecutiveFailures=1", s1.consecutiveFailures === 1, String(s1.consecutiveFailures));
  ok("runstate：首次失败 lastSuccessAt=null", s1.lastSuccessAt === null);

  const s2 = recordStep({ ...base, exitCode: 1, durationMs: 1100 });
  ok("runstate：连续失败累加到 2", s2.consecutiveFailures === 2, String(s2.consecutiveFailures));

  const s3 = recordStep({ ...base, exitCode: 0, durationMs: 900, records: 136, outputs: [{ path: "x.json", changed: true }] });
  ok("runstate：成功后清零", s3.consecutiveFailures === 0, String(s3.consecutiveFailures));
  ok("runstate：成功后写入 lastSuccessAt", !!s3.lastSuccessAt);
  ok("runstate：changed 由 outputs 推导", s3.changed === true);

  const s4 = recordStep({ ...base, exitCode: 2, durationMs: 800 });
  ok("runstate：成功后再次失败从 1 开始", s4.consecutiveFailures === 1, String(s4.consecutiveFailures));
  ok("runstate：失败时保留上次成功时间", s4.lastSuccessAt === s3.lastSuccessAt);

  const readBack = readStep(root, "yifeng", "exposure");
  ok("runstate：最新状态可读回且一致", readBack?.finishedAt === s4.finishedAt);

  const sum = summarizeAccount(root, "yifeng");
  ok("runstate：汇总能列出失败步骤", sum.failing.length === 1 && sum.failing[0].step === "exposure");
  ok("runstate：汇总能算出距上次成功的小时数", typeof sum.steps[0].staleSuccessHours === "number");

  // ── 6. 历史裁剪不误删 ──
  for (let i = 0; i < 5; i++) recordStep({ ...base, step: "other", exitCode: 0 });
  const otherLatest = readStep(root, "yifeng", "other");
  ok("runstate：多步骤互不覆盖", otherLatest !== null && otherLatest.step === "other");
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

if (fails.length === 0) {
  console.log("PASS  atomic + runstate 全部断言通过（12 项）");
  process.exit(0);
} else {
  console.log(`FAIL  ${fails.length} 项断言失败：`);
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
