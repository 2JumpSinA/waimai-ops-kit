/* ══════ 分片 4c-render-selfcheck.js · 渲染：⑤ 口径自检（页面可见断言） ══════ */
/* ── ⑤ 口径自检（把已标定口径变成页面上看得见的断言）── */
/**
 * 为什么要有这块：
 *   本项目踩过的坑几乎都是「口径漂移」—— 收入从逐单换成平台聚合而说明没改、
 *   曝光从逐店改成平台总口径、取消率被乘了两次 100。
 *   这些靠人工对账能发现，但每次都要重新对一遍。
 *   所以把不变量写成断言，**在页面上可见地跑出来**：口径一漂，当场红。
 *
 * 与 build 侧的关系：
 *   `VM.selfCheckSpecs` 是断言清单（id + 标签），由 `src/lib/caliber.mjs` 注入；
 *   build 期间的 `checkInvariants()` 用的是**同一份 id 语义**，只是结果进 console。
 *   `src/test-dashboard-parity.mjs` 会断言「每个注入的 id 在这里都有实现」，
 *   所以加了断言却忘了在页面实现，会被门禁拦下。
 */
/**
 * 数据侧断言（页面自己算）。
 *
 * ⚠️ 「VM 内无 undefined/NaN」与「平台不可加」这两条**不在页面算** ——
 *    它们必须遍历整份 VM，而页面侧一旦 `JSON.stringify(VM)`，读集探针就会把
 *    **每个字段**都记成"被读过"，parity 的「读集对照」立刻失效（踩过：读集从 452 条涨到 1232 条）。
 *    这两条改由 build 期间的 `checkInvariants()` 算好、注入 `VM.selfCheck`，页面直接展示；
 *    其余断言页面侧自己算，并与构建期结论**比对**，不一致就红。
 */
const BULK_CHECKS = new Set(["vm-has-no-undefined", "platforms-not-additive"]);

function selfCheckResults() {
  const out = [];
  const ok = (id, pass, detail) => out.push({ id, pass: !!pass, detail: detail == null ? "" : String(detail) });
  /** 上海时区的「昨天」：与 src/lib/caliber.mjs 的 yesterdayIso 同算法 */
  const yday = new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const keys = VM.projectOrder ?? [];
  const label = (k) => VM.projects[k]?.label ?? k;

  let scBad = [], crBad = [], poiBad = [], promBad = [], endBad = [], expoBad = [], dayBad = [], calBad = [];
  for (const k of keys) {
    const p = VM.projects[k] ?? {};
    const inc = p.income ?? {};

    // 2. 收入自校验差（对齐官方 settleIncome）
    if (inc.selfCheck?.projectedIncomeDiff !== 0) scBad.push(`${label(k)}=${inc.selfCheck?.projectedIncomeDiff}`);

    // 3. 曝光曲线末点 == 最新日窗口
    const ed = p.exposure?.daily ?? [];
    const last = ed[ed.length - 1];
    const w0 = p.exposure?.windows?.today;
    if (!(last && w0 && last.uv === w0.uv && last.pv === w0.pv)) {
      expoBad.push(`${label(k)} 曲线 ${last?.uv}/${last?.pv} ≠ 窗口 ${w0?.uv}/${w0?.pv}`);
    }

    // 4. 曝光「最新日」≤ 昨天（T+1，不含今天）
    const day = p.exposure?.windows?.today?.day ?? null;
    if (!(day && day <= yday)) dayBad.push(`${label(k)}=${day}`);

    // 5. 窗口 cancelRate 量纲 + 自洽（VM 窗口层是百分数）
    for (const w of Object.values(p.windows ?? {})) {
      if (!w || w.cancelRate == null) continue;
      if (w.cancelRate < 0 || w.cancelRate > 100) crBad.push(`${label(k)}/${w.label} 越界 ${w.cancelRate}`);
      const exp = w.orderCount ? (w.cancelCount / w.orderCount) * 100 : null;
      if (exp != null && Math.abs(w.cancelRate - exp) > 0.01) crBad.push(`${label(k)}/${w.label} ${w.cancelRate}≠${exp.toFixed(2)}`);
    }

    // 6. 逐店 rate 是**小数**（边界量纲），不是百分数
    for (const x of [...(inc.byPoiD7 ?? []), ...(inc.byPoiD30 ?? [])]) {
      if (typeof x.rate === "number" && (x.rate < 0 || x.rate > 1)) poiBad.push(`${label(k)}/${x.poiId}=${x.rate}`);
    }

    // 7. 推广占比分母 = 预计收入
    for (const w of Object.values(p.windows ?? {})) {
      if (!w || w.promoRatio == null) continue;
      const exp = w.promoCost != null && w.projectedIncome > 0 ? (w.promoCost / w.projectedIncome) * 100 : null;
      if (exp == null || Math.abs(w.promoRatio - exp) > 0.01) promBad.push(`${label(k)}/${w.label} ${w.promoRatio}≠${exp?.toFixed(2)}`);
    }

    // 8. d7/d30 的 end 不含今天
    for (const wk of ["d7", "d30"]) {
      const w = inc.windows?.[wk];
      if (w?.end && w.end > yday) endBad.push(`${label(k)}/${w.label} end=${w.end}`);
    }

    // 11. 曝光口径文案按项目给数（不串项目）
    const smp = VM.caliber?.exposure?.samplesByProject?.[k];
    if (!smp || smp.platformPv == null) calBad.push(`${label(k)} 缺曝光样本`);
  }
  ok("income-selfcheck-diff-zero", scBad.length === 0, scBad.join("；") || `两项目 projectedIncomeDiff = 0`);
  ok("exposure-last-eq-window", expoBad.length === 0, expoBad.join("；") || "末点 UV/PV 与最新日窗口一致");
  ok("exposure-latest-is-yesterday", dayBad.length === 0, dayBad.join("；") || `最新日 ≤ ${yday}`);
  ok("window-cancelrate-range", crBad.length === 0, crBad.join("；") || "全部 ∈ [0,100] 且与 cancelCount/orderCount 自洽");
  ok("poi-rate-decimal", poiBad.length === 0, poiBad.join("；") || "全部 ∈ [0,1]");
  ok("promo-ratio-denominator", promBad.length === 0, promBad.join("；") || "全部 ≈ 推广消耗 ÷ 预计收入 × 100");
  ok("window-end-excludes-today", endBad.length === 0, endBad.join("；") || `d7/d30 的 end ≤ ${yday}`);
  ok("exposure-caliber-per-project", calBad.length === 0, calBad.join("；") || "每个项目都有自己的曝光实测数");

  // 9. 项目隔离
  ok("projects-isolated", keys.length >= 1 && !("total" in VM) && !("all" in VM) && !("total" in VM.projects),
    `projectOrder = ${JSON.stringify(keys)}`);

  return out;
}

/**
 * 汇总：构建期结论（`VM.selfCheck`）与页面侧结论合并，并对**两者都算了的**断言做一致性比对。
 * 页面顺序按注入的 `VM.selfCheckSpecs`，保证与 caliber.mjs 的清单一致。
 */
function selfCheckMerged() {
  const pageSide = Object.fromEntries(selfCheckResults().map((r) => [r.id, r]));
  const build = Object.fromEntries((VM.selfCheck ?? []).map((r) => [r.id, r]));
  return (VM.selfCheckSpecs ?? []).map((s) => {
    const b = build[s.id];
    const pg = pageSide[s.id];
    if (!b && !pg) return { id: s.id, label: s.label, pass: false, detail: "页面与构建期都没有实现该断言", source: "—" };
    if (BULK_CHECKS.has(s.id) || !pg) {
      return { id: s.id, label: s.label, pass: !!b?.ok, detail: b?.detail ?? "", source: "构建期" };
    }
    if (!b) return { id: s.id, label: s.label, pass: !!pg.pass, detail: pg.detail, source: "页面" };
    const agree = !!b.ok === !!pg.pass;
    return {
      id: s.id, label: s.label,
      pass: agree && !!pg.pass,
      detail: agree ? pg.detail : `构建期=${b.ok}（${b.detail}） 页面=${pg.pass}（${pg.detail}） —— 两侧结论不一致`,
      source: "两侧一致",
    };
  });
}

function drawSelfCheck() {
  const rows = selfCheckMerged();
  const bad = rows.filter((r) => !r.pass);
  $("selfCheckTag").textContent = bad.length ? `${bad.length} 项未通过` : `全部通过（${rows.length} 项）`;
  $("selfCheckTag").className = "tag" + (bad.length ? " bad" : "");
  $("selfCheckSub").innerHTML =
    `把已标定口径写成页面上可执行的断言：口径一漂，这里当场红。` +
    `断言清单与构建期自检同源（<code>src/lib/caliber.mjs</code> 的 <code>SELF_CHECK_SPECS</code>）；` +
    `标「构建期」的两条需要遍历整份 VM，故在构建时算好；其余页面侧自己再算一遍并要求与构建期结论一致。`;
  $("selfCheckWrap").innerHTML = rows.length
    ? `<table><thead><tr><th>#</th><th>断言</th><th>结果</th><th>来源</th><th>实测</th></tr></thead><tbody>` +
      rows.map((r, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="wrap">${esc(r.label)}</td>
        <td><span class="pill ${r.pass ? "on" : "off"}">${r.pass ? "通过" : "未通过"}</span></td>
        <td>${esc(r.source)}</td>
        <td class="wrap" style="font-size:11.5px">${esc(r.detail)}</td>
      </tr>`).join("") +
      "</tbody></table>"
    : '<div class="empty">没有自检项</div>';
}
