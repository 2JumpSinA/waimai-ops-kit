/**
 * 为官方 Chromium 建立「桌面快捷方式 + 开始菜单快捷方式」，指向 DSH 面板。
 *   node src/setup-chromium-dsh.mjs
 *
 * 背景：三浏览器分工
 *   Chrome   -> 品牌A
 *   Edge     -> 品牌B
 *   Chromium -> DSH 开发面板
 *
 * 为什么不用手写 .lnk：Node 没有内置 lnk 支持，用 PowerShell 的 WScript.Shell COM 最省事。
 * ⚠️ DSH Web 需要带 token 的 URL；token 是凭据，本脚本**不打印**它。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { BROWSER_CANDIDATES } from "./lib/cdp.mjs";

const CHROMIUM = (() => {
  // 曾经写死某个固定盘符的 Chromium 目录 —— 换机器就失效，开源后没人有这个目录。
  // 现在：环境变量 > 自动探测（Chromium → Chrome → Edge，与取数共用同一份候选表）。
  const cands = [
    process.env.DSH_CHROMIUM_EXE,
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
    ...BROWSER_CANDIDATES,
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) ?? cands[0];
})();
const PROFILE = process.env.DSH_CHROMIUM_PROFILE || join(process.cwd(), "_recon", "dsh-profile");

if (!existsSync(CHROMIUM)) {
  console.error(`[ERROR] 找不到浏览器：${CHROMIUM}`);
  console.error("        用环境变量 DSH_CHROMIUM_EXE 指定可执行文件（如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe）");
  console.error("        用环境变量 DSH_CHROMIUM_PROFILE 指定专用 profile 目录");
  process.exit(1);
}
mkdirSync(PROFILE, { recursive: true });

// ── 取带 token 的 DSH URL（不打印 token）──────────────────────────────
function findDshUrl() {
  const home = process.env.DSH_HOME;
  if (!home) return null;
  for (const f of ["web-daemon.out", "web-daemon.out.prev", "web-daemon.log"]) {
    const p = join(home, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const urls = [...text.matchAll(/https?:\/\/127\.0\.0\.1:3080[^\s"'<>`]*/g)].map((m) => m[0]);
    const withToken = urls.find((u) => /[?&](token|t|auth|key|code)=/i.test(u));
    if (withToken) return withToken;
  }
  return null;
}

const url = findDshUrl();
const mask = (u) => u.replace(/([?&](?:token|t|auth|key|code)=)([^&\s]+)/gi, "$1***");
console.log(`Chromium : ${CHROMIUM}`);
console.log(`profile  : ${PROFILE}`);
console.log(`DSH URL  : ${url ? mask(url).slice(0, 110) + "  (token 已包含，未显示)" : "(未找到 token，将用无 token 地址)"}`);

if (url) {
  mkdirSync(join(process.cwd(), "_recon"), { recursive: true });
  writeFileSync(join(process.cwd(), "_recon", "dsh-url.txt"), url, "utf8");
}

const target = url ?? "http://127.0.0.1:3080/";

// ── 用 PowerShell 建 .lnk（Node 没有内置 lnk 支持）────────────────────
//
// ⚠️ 参数拼装必须用 PowerShell **单引号字符串**，且内部不能出现单引号。
//    上一版用 JSON.stringify 生成双引号 + 反斜杠转义，PowerShell 解析直接报错，
//    而 Node 又把原始报错打到 stderr —— **报错信息里带着完整 URL（含 token）**，
//    于是 token 泄漏到了对话里。两处都要防：
//      1) 单引号拼接，避免转义地狱
//      2) 失败时**不回显原始报错**，只报「失败」+ 脱敏后的目标
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lnkArgs = `--no-first-run --no-default-browser-check --user-data-dir="${PROFILE}" --window-size=1500,1000 "${target}"`;

const ps = `
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'

function New-Lnk([string]$path) {
  $lnk = $ws.CreateShortcut($path)
  $lnk.TargetPath = ${sq(CHROMIUM)}
  $lnk.Arguments = ${sq(lnkArgs)}
  $lnk.WorkingDirectory = ${sq(dirname(CHROMIUM))}
  $lnk.IconLocation = ${sq(CHROMIUM)} + ',0'
  $lnk.Description = 'DSH web panel (dedicated Chromium)'
  $lnk.Save()
}

New-Lnk (Join-Path $desktop 'DSH (Chromium).lnk')
New-Lnk (Join-Path $startMenu 'DSH (Chromium).lnk')
Write-Output 'OK'
`;

writeFileSync(join(process.cwd(), "_recon", "mklnk.ps1"), ps, "utf8");
try {
  // stderr 一律不回显：它可能包含完整 URL（含 token）
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "_recon", "mklnk.ps1")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (!out.includes("OK")) throw new Error("no OK marker");
  console.log("✅ 已创建快捷方式：");
  console.log("   桌面           DSH (Chromium).lnk");
  console.log("   开始菜单       DSH (Chromium).lnk");
  console.log(`   目标           ${CHROMIUM}`);
  console.log(`   参数(脱敏)     --user-data-dir="${PROFILE}" "${mask(target).slice(0, 60)}"`);
} catch {
  console.error("⚠️ 自动创建快捷方式失败（原始报错已屏蔽，避免泄漏 token）。");
  console.error("   请手动创建，目标程序与参数如下：");
  console.error(`   目标: ${CHROMIUM}`);
  console.error(`   参数: --user-data-dir="${PROFILE}" "<DSH URL>"`);
  console.error("   （DSH URL 见 _recon/dsh-url.txt）");
}
