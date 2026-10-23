/**
 * 建立桌面 + 开始菜单快捷方式。
 *   node src/setup-launcher-shortcuts.mjs [--autostart] [--dry] [--clean-stale]
 *
 * 为什么要快捷方式：能供数的浏览器**必须带 `--remote-debugging-port` 启动**，
 * 而该参数只能在启动时给。日常用它就得有个"带参数的入口"——快捷方式最省事。
 *
 * ⚠️⚠️ 编码坑（本项目栽过多次）：
 *   把含中文的 PowerShell 写成**无 BOM 的 .ps1 文件**，Windows PowerShell 5.1
 *   按 ANSI(GBK) 解读，中文全损坏。所以这里**不落地 .ps1**，改用
 *   `powershell -EncodedCommand <base64(UTF-16LE)>`：命令行是 Unicode，
 *   且 base64 不含非 ASCII 字节，彻底绕开编码问题。
 *
 * ⚠️ 拼 PowerShell 字面量必须用**单引号**，不能用 JSON.stringify：
 *   JSON 的反斜杠转义对 PowerShell 无效（PS 用反引号转义），
 *   `D:\外卖看板` 会变成 `'D:\\外卖看板'` 原样保留两个反斜杠——
 *   实测 WorkingDirectory 与 IconLocation 双双损坏，图标直接失效。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry");
const AUTOSTART = process.argv.includes("--autostart");
const CLEAN_STALE = process.argv.includes("--clean-stale");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CMD = "C:\\Windows\\System32\\cmd.exe";

/**
 * 快捷方式清单。
 *   file   —— ROOT 下的目标（.cmd 或 .html）
 *   icon   —— 图标来源 exe；缺失则自动退化为无自定义图标
 *   worker —— 是否"供数浏览器"（这类才允许进开机自启）
 */
const TARGETS = [
  {
    name: "看板",
    /**
     * ⭐ 指向**服务启动器**而不是 dashboard.html。
     *   原因：页面上的「刷新」按钮需要本地服务才能工作（file:// 页面不能起 Node）。
     *   如果这里指向 .html，双击后按钮必然是灰的，体验更差。
     *   想只看不刷时，仍可直接双击 dashboard.html（file://，离线可用，按钮禁用）。
     */
    file: "serve-dashboard.cmd",
    icon: CHROME,
    desc: "外卖数据看板（本地服务模式，页面内可刷新）",
    worker: false,
    autostart: false,
  },
  {
    name: "看板 (只看)",
    file: "dashboard.html",
    icon: CHROME,
    desc: "只打开看板，不起服务（离线可用，页面内刷新按钮不可用）",
    worker: false,
    autostart: false,
  },
  {
    name: "刷新数据",
    file: "refresh.cmd",
    icon: CMD,
    desc: "Refresh all merchant data, then rebuild the dashboard",
    worker: false,
    autostart: false,
  },
  {
    name: "品牌A (Chrome)",
    file: "start-chrome.cmd",
    icon: CHROME,
    desc: "Quanyi merchant console - Chrome, debug port 9222",
    worker: true,
    autostart: true,
  },
  {
    name: "品牌B (Edge)",
    file: "start-edge-yifeng.cmd",
    icon: EDGE,
    desc: "Yifeng merchant console - Edge, debug port 9223",
    worker: true,
    autostart: true,
  },
];

/** 开始菜单下的分组文件夹，避免把条目散落在 Programs 根目录 */
const MENU_FOLDER = "外卖看板";

/** 旧版本曾直接写在 Programs 根目录，这里顺手清掉 */
const STALE_IN_MENU_ROOT = ["品牌A (Chrome).lnk", "品牌B (Edge).lnk"];

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const created = [];
const problems = [];

for (const t of TARGETS) {
  const src = join(ROOT, t.file);
  if (!existsSync(src)) { problems.push(`缺少目标文件 ${t.file}`); continue; }
  if (t.icon && !existsSync(t.icon)) t.icon = "";

  const wantAutostart = AUTOSTART && t.worker && t.autostart;
  const lnkName = `${t.name}.lnk`;

  const ps = `
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$desktop   = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'
$startup   = [Environment]::GetFolderPath('Startup')
$menuDir   = Join-Path $startMenu ${sq(MENU_FOLDER)}
$null = New-Item -ItemType Directory -Force -Path $menuDir

function New-Lnk([string]$path) {
  $lnk = $ws.CreateShortcut($path)
  $lnk.TargetPath       = ${sq(src)}
  $lnk.WorkingDirectory = ${sq(ROOT)}
  $lnk.Description      = ${sq(t.desc)}
  ${t.icon ? `$lnk.IconLocation = ${sq(t.icon + ",0")}` : ""}
  $lnk.Save()
  if (-not (Test-Path -LiteralPath $path)) { throw "not written: $path" }
}

$made = @()
$made += (Join-Path $desktop ${sq(lnkName)})
$made += (Join-Path $menuDir ${sq(lnkName)})
${wantAutostart ? `$made += (Join-Path $startup ${sq(lnkName)})` : ""}

foreach ($p in $made) { New-Lnk $p }

${CLEAN_STALE ? STALE_IN_MENU_ROOT.map((n) => `$old = Join-Path $startMenu ${sq(n)}; if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }`).join("\n") : ""}

# 读回校验：只有真读得出目标路径才算成功
$ok = $true
foreach ($p in $made) {
  $c = $ws.CreateShortcut($p)
  if ($c.TargetPath -ne ${sq(src)}) { $ok = $false }
  if ($c.WorkingDirectory -ne ${sq(ROOT)}) { $ok = $false }
}
if (-not $ok) { throw "readback mismatch" }
Write-Output 'OK'
`;

  if (DRY) {
    console.log(`[dry] ${lnkName}  ->  ${t.file}${wantAutostart ? "  (+ 开机自启)" : ""}`);
    continue;
  }

  try {
    // stderr 不回显：报错里可能带路径等信息
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (out.includes("OK")) { created.push(t); console.log(`✅ ${t.name}`); }
    else problems.push(`${t.name}: 未确认成功`);
  } catch {
    problems.push(`${t.name}: 创建失败（原始报错已屏蔽）`);
  }
}

console.log("");
if (created.length) {
  console.log(`已创建 ${created.length} 个快捷方式（桌面 + 开始菜单\\${MENU_FOLDER}\\）：`);
  for (const t of created) console.log(`   · ${t.name}.lnk   ->  ${t.file}`);
} else if (!DRY) {
  console.log("没有创建任何快捷方式。");
}
if (problems.length) {
  console.log("\n问题：");
  for (const p of problems) console.log(`   ⚠️ ${p}`);
}

console.log(`
说明：
  · 目标是 ${ROOT} 下的启动器；浏览器类会带调试端口启动
  · 「看板」用系统默认浏览器打开 dashboard.html
  · 「刷新数据」会弹命令行窗口跑抓取+重建，跑完停住等你看结果
  · 固定到任务栏 / 开始屏幕只能你手动：右键快捷方式 → 固定到任务栏
  · 开机自启${AUTOSTART ? "：已为两个供数浏览器开启" : "：加 --autostart 参数开启（只对供数浏览器生效）"}
`);
