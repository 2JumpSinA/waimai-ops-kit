#!/usr/bin/env node
/**
 * tools/guard/scan.mjs —— 敏感内容闸门（本地 pre-commit 预检 + CI 复检）
 *
 * 拦什么：见同目录 patterns.json（真实店名 / 人名 / secret / cookie / 本机绝对路径 / 手机号）。
 * 怎么拦：扫描 **git 索引里的文件**（`git ls-files`），逐行匹配规则。
 *
 * 为什么有 baseline.json：
 *   仓库首版快照里**已经存在**历史遗留的敏感串（例如源码注释里的真实店名、
 *   `D:\` 本机路径）。为了「不假装干净」也不「一次首提交就全线红灯」，
 *   扫描器把首次建档时的命中记录成**行指纹基线**：旧命中放行，
 *   新增命中一律拦下。删掉/改了旧行不会报错，改出新写法会被拦。
 *
 * 用法：
 *   node tools/guard/scan.mjs                  # 常规检查（基线内放行）
 *   node tools/guard/scan.mjs --strict         # 无视基线，任何命中都失败
 *   node tools/guard/scan.mjs --update-baseline # 重建基线（只在有意减小历史债时用）
 *
 * 输出纪律：**绝不回显命中内容**，只给 file:line + 规则 + 指纹前 8 位，
 * 避免守卫自己把敏感串打进 CI 日志。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const PATTERNS_FILE = join(HERE, "patterns.json");
const BASELINE_FILE = join(HERE, "baseline.json");

/** 这些目录不参与扫描（守卫自身的规则表用 \\uXXXX 转义写敏感串，但仍跳过以免自我命中） */
const SKIP_PREFIXES = ["tools/guard/", "node_modules/", "vendor/", ".git/", "_recon/"];
const MAX_BYTES = 2 * 1024 * 1024;

const args = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");
const UPDATE = args.has("--update-baseline");

function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    // 还不是 git 仓库时的兜底：直接走目录树
    const acc = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (["node_modules", ".git", "vendor", "_recon"].includes(e.name)) continue;
          walk(p);
        } else {
          acc.push(relative(ROOT, p).replace(/\\/g, "/"));
        }
      }
    };
    walk(ROOT);
    return acc;
  }
}

function isBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

function norm(line) {
  return line.replace(/\s+/g, " ").trim();
}

function key(ruleId, line) {
  return createHash("sha256")
    .update(`${ruleId}\u0000${norm(line)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** JS 不支持内联 (?i)：规则表里用前缀 (?i) 表达「忽略大小写」，这里翻译成 flags */
function compile(p) {
  let flags = "u";
  let src = p;
  if (src.startsWith("(?i)")) {
    flags += "i";
    src = src.slice(4);
  }
  return new RegExp(src, flags);
}

const spec = JSON.parse(readFileSync(PATTERNS_FILE, "utf8"));
const rules = spec.rules.map((r) => ({
  id: r.id,
  severity: r.severity === "warn" ? "warn" : "error",
  why: r.why,
  res: r.patterns.map(compile),
  // allow: [{ glob, why, contains? }] —— 按「规则 + 文件」精确放行。
  // 用于两类**结构性必需**的例外：① 守卫自检必须植入假 secret；② 配置模板里
  // 本来就是 `key=<你的key>` 这种占位符。放行粒度必须窄到「某规则 × 某文件 ×
  // 某段文本」，绝不做整体规则降级 —— 否则等于把闸门拆了。
  allows: (r.allow || []).map((a) => ({
    why: a.why,
    contains: a.contains || null,
    test: (file) => globToRe(a.glob).test(file),
  })),
}));

/** 极简 glob → RegExp：只支持 ** / * ，够用且不引依赖 */
function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const src = esc
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0002/g, ".*");
  return new RegExp(`^${src}$`);
}

const baseline = existsSync(BASELINE_FILE)
  ? new Set(JSON.parse(readFileSync(BASELINE_FILE, "utf8")).keys || [])
  : new Set();

const files = listFiles().filter((f) => !SKIP_PREFIXES.some((p) => f.startsWith(p)));
const fresh = [];
const legacy = [];
const warns = [];

for (const f of files) {
  const abs = join(ROOT, f);
  let st;
  try {
    st = statSync(abs);
  } catch {
    continue; // 索引里有、盘上没了（删除未提交）——跳过
  }
  if (!st.isFile() || st.size > MAX_BYTES) continue;
  const buf = readFileSync(abs);
  if (isBinary(buf)) continue;
  const lines = buf.toString("utf8").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;
    for (const rule of rules) {
      if (!rule.res.some((re) => re.test(line))) continue;
      // 结构性必需例外：规则 + 文件 + 该行必须仍含占位/自检标记，三者同时满足才放行
      const allowed = rule.allows.some(
        (a) => a.test(f) && (!a.contains || line.includes(a.contains)),
      );
      if (allowed) continue;
      const k = key(rule.id, line);
      const hit = { file: f, line: i + 1, rule: rule.id, fp: k.slice(0, 8), why: rule.why };
      if (rule.severity === "warn") warns.push(hit);
      else if (!STRICT && baseline.has(k)) legacy.push(hit);
      else fresh.push(hit);
    }
  }
}

if (UPDATE) {
  const keys = new Set();
  // 重建时把 warn 之外的全部现存命中都记入基线
  for (const f of files) {
    const abs = join(ROOT, f);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (!line || line.length > 4000) continue;
      for (const rule of rules) {
        if (rule.severity !== "error") continue;
        if (rule.res.some((re) => re.test(line))) keys.add(key(rule.id, line));
      }
    }
  }
  const doc = {
    _comment: [
      "历史遗留命中的行指纹基线（sha256(规则id\\0归一化行) 前 16 位）。",
      "只放行『首版快照里已经存在的』敏感串；新增命中会被 tools/guard/scan.mjs 拦下。",
      "重建：node tools/guard/scan.mjs --update-baseline（提交前请确认这是有意的减债）。",
    ],
    generatedAt: new Date().toISOString(),
    count: keys.size,
    keys: [...keys].sort(),
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`[guard] 基线已重建：${keys.size} 条 → tools/guard/baseline.json`);
  process.exit(0);
}

const shown = (list) => list.slice(0, 40);

if (warns.length) {
  console.warn(`[guard] ⚠️  提醒 ${warns.length} 处（不拦）：`);
  for (const h of shown(warns)) console.warn(`  ${h.file}:${h.line}  ${h.rule}`);
  if (warns.length > 40) console.warn(`  …另有 ${warns.length - 40} 处`);
}

if (legacy.length) {
  console.log(`[guard] 历史基线放行 ${legacy.length} 处（已在 baseline.json 中登记，非本次新增）`);
}

if (fresh.length) {
  console.error(`[guard] ❌ 新增敏感内容 ${fresh.length} 处 —— 请删除或改成占位符（如 <STORE_NAME>/<TOKEN>）：`);
  for (const h of shown(fresh)) console.error(`  ${h.file}:${h.line}  [${h.rule}]  ${h.why}`);
  if (fresh.length > 40) console.error(`  …另有 ${fresh.length - 40} 处`);
  console.error("[guard] 不要用 --update-baseline 掩盖新增泄露；基线只登记首版快照。");
  process.exit(1);
}

console.log(`[guard] ✅ 通过：扫描 ${files.length} 个文件，新增敏感内容 0 处（基线放行 ${legacy.length} 处）`);
