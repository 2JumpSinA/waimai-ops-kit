/**
 * dashboard.html 的结构化提取层（**唯一实现**）。
 *
 * 为什么单独拆出来：
 *   原先「抠 VM」在仓库里有**两份不同实现**：
 *     · `src/verify-dashboard.mjs` 用脆弱正则 `/const VM = (\{[\s\S]*?\});\nconst \$ =/`
 *       —— 依赖 `const VM = …;` 后面紧跟 `const $ =`，模板一挪动就静默失配；
 *     · `src/inspect-dashboard-vm.mjs` 用**括号配平**（能正确处理字符串里的 `{`/`}`）。
 *   两份实现意味着「一处改了另一处不知道」，而它们校验的是同一份产物。
 *   现在统一到这里，两个消费方都只调本文件。
 *
 * 产物契约（重构不许破坏，2026-09-22 结构优化期间反复确认）：
 *   dashboard.html 必须是自包含单文件，且**恰好两个内联 `<script>` 块**：
 *     [0] 内联 echarts（由 build 注入 `<!--ECHARTS-->`）
 *     [1] 看板应用脚本（含 `const VM = <JSON>;`）
 *   外链 .js 会在 file:// 断网时失效；`type="module"` 在 file:// 下因 null origin 被 CORS 拒 ——
 *   所以源码侧可以分层（`src/template/app/*.js`），**产物侧必须保持单一内联 script**。
 *
 * 本文件不碰文件系统、不碰浏览器，纯字符串处理，可离线单测。
 */

/**
 * 标记语言里的静态 id 集合（**生产侧**：HTML 骨架声明的 id）。
 *
 * 用途：渲染指纹的 DOM 桩里有一份硬编码的 id 列表，若模板删掉/改名某个 `<div id=…>`，
 * 桩照样会返回元素、指纹全绿 —— 这是最阴的一类漏检。所以必须把
 * 「模板 markup 声明的 id」与「桩认识的 id」做成双向集合相等断言。
 *
 * 先剥掉所有 `<script>` 块，避免把 JS 字符串里的 id 算进来。
 */
export function markupIds(html) {
  const noScript = html.replace(/<script>[\s\S]*?<\/script>/g, "");
  return [...new Set([...noScript.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))].sort();
}

/** 应用脚本里 `getElementById("…")` 引用到的 id（**消费侧**）。 */
export function referencedIds(appJs) {
  return [...new Set([...appJs.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]))].sort();
}

/**
 * 模板源码里 VM 数据的占位符（build 时被 JSON.stringify(vm) 替换）。 */
export const DATA_PLACEHOLDER = "/*__" + "DATA__*/";

/** 取出所有内联 `<script>…</script>` 块的内容（不含标签本身）。 */
export function extractScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** 内联 echarts 块（第一个）。 */
export function extractEchartsJs(html) {
  const s = extractScripts(html);
  return s.length > 1 ? s[0] : null;
}

/** 看板应用脚本 = **最后一个** 内联 script 块。 */
export function extractAppJs(html) {
  const s = extractScripts(html);
  if (!s.length) throw new Error("dashboard.html 里没有内联 <script> 块");
  return s[s.length - 1];
}

/**
 * 从应用脚本里抠出 `const VM = {…};` 的数据块。
 *
 * ⚠️ 必须用**括号配平**而不是非贪婪正则：VM 里全是中文口径文案，
 *    含 `{`/`}`/`"` 是常态（例如 `formatter: "{value}%"`），非贪婪正则会在第一个
 *    `};` 处提前收尾，把 JSON 截断成非法文本。
 *    配平时按 JSON 字符串规则跳转义，字符串内的括号不计数。
 *
 * @returns {{vm:any, start:number, end:number, text:string, declAt:number}}
 */
export function extractVmBlock(appJs) {
  const declAt = appJs.indexOf("const VM = ");
  if (declAt < 0) throw new Error("应用脚本里找不到 `const VM = `");
  const start = appJs.indexOf("{", declAt);
  if (start < 0) throw new Error("`const VM = ` 后面没有 `{`");

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < appJs.length; i++) {
    const c = appJs[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error("VM 数据块的括号未配平（应用脚本可能被截断）");

  const text = appJs.slice(start, end);
  let vm;
  try {
    vm = JSON.parse(text);
  } catch (e) {
    throw new Error(`VM 数据块不是合法 JSON：${e.message}`);
  }
  return { vm, start, end, text, declAt };
}

/** 一步到位：HTML → VM。 */
export function extractVm(html) {
  return extractVmBlock(extractAppJs(html)).vm;
}

/**
 * 把应用脚本里的 VM 数据块替换成给定 VM（保持其它源码逐字不动）。
 *
 * 用途：**渲染指纹对照**必须在同一份数据上跑改前/改后两份脚本，
 * 否则"页面变了"分不清是代码改的还是数据改的。
 */
export function substituteVm(appJs, vm) {
  const { start, end } = extractVmBlock(appJs);
  return appJs.slice(0, start) + JSON.stringify(vm) + appJs.slice(end);
}

/**
 * 往应用脚本里注入 VM —— 兼容**两种形态**：
 *   · 模板源码：`const VM = ` 后面跟数据占位符（不是合法 JSON）
 *   · 构建产物：`const VM = {…};`
 * 渲染指纹对照要在同一份数据上跑改前/改后两份脚本，这个函数负责把数据对齐。
 */
export function injectVm(appJs, vm) {
  if (appJs.includes(DATA_PLACEHOLDER)) return appJs.replace(DATA_PLACEHOLDER, JSON.stringify(vm));
  return substituteVm(appJs, vm);
}

/**
 * 结构断言（供 verify 与 parity 共用，避免各写一套）。
 * @returns {{ok:boolean, findings:string[]}}
 */
export function checkSelfContainedStructure(html) {
  const findings = [];
  const scripts = extractScripts(html);
  if (scripts.length !== 2) findings.push(`内联 <script> 块应为 2 个（echarts + 应用），实际 ${scripts.length} 个`);
  if (/<script[^>]+src=/i.test(html)) findings.push("存在外链 <script src=…>，file:// 断网会失效");
  if (/<link[^>]+rel=["']?stylesheet/i.test(html)) findings.push("存在外链样式表，file:// 断网会失效");
  if (/<script[^>]+type=["']?module/i.test(html)) findings.push("存在 type=module 脚本，file:// 下会因 null origin 被拒");
  if (/<!--ECHARTS-->/.test(html)) findings.push("echarts 占位符 `<!--ECHARTS-->` 未被替换");
  if (/\/\*__DATA__\*\//.test(html)) findings.push("数据占位符 `/*__DATA__*/` 未被替换");
  if (/\/\*__APP__\*\//.test(html)) findings.push("应用脚本占位符 `/*__APP__*/` 未被替换");
  return { ok: findings.length === 0, findings };
}
