/**
 * 原子写 + 「拒绝旧覆盖新」。
 *
 * 来源与动机（2026-10-21）：
 *   参考 swr248/meituan-reply-bot 的 Cookie 写回策略（flock + 原子写 + fsync +
 *   版本号拒绝旧覆盖新），把它移植到本项目的数据落盘路径上——本项目原先**所有**
 *   写入都是裸 writeFile(OUT, JSON.stringify(...))，一个都没做原子化。
 *
 * 裸写在本项目的三个真实风险：
 *   1. 08:30 定时任务跑到一半被关机/杀进程 → data/raw 里留下截断的 JSON
 *      → 下次 build-dashboard 直接 JSON.parse 抛错 → 整页白屏（违反「绝不整页白屏」硬约束）；
 *   2. 手工重跑与定时任务撞车（refresh-all 的单实例锁只保护 ps1 层，
 *      不保护单个 fetch 脚本被人单独执行）→ 两个进程交替写同一文件 → 内容交错；
 *   3. 用几天前的备份手工回灌 → 文件 mtime 变新，但数据是旧的，
 *      freshness 会误判为「刚更新过」。
 *
 * 实现要点：
 *   - 临时文件必须与目标**同目录**（跨盘 rename 会退化成复制，失去原子性）；
 *   - 先 fsync 临时文件再 rename，否则崩溃后可能留下「文件名对、内容空」；
 *   - Windows 上 rename 覆盖已打开的目标会 EPERM/EBUSY，必须重试。
 *     Node 的 fs.rename 在 Windows 走 MoveFileEx(REPLACE_EXISTING)，能覆盖，但不保证在目标被占用时成功。
 *   - 拒绝旧覆盖新：比较新负载自身声明的 `fetchedAt` 与现有文件的，
 *     更旧的直接跳过（除非显式 allowOlder），并返回 prev/incoming 供调用方记录。
 */
import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const sleepSync = (ms) => {
  // 同步 sleep：主线程里不能用 await 的场景（脚本末尾顶层 await 之外）用它。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 原子写文件。
 * @param {string} path 目标路径
 * @param {string|Buffer} data
 * @param {{encoding?: BufferEncoding, retries?: number}} [opts]
 */
export function writeFileAtomic(path, data, opts = {}) {
  const { encoding = "utf8", retries = 6 } = opts;
  mkdirSync(dirname(path), { recursive: true });

  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, encoding) : data);
    fsyncSync(fd); // 必须：否则崩溃后可能得到「文件存在但长度为 0」
  } finally {
    closeSync(fd);
  }

  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      lastErr = e;
      // EPERM/EBUSY：目标正被另一个进程读（看板 serve、杀毒软件扫描）。
      // 退避重试，通常 1~2 次就过。
      sleepSync(120 * (i + 1));
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* 清不掉就留着，别掩盖原始错误 */
  }
  throw lastErr;
}

/**
 * 原子写 JSON，并拒绝比现有文件更旧的数据覆盖它。
 *
 * @param {string} path
 * @param {object} obj
 * @param {{tsField?: string, allowOlder?: boolean}} [opts]
 * @returns {{skipped: boolean, reason?: string, prev?: string, incoming?: string, bytes?: number, sha256?: string, changed?: boolean}}
 */
export function writeJsonGuarded(path, obj, opts = {}) {
  const { tsField = "fetchedAt", allowOlder = false } = opts;

  const incomingRaw = obj?.[tsField];
  const incomingTs = incomingRaw ? Date.parse(incomingRaw) : null;

  let prevRaw = null;
  let prevTs = null;
  let prevSha = null;
  if (existsSync(path)) {
    try {
      const prevText = readFileSync(path, "utf8");
      prevSha = sha256(prevText);
      prevRaw = JSON.parse(prevText)?.[tsField] ?? null;
      prevTs = prevRaw ? Date.parse(prevRaw) : null;
    } catch {
      /* 现有文件已损坏：不阻止覆盖，坏文件本来就该被正确数据替换 */
    }
  }

  if (!allowOlder && incomingTs && prevTs && incomingTs < prevTs) {
    return { skipped: true, reason: "refuse-older", prev: prevRaw, incoming: incomingRaw };
  }

  const body = JSON.stringify(obj, null, 2);
  const digest = sha256(body);

  // 内容完全相同 → 不写盘，保留原 mtime。
  // 这样 mtime 才是「数据真正变化的时间」，而不是「最后一次跑任务的时间」；
  // 也让上层能区分「跑了但没变化」和「跑了且有更新」。
  if (prevSha && prevSha === digest) {
    return { skipped: true, reason: "identical", prev: prevRaw, incoming: incomingRaw, sha256: digest };
  }

  writeFileAtomic(path, body, { encoding: "utf8" });
  return {
    skipped: false,
    bytes: Buffer.byteLength(body),
    sha256: digest,
    prevSha256: prevSha,
    changed: true,
    prev: prevRaw,
    incoming: incomingRaw,
  };
}
