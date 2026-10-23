/**
 * 抓取步骤的运行状态落盘（可追溯、可断代、可告警）。
 *
 * 来源与动机（2026-10-21）：
 *   参考 swr248/meituan-reply-bot 的「状态写文件可追溯」+「每小时复核真实状态，
 *   而不是相信自己上次写的值」。
 *
 * 本项目原来的状态只存在两种地方：
 *   1. refresh-failures-<account>.txt —— 只记失败行，成功时写空文件，**没有时间戳、没有历史**；
 *   2. 文件 mtime —— 只能推出「最近一次写的时间」，推不出「成功还是失败、连续失败几次、数据有没有真的变」。
 *   后果（实测）：品牌B 7 个步骤连续 7 天失败，失败文件里静静躺着 7 行，
 *   而看板照常渲染 —— 因为没有任何机制把「失败」和「该报警」连起来。
 *
 * 本模块只做一件事：每次步骤跑完，把「这次到底发生了什么」写成结构化状态，
 * 并和上一次的状态比对，算出连续失败次数与最后成功时间。判定/告警交给 check-gate.mjs。
 *
 * 目录约定：
 *   _recon/state/<account>/<step>.json          最新一次（覆盖写，原子）
 *   _recon/state/<account>/history/<step>.<ts>.json  历史（保留最近 N 次）
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.mjs";

const STATE_VERSION = 1;
const KEEP_HISTORY = 50;

const stateDir = (root, account) => join(root, "_recon", "state", account);
const latestPath = (root, account, step) => join(stateDir(root, account), `${step}.json`);
const historyDir = (root, account) => join(stateDir(root, account), "history");

export function readStep(root, account, step) {
  const p = latestPath(root, account, step);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // 坏文件当作没有，下次写入会覆盖
  }
}

export function listSteps(root, account) {
  const dir = stateDir(root, account);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/**
 * 记录一次步骤执行结果。
 *
 * @param {object} o
 * @param {string} o.root 项目根
 * @param {string} o.account quanyi|yifeng
 * @param {string} o.step 步骤名（与 refresh-account.ps1 里的 label 对齐）
 * @param {number} [o.startedAt] 起始时间（epoch ms），缺省用 finishedAt - durationMs
 * @param {number} [o.durationMs]
 * @param {number} o.exitCode
 * @param {number|null} [o.records] 本次产出的记录条数（能算就算，算不出传 null）
 * @param {Array<{path:string,bytes?:number,sha256?:string,changed?:boolean,skipped?:boolean}>} [o.outputs]
 * @param {string} [o.note] 人读备注（失败原因摘要等）
 * @returns {object} 写入的状态对象
 */
export function recordStep(o) {
  const { root, account, step, exitCode, durationMs = null, records = null, outputs = [], note = "" } = o;

  const finishedAt = Date.now();
  const startedAt = o.startedAt ?? (durationMs ? finishedAt - durationMs : null);
  const ok = exitCode === 0;

  const prev = readStep(root, account, step);

  // 连续失败次数：成功即清零；失败则在上一轮基础上 +1。
  // 注意：prev 为 null（首次运行）时失败也算 1 次，不能当成 0。
  const consecutiveFailures = ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;

  // 最后成功时间：保留上一次的，本次成功则刷新为现在。
  // 这是整个状态里最有用的一个字段 —— 「这个源最后一次真的抓成功是哪天」。
  const lastSuccessAt = ok ? new Date(finishedAt).toISOString() : (prev?.lastSuccessAt ?? null);

  const changed = outputs.some((x) => x?.changed === true);

  const state = {
    version: STATE_VERSION,
    account,
    step,
    ok,
    exitCode,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs,
    consecutiveFailures,
    lastSuccessAt,
    records,
    changed,
    outputs,
    note,
  };

  const lp = latestPath(root, account, step);
  mkdirSync(join(root, "_recon", "state", account), { recursive: true });
  writeFileAtomic(lp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8" });

  // 历史：append-only，满了就裁掉最旧的。
  const hd = historyDir(root, account);
  mkdirSync(hd, { recursive: true });
  const stamp = new Date(finishedAt).toISOString().replace(/[:.]/g, "-");
  writeFileAtomic(join(hd, `${step}.${stamp}.json`), JSON.stringify(state, null, 2) + "\n", { encoding: "utf8" });

  try {
    const mine = readdirSync(hd)
      .filter((f) => f.startsWith(step + ".") && f.endsWith(".json"))
      .sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - KEEP_HISTORY))) {
      try {
        unlinkSync(join(hd, f));
      } catch {
        /* 删不掉不影响主流程 */
      }
    }
  } catch {
    /* ignore */
  }

  return state;
}

/**
 * 汇总一个账号的所有步骤状态，供 check-gate 判定。
 *
 * `staleSuccessHours` 用「最后成功时间」而不是「文件 mtime」来算 ——
 * 这正是本模块存在的意义：文件可能因为一次失败的部分写入而显得很新，
 * 但「最后一次真正成功」可能已经是一周前。
 */
export function summarizeAccount(root, account, { now = Date.now() } = {}) {
  const steps = listSteps(root, account).map((step) => {
    const s = readStep(root, account, step);
    if (!s) return { step, missing: true, ok: false, consecutiveFailures: 0, lastSuccessAt: null, staleSuccessHours: null };
    const lastOk = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : null;
    return {
      step,
      missing: false,
      ok: s.ok,
      exitCode: s.exitCode,
      consecutiveFailures: s.consecutiveFailures ?? 0,
      lastSuccessAt: s.lastSuccessAt ?? null,
      staleSuccessHours: lastOk ? (now - lastOk) / 3600000 : null,
      records: s.records ?? null,
      changed: s.changed ?? false,
      note: s.note ?? "",
      finishedAt: s.finishedAt ?? null,
      durationMs: s.durationMs ?? null,
    };
  });

  return {
    account,
    steps,
    failing: steps.filter((s) => !s.ok),
    neverSucceeded: steps.filter((s) => !s.lastSuccessAt),
  };
}
