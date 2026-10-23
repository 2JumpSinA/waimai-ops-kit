/**
 * 结构优化「没改行为」的机器验收（P0-5）。
 *   node src/test-dashboard-parity.mjs --templates          # 模板 vs 模板（渲染指纹）
 *   node src/test-dashboard-parity.mjs --ref=<产物> --cur=<产物>   # 产物 vs 产物（+ 派生值对照）
 *
 * 三条独立证据线：
 *   ① **渲染指纹** —— 同一份 VM 注入改前/改后应用脚本，在 Node 沙箱里跑
 *      init + 2 项目 × 4 窗口 = 9 个场景，逐元素比对 `innerHTML`/`textContent`/属性/
 *      `chart()` option / 派生数组 / 图表 dispose / 刷新契约字段。
 *   ② **派生值对照**（**仅产物模式**）—— 比对 VM 规范化摘要与派生值摘要。
 *   ③ **VM 读集对照** —— Proxy 记录模板到底读了 VM 的哪些路径：
 *      · kind 恒为 `undefined` 的路径 = **字段名漂移**（D-1 就是这类，现在机器自动报）
 *      · ref/cur 读集必须相等 → 抓「当前数据下值相同、但读取路径变了」的休眠回归
 *      · 读到的路径必须被 derivedDigest 覆盖（或进显式豁免表）→ 防摘要漏字段
 *
 * ⚠️ 两条**门禁**（踩过的坑）：
 *   · ② 在模板模式下会跳过 —— 若不明说 `--templates`，则**跳过即失败**，
 *     不许出现「打印 ✅ 通过但其实什么都没验」。
 *   · 场景必须真的切过去了：断言 clicks 全为 `ok`、场景数正确、每个项目内不同窗口
 *     载荷确实不同。否则 DOM 结构一变导致按钮找不到，两侧一起退化成 init 副本、
 *     差异 0、假绿。
 *
 * 有意变更走 `ALLOWED` / `EXEMPT` 登记表：登记了却零命中的条目会被标出来（防腐烂）。
 *
 * 退出码：0 = 无未登记差异；1 = 有。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAppJs, extractVmBlock, injectVm, markupIds, referencedIds } from "./lib/dashboard-html.mjs";
import { htmlProfile, vmDigest, derivedDigest, stableJson, canonicalize } from "./lib/dashboard-digest.mjs";
import { fingerprintApp, STATIC_IDS, INTERACTION_SCENARIOS } from "./lib/render-fingerprint.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const TEMPLATE_MODE = process.argv.includes("--templates");
const BEFORE_PRODUCT = join(ROOT, "_recon", "struct", "before.product.html");
/**
 * ⭐ 模板模式的基准 = **最近一次已批准的产品状态**（golden baseline）。
 *
 * 变更史：
 *   · 2026-09-22 结构优化任务：基准是 `_recon/struct/orig/`（重构**前**的 793 行单体模板），
 *     用于证明「重构没改行为」。该对照的结论已归档在
 *     `_recon/struct/PHASE2-REPORT.md` + `parity.final.json`。
 *   · 2026-09-22 经营者要求**移除三个板块**（今日分时 / 门店营业状态 / 渠道覆盖）——
 *     这是**有意的产品变更**，容器被真的删掉了。而本门禁的「图表集合」与「id 契约」
 *     两条都假设**两侧容器集合相同**，于是旧基准会直接崩（旧模板侧取不到元素、
 *     innerHTML 抛错 → 0 场景 → 全盘报差异），无法表达「有意删除容器」。
 *     ⇒ 把默认基准**重新基线化**为移除后的状态（`ref-post`）。
 *
 * 旧的重构对照仍可手动复跑（结论会包含本次删除，属预期）：
 *   node src/test-dashboard-parity.mjs --templates --ref=_recon/struct/orig/src/template/dashboard.html
 *
 * ⚠️ 重新基线化之后，`ALLOWED` 里那些**已被新基线吸收**的历史条目会全部 0 命中，
 *    于是输出一串「登记了但未发生」的提示 —— **这是预期的，不代表登记表坏了**：
 *    它们对照的是本轮之前的旧基准。保留该表，是为了仍能手动跑上面那条旧对照。
 *
 * ⚠️ `_recon/struct/orig/` 是本次重构的**唯一回滚路径**（本仓库无 git），不要删、不要覆盖。
 */
const REF_TPL = join(ROOT, "_recon", "struct", "ref-post", "src", "template", "dashboard.html");
/** 合成的 VM 兜底夹具：让本测试在**干净检出**（没有 `_recon/`）时也能跑 */
const FIXTURE_VM = join(ROOT, "src", "test-fixtures", "parity-vm.json");

const REF = resolve(ROOT, arg("ref", TEMPLATE_MODE ? REF_TPL : BEFORE_PRODUCT));
const CUR = resolve(ROOT, arg("cur", TEMPLATE_MODE ? "src/template/dashboard.html" : "dashboard.html"));
const JSON_OUT = arg("json", null);

/**
 * 取出一份 HTML 的**应用脚本**，兼容两种源码形态：
 *   · 老形态：649 行脚本直接内联在 `<script>` 里
 *   · 方案 T：模板的 `<script>` 里只放一个应用脚本占位符，真正的脚本来自
 *     `src/template/app/*.js` 分片（按文件名排序拼接）
 * 不处理第二种的话，`--templates` 对新骨架会抠出一段没有 VM 的占位符、直接把探针打崩。
 */
function appJsOf(html, appDir) {
  const APP_PH = "/*__" + "APP__*/";
  if (html.includes(APP_PH) && appDir && existsSync(appDir)) {
    const parts = readdirSync(appDir).filter((n) => n.endsWith(".js")).sort();
    if (parts.length) return parts.map((n) => readFileSync(join(appDir, n), "utf8")).join("\n");
  }
  return extractAppJs(html);
}
const APP_DIRS = {
  [REF]: resolve(ROOT, arg("ref-app", TEMPLATE_MODE ? join(dirname(REF), "app") : "src/template/app")),
  [CUR]: resolve(ROOT, arg("app", join(ROOT, "src", "template", "app"))),
};

/**
 * ════════ 有意变更登记表（= 交付报告 P6 表）════════
 * 每条必须至少命中一次，否则报「登记了但未发生」（防登记表腐烂）。
 */
const ALLOWED = [
  {
    id: "D-0-income-caliber-notes", derivedOnly: true,
    reason:
      "`notes[0]` 收入口径说明改为**由 income.source 驱动**：原文写「Σ 逐单 finalSettlementAmount」，" +
      "而实测两项目 source 均为 `platform-aggregate` → 说明与数据源不符（Lead 授权修）",
    test: (p) => /^notes\.0$/.test(p),
  },
  {
    id: "D-2-promo-t1-wording", derivedOnly: true,
    reason: "`notes[1]` 措辞「今日推广恒为 0」改为由 promoUnavailable 驱动的「今日窗口取不到数、显示 —」（Lead 批准）",
    test: (p) => /^notes\.1$/.test(p),
  },
  {
    id: "D-0+D-2-notes-aggregate", derivedOnly: true,
    reason: "`notesHash` / `notesCount` 是 notes 数组的聚合哈希与条数，随上面两条文案变更而变（不是独立变更）",
    test: (p) => /^notes(Hash|Count)$/.test(p),
  },
  {
    id: "P4-injected-caliber", derivedOnly: true,
    reason: "P4 新增注入 `VM.caliber`（口径单一真相源），由 src/lib/caliber.mjs 产出，模板只读",
    test: (p) => /^caliber(\.|$)/.test(p),
  },
  {
    id: "P4-injected-thresholds", derivedOnly: true,
    reason: "P4 新增注入 `VM.thresholds`，把原先散落模板的 6 处阈值字面量集中到 caliber.mjs（**值未变**，只是搬家）",
    test: (p) => /^thresholds(\.|$)/.test(p),
  },
  {
    id: "P5-injected-selfcheck-specs", derivedOnly: true,
    reason: "P5 新增注入 `VM.selfCheckSpecs`（页面自检块的断言清单 id，与 build 侧 checkInvariants 同源）",
    test: (p) => /^selfCheckSpecs(\.|$)/.test(p),
  },
  {
    id: "P5-injected-selfcheck-results", derivedOnly: true,
    reason:
      "P5 新增注入 `VM.selfCheck`（**构建期**不变量结论）。其中两条（无 undefined/NaN、平台不可加）必须遍历整份 VM，" +
      "若放页面侧会把读集探针淹掉；故构建期算好、页面展示，其余断言页面侧重算并要求两侧一致",
    test: (p) => /^selfCheck(\.|$)/.test(p),
  },
  // ── 可见表现的有意变更（渲染指纹侧） ──
  {
    id: "D-1-store-table-name-and-status",
    reason:
      "D-1 修复（Lead 裁决选项①）：门店表原先读 `s.mtName`/`s.live.mtStatus`（不存在）→ 店名显示成门店 ID、美团状态恒为 `—`；" +
      "改为读 `unifiedRows` 真实字段 `name`/`mtStatus`。这是**有意的可见修正**",
    test: (p) =>
      // ⚠️ 排除 `filter:` / `sort:` 交互场景 —— 那两个场景的门店表差异归 R10 / R2-sort 一组登记，
      //    否则会被本条（更宽）先命中，R10 永远 0 命中、登记表腐烂告警会一直响。
      /^scenarios\.(?!filter:|sort:)[^.]+\.elements\.storeWrap\./.test(p) ||
      /^scenarios\.(?!filter:|sort:)[^.]+\.unifiedStores\./.test(p) ||
      /^scenarios\.(?!filter:|sort:)[^.]+\.elements\.storeTag\./.test(p),
  },
  {
    id: "D-4a-exposure-caliber-per-project",
    reason:
      "曝光口径文案原先把**品牌A** 2026-09-21 的实测数（平台 18,280 / 逐店 2,526）写死成两项目通用文案，" +
      "而品牌B当天 PV 是 17,395 —— 等于在品牌B页面展示品牌A的数字，违反项目隔离。" +
      "现改为按项目取 `VM.caliber.exposure.textByProject`；无逐店样本的项目不给数字对比",
    test: (p) => /^scenarios\.[^.]+\.elements\.expoTopSub\./.test(p),
  },
  {
    id: "P4-2-income-caliber-short-from-vm",
    reason:
      "KPI 卡片脚注与趋势图副标题的收入口径短语改为从 `VM.caliber.income.shortBySource` 取（原先模板硬编码）；" +
      "同时推广脚注改由 `VM.caliber.promo.unavailableNote`（D-2）驱动 —— 两者共用 `#kpis` 容器",
    test: (p) =>
      /^scenarios\.[^.]+\.elements\.kpis\./.test(p) ||
      /^scenarios\.[^.]+\.elements\.incomeCaliberSub\./.test(p),
  },
  {
    id: "P5-selfcheck-block-visible",
    reason: "P5 新增可见 DOM：⑤ 口径自检卡片（task-2 明确要求，登记为有意新增）",
    test: (p) => /^scenarios\.[^.]+\.elements\.selfCheck(Tag|Sub|Wrap)\./.test(p),
  },
  // ── 读集变化的有意项（读集是"读了什么"的契约，变了也要登记） ──
  {
    id: "D-1-readset-stops-reading-missing-fields",
    reason:
      "D-1 修复后，模板**不再去读**不存在的 `unifiedRows[].mtName/tbName/live`（原先恒为 undefined 的漂移源头消失），" +
      "并开始读真实存在的 `unifiedRows[].name/mtStatus`",
    test: (p) =>
      /^\.projects\.[^.]+\.unifiedRows\[\]\.(mtName|tbName|live|name|mtStatus)$/.test(p) ||
      /^\.projects\.[^.]+\.unifiedStores\[\]\.(mtStatus|name)$/.test(p),
  },
  {
    id: "P4-readset-adds-caliber",
    reason: "P4 之后模板开始读 `VM.caliber.*`（口径单一真相源）与 `VM.thresholds.*`（阈值集中化）",
    test: (p) => /^\.(caliber|thresholds)(\[\]|\.|$)/.test(p),
  },
  {
    id: "R12-readset-highcancel-poiid",
    reason:
      "R12：高取消门店表新增城市列后，模板渲染期读 `highCancelD7[].poiId`" +
      "（与 unifiedStores.mtId 精确匹配城市；原先模板只读 poiName/orders/cancel/rate/income）",
    test: (p) => /^\.projects\.[^.]+\.highCancelD7\[\]\.poiId$/.test(p),
  },
  {
    id: "R12-readset-highcancel-shangou",
    reason:
      "R12：面板平台切换到「全部平台/闪购」后，模板渲染期读 `taobao.stores[]`" +
      "（闪购近7日窗口逐店：name/city/orders/invalid/rate/amt，取消=流失订单、金额=成交额）",
    test: (p) => /^\.projects\.[^.]+\.taobao(\.stores(\[\](\.\w+)?)?)?$/.test(p),
  },
  {
    id: "R13-readset-hourly-roi",
    reason:
      "R13：推广 ROI 口径改「预计收入 ÷ 推广消耗（本看板计算）」后，模板渲染期新增读取：" +
      "① `ka.realtime.hourly[]/hourlyYesterday[]` 的 `roi`/`income`（分时 ROI 线，数据层按小时对齐现算）；" +
      "② `today.hourly[]/hourlyYesterday[]` 的 `income`（分时预计收入，随 digest 派生进入读集）",
    test: (p) =>
      /^\.projects\.[^.]+\.ka\.realtime\.hourly(Yesterday)?\[\]\.(roi|income)$/.test(p) ||
      /^\.projects\.[^.]+\.today\.hourly(Yesterday)?\[\]\.income$/.test(p),
  },
  {
    id: "R16-readset-shangou-roi-income",
    reason:
      "R16：闪购 ROI 口径改「眼镜店总账号预计收入 ÷ o2o 全站推广消耗」后，模板渲染期新增读取：" +
      "`taobao.promo` 的 `incomeLogin`（登录节点预计收入，MDA ② 族）、" +
      "`windows.*.roiIncome` / `daily[].roiIncome` / `todayHourly[].roiIncome`（本看板现算 ROI）",
    test: (p) =>
      /^\.projects\.[^.]+\.taobao\.promo\.(incomeLogin(\.[\w[\].]+)?|windows\.\w+\.roiIncome|daily\[\]\.(roiIncome|incomeLogin)|todayHourly\[\]\.(roiIncome|incomeLogin))$/.test(p),
  },
  {
    id: "R17-expo-chart-height-align",
    reason:
      "R17：大盘曝光图高度 225px（sm）→ 270px，与预计收入/取消率趋势图对齐（经营者：图表高度与其余三个趋势图对齐，" +
      "确保整齐美观；原 sm 卡在 grid 拉伸下图表下方留白）。唯一预期差异 = c-expo 容器 class 与图表高度",
    test: (p) => /^scenarios\.[^.]+\.elements\.c-expo\./.test(p),
  },
  {
    id: "R18-chart-uniform-height-and-notes",
    reason:
      "R18（经营者：口径解释文字篇幅/高度统一）：① 推广图 225→270px（四图统一）；② .sub 说明区统一 min-height 38px" +
      "（两行，四卡图表起点一致，平台/窗口/项目切换不再跳）；③ 推广卡与曝光卡说明文字全面瘦身" +
      "（TB_PROMO_NOTE 全文不再上屏，改一行短口径 tbPromoShort；MDA family 全文同样撤下）。" +
      "预期差异 = c-ka 容器 class、kaSub/expoSub 说明文本；读集收缩：美团 isHour 分支 kaSub 移除「预算 X 元」" +
      "文案后模板不再读 ka.realtime.budget（两账号同变，属预期）",
    test: (p) =>
      /^scenarios\.[^.]+\.elements\.c-ka\./.test(p) ||
      /^scenarios\.[^.]+\.elements\.expoSub\./.test(p) ||
      /^\.projects\.[^.]+\.ka\.realtime\.budget$/.test(p) ||
      /^\.caliber\.dailyOnlyNote$/.test(p),
  },
  {
    id: "R20-kpi-platform-switch",
    reason:
      "R20（经营者：顶部 KPI 七卡随平台切换而变化）：① 闪购视图新增 drawKpisShangou —— 数据层新增 " +
      "`taobao.kpiWindows`（与美团 out.windows 同构：MDA 窗口的预计收入/有效订单/流失单 + promo 窗口的" +
      "消耗/曝光/点击 + 本看板现算占比与 ROI，口径见 dashboard-model.mjs R20 注释）；" +
      "② 「全部平台」模式 KPI 卡片标签带「美团」小标（并列展示，不跨平台相加）；" +
      "③ PLATFORM_NOTE 过时描述（「闪购只有近 7 天窗口聚合」）同步修正。" +
      "预期差异 = kpis 容器文本（闪购场景换数据源、全部平台场景加标注）+ notes 说明文本 + " +
      "读集新增 .projects.*.taobao.kpiWindows.*（闪购场景）",
    test: (p) =>
      /^scenarios\.[^.]+\.elements\.kpis\./.test(p) ||
      /^scenarios\.[^.]+\.elements\.notes\./.test(p) ||
      /^\.projects\.[^.]+\.taobao\.kpiWindows/.test(p),
  },
  {
    id: "R21-kpi-all-platform-sum",
    reason:
      "R21（经营者：全部平台口径应为美团+闪购）：「全部平台」KPI 七卡从「美团口径+标注」改为**两平台合计** —— " +
      "数据层新增 `kpiAll`（预计收入/订单/取消单=美团取消+闪购流失 求和；客单价按有效订单加权；" +
      "推广消耗 = 美团推广 + 闪购推广（分品牌：品牌A=o2o、品牌B=斗金）；占比 = 消耗合计÷收入合计；ROI = 1÷占比）。" +
      "PLATFORM_NOTE 同步改写（合计仅用于 KPI 七卡，趋势图仍并列）。" +
      "预期差异 = kpis 容器文本（全部平台场景）+ notes 文本 + 读集新增 .projects.*.kpiAll.*；" +
      "读集收缩：全部平台场景下模板不再读 out.windows 的 KPI 用字段（改读 kpiAll，见 shrink 正则）",
    test: (p) =>
      /^scenarios\.[^.]+\.elements\.kpis\./.test(p) ||
      /^scenarios\.[^.]+\.elements\.notes\./.test(p) ||
      /^\.projects\.[^.]+\.kpiAll/.test(p) ||
      /^\.projects\.[^.]+\.windows\.(today|yesterday|d7|d30)\.(validOrderCount|avgOrderValue|promoClick|promoLive|promoRoi|promoShow|promoUnavailable)$/.test(p),
  },
  {
    id: "R22-trend-all-sum",
    reason:
      "R22（经营者：四个趋势板块也按最新合计口径）：「全部平台」下 预计收入/取消率/推广与ROI/大盘曝光 四图从「仅美团曲线」改为**美团+闪购合计** —— " +
      "数据层新增 `trendAll`（按日期/小时对齐求和；推广仅日粒度，小时窗口退化最近7天；曝光人数=美团+闪购，次数暂仅美团）。" +
      "取数层 fetch-taobao-mda 新增 valid_order_cnt 分时（合计取消率分母）。" +
      "预期差异 = 四个趋势卡的容器/图例/说明文本（全部平台场景）+ 读集新增 .projects.*.trendAll.*",
    test: (p) =>
      /^scenarios\.[^.]+\.elements\.(c-income|c-cancel|incomeTrendTag|incomeTrendSub|cancelTrendTag|cancelTrendSub|c-ka|kaTag|kaSub|c-expo|expoTag|expoSub|expoTopSub|expoTopWrap)\./.test(p) ||
      /^\.projects\.[^.]+\.trendAll/.test(p) ||
      // 读集收缩：全部平台场景下曝光卡不再读美团 exposure 的部分字段（改读 trendAll.expo）
      /^\.projects\.[^.]+\.exposure\.(daily\[\]\.date|windows\.(today|d7|d30)\.(day|days|ringPv|ringUv))$/.test(p) ||
      // 读集收缩②（R23 补登记，原被 readDelta 检查只看前 20 处掩盖）：基线「全部平台=美团渲染」
      // （ref-post 的 isMeituanView 含 "all"），R21/R22 改走 kpiAll/trendAll 聚合后，parity 场景矩阵
      // （init + 项目×窗口 + 交互，均无平台切换到美团）下模板不再直读下列美团原始字段。
      // 美团视图本身（platSeg 切换后的 drawKa/drawKpis 等）仍读这些字段，契约不变。
      /^\.projects\.[^.]+\.ka(\.byProduct)?$/.test(p) ||
      /^\.projects\.[^.]+\.ka\.daily(30)?(\[\](\.(cost|date|roi))?)?$/.test(p) ||
      /^\.projects\.[^.]+\.ka\.realtime(\.(balance|cost|hourly(Yesterday)?)(\[\](\.(cost|hour))?)?)?$/.test(p) ||
      /^\.projects\.[^.]+\.today\.hourly(Yesterday)?(\[\](\.(cancel|hour|rate))?)?$/.test(p) ||
      /^\.projects\.[^.]+\.income(\.source|\.daily\[\]\.(cancelCount|projectedIncome))?$/.test(p),
  },
  {
    id: "R24-freshness-badge",
    reason:
      "R24（经营者：数据获取不稳定 → 新鲜度必须上屏）：页首新增 `freshBadge` 数据新鲜度徽标 —— " +
      "以当前项目 dataTime 为基准实时计算：2h 内 ok 绿 / 2-6h warn 黄 / 超 6h no 红（60s 自刷新）。" +
      "配套 STATIC_IDS 注册 freshBadge（桩/模板双向集合断言）。" +
      "预期差异 = 所有场景 freshBadge.cls/.text（新增可见元素，每场景 2 处 × 20 场景 + init）+" +
      "timers.0.*（60s 自刷新的 setInterval，基线无任何 timer 注册）",
    test: (p) =>
      /^scenarios\.[^.]+\.elements\.freshBadge\.(cls|text)$/.test(p) ||
      /^timers\.0\.(fn|interval|ms)$/.test(p),
  },
  {
    id: "R23-highcancel-all-merged",
    reason:
      "R23（经营者：高取消门店全部平台=同名店跨平台合并）：「全部平台」下该面板从「美团/闪购并列展示」改为**按归一化店名+城市合并同店** —— " +
      "取消单 = 美团取消 + 闪购流失；取消率 = 合计取消 ÷ 合计订单（渲染期自算，分母含两平台总单）；" +
      "预计收入合并店仅含美团（闪购逐店只有成交额，如实标注）；闪购独有门店仍单列；门槛 单量≥5、取消率降序前 30 不变。" +
      "预期差异 = highCancelWrap/highCancelSub 文本（元素差异已由 R12 登记覆盖，此处仅登记读集变化）；" +
      "读集收缩：合并模式渲染不再读 highCancelD7[].rate 与 taobao.stores[].rate（rate 由渲染期合计现算）",
    test: (p) =>
      /^\.projects\.[^.]+\.highCancelD7\[\]\.rate$/.test(p) ||
      /^\.projects\.[^.]+\.taobao\.stores\[\]\.rate$/.test(p),
  },
  // ── Lead 指派的 3 条数据正确性小缺陷（R2 / R10 / R11），作为**独立一组**登记 ──
  {
    id: "R2-missing-status-not-closed",
    reason:
      "R2：台账 Excel 的 `#N/A`/`N/A` 等**缺失值标记**原先被当成「确定的未营业」。" +
      "现在缺失值算「未知」——门店表不再渲染假的「未营业」标签，`anomalies` 里由缺失值撑起来的假条目被剔除",
    test: (p) =>
      // R2 的实际影响在**异常列表**：由缺失值撑起来的假条目被剔除、状态文本归一化。
      // ⚠️ 刻意**不**认领 `storeWrap`（非筛选场景下它与 D-1 重叠，由 D-1 那条更宽的登记负责），
      //    也排除 `filter:`/`sort:` 交互场景（那两块归 R10 / sort 登记），否则会互相吞掉命中。
      /^scenarios\.(?!filter:|sort:)[^.]+\.elements\.(anomWrap|anomTag|anomSub)\./.test(p) ||
      /^projects\.[^.]+\.(anomaliesCount|anomaliesSample|anomaliesHash)$/.test(p),
  },
  {
    id: "R10-city-filter-normalize",
    reason:
      "R10：城市「杭州」与「杭州市」并存导致筛选漏门店。现在筛选时两边都做「去『市』后缀 + 小写」归一化" +
      "（**只影响匹配，不改显示的原始城市名**）。命中来自 `filter:*` 交互场景",
    test: (p) => /^scenarios\.filter:[^.]+\.elements\.(storeWrap|storeTag)\./.test(p),
  },
  {
    id: "R11-ka-daily-ascending",
    reason:
      "R11：ka 报表 `list` 倒序返回，推广逐日 X 轴与同页其它逐日图方向相反。现在按日期升序统一",
    test: (p) =>
      /^projects\.[^.]+\.ka\.(dailyHash|dailyCount)$/.test(p) ||
      /^scenarios\.[^.]+\.charts\.\d+\.option\.(xAxis\.data|series\.\d+\.data)(\.\d+)?$/.test(p),
  },
  {
    id: "R2/R10-sort-interaction",
    reason:
      "表头排序交互场景（`sort:*`）下的门店表内容差异：排序键取自行对象，D-1 改了 `name`/`mtStatus` 的取值，" +
      "排序结果随之变化属预期",
    test: (p) => /^scenarios\.sort:[^.]+\.elements\.storeWrap\./.test(p),
  },
  {
    id: "R12-highcancel-sort-and-city",
    reason:
      "R12：高取消门店表改造 —— ① 新增「城市」列（渲染期从 unifiedStores 匹配：mtId 精确优先、归一化店名兜底，" +
      "数据层 highCancelD7 行结构不变）；② 总单/取消/取消率/预计收入/城市表头可点击升降序（默认仍取消率降序）；" +
      "③ 面板新增平台切换（全部平台/美团/闪购，默认全部平台；全部=两平台门店并列展示不合并同店）与" +
      "城市下拉筛选（默认全部城市）。默认视图下唯一可见差异 = 多出城市列 + 平台列 + 控件",
    test: (p) =>
      /^scenarios\.[^.]+\.elements\.highCancelWrap\./.test(p) ||
      /^scenarios\.[^.]+\.elements\.(highCancelTag|highCancelSub|hcPlatSeg|hcCitySel)\./.test(p),
  },
  {
    id: "R13-promo-roi-income-caliber",
    reason:
      "R13：推广 ROI 口径统一改为「预计收入 ÷ 推广消耗（本看板计算）」（经营者原话：所有推广 ROI 不再用平台转化口径）——" +
      "① KPI「推广 ROI」卡脚注与取值（今日现算，不再恒 —）；② 推广图今日/昨日分时**新增 ROI 线与右轴**、" +
      "逐日 ROI 换口径（c-ka 的 option series/yAxis 子树整体变化；series.data/xAxis.data 由 R11 认领）；" +
      "③ kaTag/kaSub 说明文案更新；④ 闪购分支撤掉 GMV 口径 ROI 线（双轴退单轴）；" +
      "⑤ caliber.promo.roiNote 文案替换 roiT1Short/roiT1Note",
    test: (p) =>
      /^scenarios\.[^.]+\.charts\.\d+\.option\.(series\.\d+|yAxis(\.\d+)?)(\.[\w.]+)?$/.test(p) ||
      /^scenarios\.[^.]+\.elements\.(kpis|kaTag|kaSub)\./.test(p) ||
      /^\.caliber\.promo\.(\w+)$/.test(p),
  },
];

/** 允许新增的 VM 顶层键（新键 = 数据契约变化，必须显式登记）。 */
const ALLOWED_VM_KEYS = ["caliber", "thresholds", "selfCheckSpecs", "selfCheck"];

/** ════════ 桩预留 id ════════
 * P5 自检块已落地，三个 id 都已由模板 markup 声明 → 本表按设计**清空**。
 * （这正是「预留项落地后必须移出」这条防腐烂机制在起作用：留在表里会被报"已不在多出集合"。）
 */
const RESERVED_IDS = [];

/** ════════ 读集豁免表（不在 derivedDigest 覆盖范围内的合法读取）════════ */
const EXEMPT_READS = [
  {
    id: "generatedAt-volatile",
    reason: "`VM.generatedAt` 每次构建都变，derivedDigest 刻意剔除；已由 vmDigest 的哨兵值覆盖",
    test: (p) => p === ".generatedAt",
  },
  {
    id: "unifiedStores-template-side-join",
    reason:
      "`unifiedStores` 目前是**模板 init 里现算**的 join 结果（tpl:653-671），不在 build 产出的 VM 里，" +
      "所以 derivedDigest 看不到。P2 把它下沉到 dashboard-model 后，本豁免必须删除（否则等于承认派生值对照有盲区）",
    test: (p) => /^\.projects\.[^.]+\.unifiedStores(\[\])?/.test(p),
  },
  {
    id: "vm-caliber-thresholds-selfcheck",
    reason:
      "P4/P5 注入的 `VM.caliber` / `VM.thresholds` / `VM.selfCheck` / `VM.selfCheckSpecs` 是**口径元数据**：" +
      "模板只读、值由 `src/lib/caliber.mjs` 这一处产出，另有 `checkInvariants()` 与页面自检块比对。" +
      "它们不进 derivedDigest 是刻意的（避免摘要变成元数据的镜像）",
    test: (p) => /^\.(caliber|thresholds|selfCheck|selfCheckSpecs)(\[\]|\.|$)/.test(p),
  },
];

// ════════════════════════════════════════════════════════════════

const MATRIX = [];
for (const p of ["品牌A", "品牌B"]) for (const w of ["今日", "昨日", "近7天", "近30天"]) MATRIX.push([p, w]);
const WIN_KEY = { 今日: "today", 昨日: "yesterday", 近7天: "d7", 近30天: "d30" };

const readOrDie = (p) => {
  if (!existsSync(p)) { console.error(`⛔ 找不到 ${p}`); process.exit(2); }
  return readFileSync(p, "utf8");
};

const refHtml = readOrDie(REF);
const curHtml = readOrDie(CUR);
const refProf = htmlProfile(refHtml);
const curProf = htmlProfile(curHtml);

/**
 * 基准 VM 来源优先级：
 *   显式 `--vm=` > 模板模式：**合成夹具** > 产物模式：新侧产物 > 旧侧产物 > 改前产物。
 *
 * ⚠️ 三条踩过的坑：
 *   1. 新模板会读 `VM.caliber` / `VM.thresholds` / `VM.selfCheckSpecs` 这些**新增注入键**。
 *      拿**旧产物**的 VM 去喂新脚本 → 大范围 `undefined` → 假差异甚至直接抛错
 *      （实测：`Cannot read properties of undefined (reading 'windowDefs')`）。
 *      所以模板模式下要优先用带这些键的夹具；`--vm` 永远可以覆盖。
 *   2. 反过来，旧脚本对新 VM 里不认识的键是**免疫**的 → 「新 VM 同时喂两侧」既安全，
 *      又顺带验证了「新 build 没把旧模板弄坏」。
 *   3. 刻意**不硬编码**某一版基线产物当唯一来源 —— 那份数据会随刷新过期。
 */
function loadVm() {
  const explicit = arg("vm", null);
  if (explicit) {
    const p = resolve(ROOT, explicit);
    if (!existsSync(p)) { console.error(`⛔ --vm 指向的文件不存在：${p}`); process.exit(2); }
    const t = readFileSync(p, "utf8");
    return t.trimStart().startsWith("{") ? JSON.parse(t) : htmlProfile(t).vm;
  }
  if (TEMPLATE_MODE && existsSync(FIXTURE_VM)) return JSON.parse(readFileSync(FIXTURE_VM, "utf8"));
  if (curProf.hasVm) return curProf.vm;
  if (refProf.hasVm) return refProf.vm;
  if (existsSync(BEFORE_PRODUCT)) return htmlProfile(readFileSync(BEFORE_PRODUCT, "utf8")).vm;
  if (existsSync(FIXTURE_VM)) {
    console.log(`  ⚠️ 找不到 _recon/struct 基线产物 → 改用合成夹具 ${FIXTURE_VM}`);
    return JSON.parse(readFileSync(FIXTURE_VM, "utf8"));
  }
  console.error("⛔ 拿不到基准 VM：请用 --vm=<产物 html 或 vm json>");
  process.exit(2);
}
const VM = loadVm();
const VM_FROM = arg("vm", null) ?? (TEMPLATE_MODE ? "src/test-fixtures/parity-vm.json（合成夹具）" : curProf.hasVm ? "cur 产物" : refProf.hasVm ? "ref 产物" : "_recon/struct/before.product.html");

console.log("════════ 结构优化 parity 验收 ════════");
console.log(`模式      ${TEMPLATE_MODE ? "模板 vs 模板（渲染指纹 + 读集）" : "产物 vs 产物（指纹 + 派生值 + 读集）"}`);
console.log(`改前 ref  ${REF}`);
console.log(`改后 cur  ${CUR}`);
console.log(`基准 VM   来源 ${VM_FROM}（${Object.keys(VM.projects ?? {}).length} 个项目 / ${Object.keys(VM).length} 个顶层键）`);
console.log(`场景矩阵  init + ${MATRIX.length} 个 项目×窗口`);

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  ⛔ ${msg}`); };

/**
 * ★ 产物自检（**必须先于 VM 注入做**）。
 *
 * 血泪教训：一开始 parity 直接把 VM 注入两侧的应用脚本再做对比，
 * 于是「产物里的数据占位符根本没被替换」这种致命问题被**注入动作本身悄悄修好了** ——
 * 产物其实是 `const VM = ;`（语法错、整页白屏），parity 却报 0 差异。
 * 所以：对**产物**必须先验证它自带的内联 VM 是好的，再拿统一 VM 做渲染对比。
 */
for (const [side, prof, appJsRaw] of [
  ["ref", refProf, appJsOf(refHtml, APP_DIRS[REF])],
  ["cur", curProf, appJsOf(curHtml, APP_DIRS[CUR])],
]) {
  if (!prof.hasVm) continue; // 模板源码形态：本来就没有内联 VM
  const ph = "/*__" + "DATA__*/";
  if (appJsRaw.includes(ph)) fail(`${side} 产物里数据占位符未被替换 —— 产物是坏的（注入点可能被注释吞掉）`);
  try {
    const { vm: own } = extractVmBlock(appJsRaw);
    if (!own || typeof own !== "object" || !own.projects) fail(`${side} 产物自带的内联 VM 结构异常`);
  } catch (e) {
    fail(`${side} 产物自带的内联 VM 解析失败：${e.message}`);
  }
  try {
    new Function(appJsRaw);
  } catch (e) {
    fail(`${side} 产物应用脚本语法错误（页面会整页白屏）：${e.message}`);
  }
}
console.log(`\n──── ⓪ 产物自检（占位符 / 内联 VM / 语法） ────`);
console.log(`  ref 产物自带 VM ${refProf.hasVm ? "✅" : "（模板）"} / cur 产物自带 VM ${curProf.hasVm ? "✅" : "（模板）"}`);

// ── ① 渲染指纹 ──
const refApp = injectVm(appJsOf(refHtml, APP_DIRS[REF]), VM);
const curApp = injectVm(appJsOf(curHtml, APP_DIRS[CUR]), VM);
console.log(`\n──── ① 渲染指纹（同一份 VM） ────`);
console.log(`  ref 应用脚本 ${refApp.length} 字符 / cur 应用脚本 ${curApp.length} 字符`);

const fRef = fingerprintApp({ appJs: refApp, label: "ref", matrix: MATRIX, probe: true });
const fCur = fingerprintApp({ appJs: curApp, label: "cur", matrix: MATRIX, probe: true });
for (const [side, f] of [["ref", fRef], ["cur", fCur]]) {
  if (f.errors.length) fail(`${side} 运行时错误 ${f.errors.length} 条：${f.errors.slice(0, 3).join(" | ")}`);
}
console.log(`  ref 错误 ${fRef.errors.length} / cur 错误 ${fCur.errors.length}`);
const EXPECTED_SCENARIOS = 1 + MATRIX.length + INTERACTION_SCENARIOS.length;
console.log(`  ref 场景 ${Object.keys(fRef.scenarios).length} / cur ${Object.keys(fCur.scenarios).length}（期望 ${EXPECTED_SCENARIOS} = init + ${MATRIX.length} 项目×窗口 + ${INTERACTION_SCENARIOS.length} 交互）`);
for (const [side, f] of [["ref", fRef], ["cur", fCur]]) {
  const n = Object.keys(f.scenarios).length;
  if (n !== EXPECTED_SCENARIOS) fail(`${side} 场景数 ${n} ≠ ${EXPECTED_SCENARIOS}`);
}

// ★ 场景门禁：切换必须真的发生，否则两侧一起退化成 init 副本 → 假绿
const scenChecks = (side, f) => {
  const names = Object.keys(f.scenarios);
  if (names.length !== EXPECTED_SCENARIOS) return; // 数量断言已经会失败，这里别跟着崩（踩过）
  const bad = Object.values(f.scenarios).filter((s) => s.clicks && !s.clicks.every((c) => c === "ok"));
  if (bad.length) fail(`${side} 有 ${bad.length} 个场景点不到按钮（clicks=${JSON.stringify(bad.map((s) => [s.scenario, s.clicks]))}）`);
  const mismatched = [];
  for (const [proj, win] of MATRIX) {
    const s = f.scenarios[`${proj}|${win}`];
    if (!s || s.state?.CUR_WIN !== WIN_KEY[win]) mismatched.push(`${proj}|${win}→${JSON.stringify(s?.state)}`);
  }
  if (mismatched.length) fail(`${side} 场景状态与请求不符：${mismatched.slice(0, 3).join(", ")}`);
  // 交互场景必须真的执行到（否则和 init 一模一样 → 等于没测）
  const sameAsInit = INTERACTION_SCENARIOS.filter((n) => f.scenarios[n]?.elements.storeWrap.html === f.scenarios.init?.elements.storeWrap.html);
  if (sameAsInit.length === INTERACTION_SCENARIOS.length) {
    fail(`${side} 全部交互场景的门店表与 init 完全相同 —— 筛选/排序可能根本没生效`);
  }
  // 每个项目内，不同窗口的载荷必须不同（证明窗口切换真的重渲染了）
  for (const proj of ["品牌A", "品牌B"]) {
    const payloads = new Set(MATRIX.filter((m) => m[0] === proj).map((m) => f.scenarios[`${proj}|${m[1]}`]?.elements?.kpis?.html));
    if (payloads.has(undefined)) continue;
    if (payloads.size < 2) fail(`${side} 项目「${proj}」4 个窗口的 KPI 载荷只有 ${payloads.size} 种（窗口切换可能没生效）`);
  }
};
scenChecks("ref", fRef);
scenChecks("cur", fCur);

// 图表集合门禁
const chartDelta = (side, f) => {
  const ids = [...new Set(Object.values(f.scenarios).flatMap((s) => s.charts.map((c) => c.id)))].sort();
  const disp = [...new Set(f.disposedCharts)].sort();
  console.log(`  ${side} 出现过的图表 ${ids.length} 个：${ids.join(", ")}`);
  console.log(`  ${side} dispose 过的图表 ${disp.length} 个：${disp.join(", ")}`);
  return ids;
};
const refCharts = chartDelta("ref", fRef);
const curCharts = chartDelta("cur", fCur);
if (JSON.stringify(refCharts) !== JSON.stringify(curCharts)) fail(`图表集合不同：ref ${refCharts} vs cur ${curCharts}`);

const leaves = (v, p = "", acc = []) => {
  const isObj = (x) => x && typeof x === "object";
  if (!isObj(v)) { acc.push([p, v]); return acc; }
  for (const k of Object.keys(v)) leaves(v[k], p ? `${p}.${k}` : k, acc);
  return acc;
};
const leafMap = (v) => new Map(leaves(canonicalize(v)));

// vmReads 是独立分析维度，不参与渲染值 diff
const stripReads = (f) => { const { vmReads, ...rest } = f; return rest; };
const A = leafMap(stripReads(fRef)), B = leafMap(stripReads(fCur));
const allPaths = [...new Set([...A.keys(), ...B.keys()])].sort();
const D = [];
for (const p of allPaths) {
  const a = A.has(p) ? A.get(p) : "<缺失>";
  const b = B.has(p) ? B.get(p) : "<缺失>";
  if (JSON.stringify(a) !== JSON.stringify(b)) D.push({ path: p, ref: a, cur: b });
}
const trunc = (x) => { const s = typeof x === "string" ? x : JSON.stringify(x); return s && s.length > 160 ? s.slice(0, 160) + `…(${s.length})` : s; };
console.log(`  指纹叶子节点 ${allPaths.length} 个，差异 ${D.length} 处`);

const allowHit = new Map(ALLOWED.map((a) => [a.id, 0]));
const unallowed = [];
for (const d of D) {
  const hit = ALLOWED.find((a) => a.test(d.path));
  if (hit) allowHit.set(hit.id, allowHit.get(hit.id) + 1);
  else unallowed.push(d);
}

// ── ③ VM 读集对照 ──
console.log(`\n──── ③ VM 读集对照（Proxy 探针） ────`);
const rRef = fRef.vmReads ?? {}, rCur = fCur.vmReads ?? {};
const undefOnly = (r) => Object.keys(r).filter((p) => r[p] === "undefined");
const uRef = undefOnly(rRef), uCur = undefOnly(rCur);
console.log(`  ref 读取路径 ${Object.keys(rRef).length} 条 / cur ${Object.keys(rCur).length} 条`);
console.log(`  ★ kind 恒为 undefined 的路径：ref ${uRef.length} 条 / cur ${uCur.length} 条`);
for (const p of uCur) fail(`cur 读集里字段名漂移（读到的恒为 undefined）：${p}`);
if (uRef.length && !uCur.length) console.log(`  （ref 有 ${uRef.length} 条漂移，cur 已修好 —— 属预期改进：${uRef.join(", ")}）`);

const readDelta = [];
for (const p of new Set([...Object.keys(rRef), ...Object.keys(rCur)])) {
  const a = rRef[p] ?? "<未读>", b = rCur[p] ?? "<未读>";
  if (a !== b) readDelta.push({ path: p, ref: a, cur: b });
}
console.log(`  读集差异 ${readDelta.length} 处`);
// ⭐ R23 教训：原先只检查前 20 处（slice(0,20)），排在后面的读集差异会被**静默跳过**
//   （R23 的 stores[].rate 收缩就没进前 20，登记了也命不中）。改为全量匹配 ALLOWED，
//   未登记的才 fail；fail 日志限前 10 条防刷屏（failures 计数不受限，仍会置红）。
const unregDelta = readDelta.filter((d) => !ALLOWED.some((a) => a.test(d.path)));
for (const d of readDelta) {
  const hit = ALLOWED.find((a) => a.test(d.path));
  if (hit) allowHit.set(hit.id, allowHit.get(hit.id) + 1);
}
for (const d of unregDelta.slice(0, 10)) fail(`读集差异未登记：${d.path}  ref=${d.ref}  cur=${d.cur}`);
if (unregDelta.length > 10) fail(`……另有 ${unregDelta.length - 10} 条读集差异未登记`);
// 诊断产物：全量未登记差异落盘（排除读集差异的定位常用）
try { writeFileSync("parity-unreg-delta.txt", unregDelta.map((d) => `${d.path}\tref=${d.ref}\tcur=${d.cur}`).join("\n") + "\n"); } catch {}

// digest 覆盖度：**严格**沿摘要树走一遍，不用「任一祖先命中就算覆盖」那种空转判据。
//
// 判据：
//   · 宿主/基础访问（length/map/filter/slice…）不算数据读取 → 放行
//   · 摘要树里有同名键 → 继续往下走（数组取其代表元素继续）
//   · 摘要树里没有，但有 `<name>Hash` / `<name>Count` / `<name>Sample` → 视为已代表
//     （`*Hash` 是**全量内容哈希**，所以「只影响第 2..N 行」的变化也真的能被对比抓到）
//   · 都没有 → 未覆盖 → 必须进豁免表，否则判失败。这样摘要一旦漏字段，当场报错。
const INFRA_SEGS = new Set([
  "length", "constructor", "map", "filter", "slice", "sort", "find", "findIndex", "forEach",
  "reduce", "indexOf", "includes", "concat", "join", "some", "every", "flatMap", "at",
  "keys", "values", "entries", "then", "toJSON", "toString", "valueOf", "hasOwnProperty",
]);
const digestTree = canonicalize(derivedDigest(VM));
const isPlainObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function digestCovers(path) {
  const segs = path.replace(/^\./, "").replace(/\[\]/g, "").split(".").filter(Boolean);
  let node = digestTree;
  for (const seg of segs) {
    if (INFRA_SEGS.has(seg)) return true;
    if (!isPlainObj(node)) {
      // 摘要里这个位置是叶子/数组元素，而读集还要往下读字段 → 只能在数组容器层判过
      return false;
    }
    if (Object.hasOwn(node, seg)) {
      node = node[seg];
      if (Array.isArray(node)) node = node[0] ?? null;
      continue;
    }
    if (Object.hasOwn(node, `${seg}Hash`) || Object.hasOwn(node, `${seg}Count`) || Object.hasOwn(node, `${seg}Sample`)) {
      return true;
    }
    return false;
  }
  return true;
}

const exemptHit = new Map(EXEMPT_READS.map((e) => [e.id, 0]));
const uncovered = [];
for (const p of Object.keys(rCur)) {
  if (digestCovers(p)) continue;
  const e = EXEMPT_READS.find((x) => x.test(p));
  if (e) { exemptHit.set(e.id, exemptHit.get(e.id) + 1); continue; }
  uncovered.push(p);
}
console.log(`  未被 derivedDigest 覆盖且未豁免的读取路径 ${uncovered.length} 条`);
for (const p of uncovered.slice(0, 25)) fail(`派生值摘要漏了对渲染有影响的字段：${p}（读集 kind=${rCur[p]}）`);

// ── 标记语言 ↔ DOM 桩 id 契约 ──
console.log(`\n──── ④ id 契约（模板 markup ↔ DOM 桩） ────`);
for (const [side, html] of [["ref", refHtml], ["cur", curHtml]]) {
  const mIds = markupIds(html);
  const unknown = mIds.filter((id) => !STATIC_IDS.includes(id));
  if (unknown.length) fail(`${side} 模板 markup 里的 id 不在 DOM 桩的 STATIC_IDS 中：${unknown.join(", ")}`);
  console.log(`  ${side} markup id ${mIds.length} 个，桩不认识 ${unknown.length} 个`);
}
{
  const curIds = markupIds(curHtml);
  const reservedHit = new Set();
  const extra = STATIC_IDS.filter((id) => !curIds.includes(id));
  for (const id of extra) {
    const r = RESERVED_IDS.find((x) => x.id === id);
    if (r) reservedHit.add(id);
    else fail(`DOM 桩声明了 id「${id}」但模板 markup 里没有（桩比模板多 → 删容器这类回归会被静默放过）`);
  }
  console.log(`  cur markup id ${curIds.length} 个 / 桩 ${STATIC_IDS.length} 个 / 预留 ${reservedHit.size} 个`);
  for (const r of RESERVED_IDS) {
    if (!reservedHit.has(r.id)) console.log(`  ⚠️ 预留 id「${r.id}」已不在多出集合里（模板可能已落地或改名）→ 请从 RESERVED_IDS 移出：${r.reason}`);
  }
}
// 引用了但模板没有的 id（消费侧悬空引用）
{
  const curIds = new Set(markupIds(curHtml));
  const dangling = referencedIds(extractAppJs(curHtml)).filter((id) => !curIds.has(id));
  if (dangling.length) fail(`应用脚本 getElementById 引用了模板不存在的 id（悬空）：${dangling.join(", ")}`);
  console.log(`  cur 悬空 id 引用 ${dangling.length} 个`);
}

// ── ② 派生值对照 ──
console.log(`\n──── ② 派生值对照 ────`);
let derivedDiffs = null;
if (refProf.hasVm && curProf.hasVm) {
  const dv = leafMap(derivedDigest(refProf.vm)), dc = leafMap(derivedDigest(curProf.vm));
  const paths = [...new Set([...dv.keys(), ...dc.keys()])].sort();
  derivedDiffs = [];
  for (const p of paths) {
    const a = dv.has(p) ? dv.get(p) : "<缺失>";
    const b = dc.has(p) ? dc.get(p) : "<缺失>";
    if (JSON.stringify(a) !== JSON.stringify(b)) derivedDiffs.push({ path: p, ref: a, cur: b });
  }
  const va = stableJson(vmDigest(refProf.vm)), vb = stableJson(vmDigest(curProf.vm));
  console.log(`  VM 规范化摘要 ${va.length} B vs ${vb.length} B → ${va === vb ? "✅ 逐字节相同" : "⚠️ 不同"}`);
  // VM 顶层键集合差异（新键 = 数据契约变化，必须显式登记）
  const ka = Object.keys(vmDigest(refProf.vm)).sort(), kb2 = Object.keys(vmDigest(curProf.vm)).sort();
  const added = kb2.filter((k) => !ka.includes(k)), removed = ka.filter((k) => !kb2.includes(k));
  const badKeys = [...added, ...removed].filter((k) => !ALLOWED_VM_KEYS.includes(k));
  console.log(`  VM 顶层键 ref ${ka.length} 个 / cur ${kb2.length} 个；新增 ${JSON.stringify(added)} 移除 ${JSON.stringify(removed)}`);
  if (badKeys.length) fail(`VM 顶层键发生未登记变化：${badKeys.join(", ")}（若确为有意新增，请加进 ALLOWED_VM_KEYS）`);
  for (const k of added.filter((x) => ALLOWED_VM_KEYS.includes(x))) {
    const e = ALLOWED.find((a) => a.test(k));
    if (e) allowHit.set(e.id, (allowHit.get(e.id) ?? 0) + 1);
  }
  console.log(`  派生值字段 ${paths.length} 个，差异 ${derivedDiffs.length} 处`);
  const dvUnallowed = [];
  for (const d of derivedDiffs) {
    const hit = ALLOWED.find((a) => a.test(d.path));
    if (hit) allowHit.set(hit.id, allowHit.get(hit.id) + 1);
    else dvUnallowed.push(d);
  }
  console.log(`  其中未登记 ${dvUnallowed.length} 处`);
  for (const d of (dvUnallowed.length ? dvUnallowed : derivedDiffs).slice(0, 25)) {
    console.log(`    · ${d.path}: ${trunc(d.ref)} → ${trunc(d.cur)}`);
  }
  for (const d of dvUnallowed) fail(`派生值未登记差异：${d.path}`);
} else {
  const msg = `派生值对照被跳过（ref.hasVm=${refProf.hasVm} cur.hasVm=${curProf.hasVm}）`;
  if (TEMPLATE_MODE) console.log(`  ${msg} —— 已显式声明 --templates，符合预期`);
  else fail(`${msg}：产物模式下这等于"什么都没验却报通过"。请传两个**构建产物**，或显式加 --templates`);
}

// ── 自包含结构契约（产物才要求 2 个 script 块）──
console.log(`\n──── ⑤ 自包含结构契约 ────`);
console.log(`  ref script 块 ${refProf.scriptBlocks} / cur ${curProf.scriptBlocks}`);
if (curProf.hasVm) {
  if (!curProf.structure.ok) fail(`cur 产物违反自包含契约：${curProf.structure.findings.join("；")}`);
  if (curProf.scriptBlocks !== 2) fail(`cur 产物内联 script 块应为 2，实际 ${curProf.scriptBlocks}`);
  console.log(`  cur 契约 ${JSON.stringify(curProf.structure)}`);
} else {
  console.log(`  cur 是模板源码（占位符未替换属正常）：${JSON.stringify(curProf.structure.findings)}`);
}

// ── 差异汇总 ──
console.log(`\n──── ⑥ 汇总：三栏证书（"0 diff" 不是一个会被误解的单一数字） ────`);
console.log(`  ① 逐字节全等          —— 本工具不主张字符串全等：`);
console.log(`     · 结构/骨架未动的部分：见 ④ id 契约（${markupIds(curHtml).length} 个 markup id，桩不认识 0 个、悬空引用 0 个）`);
console.log(`     · 内联 echarts：见 verify-dashboard 的 \`static.echarts-integrity\`（要求与 vendor 逐字节一致）`);
console.log(`     · VM 规范化摘要：${stableJson(vmDigest(refProf.vm)) === stableJson(vmDigest(curProf.vm)) ? "逐字节相同" : "不同（差异见 ②，均已登记）"}`);
console.log(`  ② 结构等价            —— 渲染指纹 ${allPaths.length} 个叶子，差异 ${D.length} 处，全部命中白名单：${D.length > 0 ? "是" : "（无差异）"}`);
console.log(`     等价定义：DOM 结构（tag/id/class/dataset/子节点）+ 文本 + 每个 chart() 的 option JSON，逐叶子比对；`);
console.log(`     不做 innerHTML 字符串全等（class 化等结构优化必然改字符串，字符串全等会变假红）。`);
console.log(`  ③ 有意变更白名单      —— 登记 ${ALLOWED.length} 条 + 豁免 ${EXEMPT_READS.length} 条，命中如下：`);
console.log(`     ${[...allowHit.entries()].map(([id, n]) => `${id}=${n}`).join("  ") || "(无)"}`);
console.log(`     白名单之外的差异：${unallowed.length === 0 && failures.length === 0 ? "0 处 → PASS" : `${unallowed.length} 处 → FAIL`}`);
for (const a of ALLOWED) {
    if (allowHit.get(a.id) !== 0) continue;
    // 模板模式没有派生值对照，纯派生登记项命不中是**预期**的，别报"登记表腐烂"制造噪声
    if (TEMPLATE_MODE && a.derivedOnly) continue;
    console.log(`  ⚠️ 登记了但未发生：${a.id} —— ${a.reason}（登记表可能已过期）`);
  }
for (const e of EXEMPT_READS) if (exemptHit.get(e.id) === 0) console.log(`  ⚠️ 豁免了但未命中：${e.id} —— ${e.reason}（豁免表可能已过期）`);
if (unallowed.length) {
  /**
   * ⚠️ 必须**真的判失败**，不能只在上面打印一行。
   *    早先的版本把未登记差异只打印出来、没计入 `failures` ——
   *    于是「⛔ 渲染指纹未登记差异 1048 处」和「✅ parity 通过」同时出现，门禁形同虚设（踩过）。
   */
  fail(`渲染指纹有 ${unallowed.length} 处未登记差异（白名单之外的渲染改动一律视为回归）`);
  for (const d of unallowed.slice(0, 12)) console.log(`    · ${d.path}\n        ref: ${trunc(d.ref)}\n        cur: ${trunc(d.cur)}`);
  if (unallowed.length > 12) console.log(`    …（其余 ${unallowed.length - 12} 处略，完整清单见 --json 报告）`);
} else {
  console.log(`  ✅ 渲染指纹无未登记差异`);
}
console.log(`  失败项合计 ${failures.length}`);

if (JSON_OUT) {
  writeFileSync(resolve(ROOT, JSON_OUT), stableJson({
    mode: TEMPLATE_MODE ? "template" : "product",
    ref: REF, cur: CUR,
    leaves: allPaths.length, renderDiffs: D.length, unallowed,
    readPaths: { ref: Object.keys(rRef).length, cur: Object.keys(rCur).length },
    undefinedOnly: { ref: uRef, cur: uCur },
    readDelta, uncoveredReads: uncovered,
    allowed: Object.fromEntries(allowHit), exempt: Object.fromEntries(exemptHit),
    derivedDiffs, failures,
    refProfile: { bytes: refProf.bytes, lines: refProf.lines, scriptBlocks: refProf.scriptBlocks, appJsLines: refProf.appJsLines, appJsBytes: refProf.appJsBytes, hasVm: refProf.hasVm },
    curProfile: { bytes: curProf.bytes, lines: curProf.lines, scriptBlocks: curProf.scriptBlocks, appJsLines: curProf.appJsLines, appJsBytes: curProf.appJsBytes, hasVm: curProf.hasVm },
  }), "utf8");
  console.log(`  报告已写入 ${JSON_OUT}`);
}

console.log(`\n${failures.length ? "⛔" : "✅"} parity ${failures.length ? `未通过（${failures.length} 项）` : "通过"}`);
process.exit(failures.length ? 1 : 0);
