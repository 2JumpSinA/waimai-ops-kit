/**
 * 数值收敛助手（build 侧语义）—— 从 `build-dashboard.mjs` 原样搬出，**语义一字不改**。
 *
 * ⚠️ 两个已知的、**故意保留**的语义（改它们会改变看板表现，属口径变更而非结构优化）：
 *   1. `num()` 用 `Number(v)` 再判有限性 → `num(null) === 0`、`num("") === 0`、`num(false) === 0`。
 *      后果：ka 报表若返回 `convertEffectRoi: null`，看板会显示 **ROI 0.00** 而不是 `—`。
 *      这是**既有行为**，已在审计报告 A-3#1 登记，本轮不修（修它 = 改表现）。
 *   2. 本文件的 `r2` 与 `src/lib/mt-income-assemble.mjs` 里的 `r2` **语义不同**：
 *      · 本文件：先 `Number()` 再判 → `r2("5") === 5`
 *      · assemble：直接 `Number.isFinite(n)` → `r2("5") === null`
 *      两者**不可互换**（前者处理已装配 JSON，后者处理平台原始响应）。
 *      直接合并会静默改变取数结果，所以保持两份，并把差异写在这里。
 */

/** 转数值；非有限 → `null`。注意 `Number(null)===0` / `Number("")===0` 会被放行（见文件头 ⚠️）。 */
export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 保留 2 位小数；缺失/非有限 → `null`。 */
export const r2 = (v) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(2));
