/**
 * 闪购「推广」取数 —— v4 **混合通路**（2026-09-23 第七棒标定）。
 *   node src/fetch-taobao-promo.mjs [--account=quanyi|yifeng]
 *
 * ⭐ 按账号选通路（当日实测标定，两条路都有平台侧的数据矛盾，别随意统一）：
 *
 * 【品牌A quanyi → 页面驱动 eleAllSiteChain】
 *   纯 Node 调 BP（bizCode=eleChain 数据页）当日全空、与实际矛盾，且午后非页面原生调用被限流；
 *   唯一有真实数据的源 = 壳内「全站推广」页 `#/pc/Wholepromotion/`（doujin iframe，
 *   bizCode=**eleAllSiteChain**，页面原生请求）。做法：浏览器里开页面，Fetch.enable 响应阶段
 *   拦截页面自己的 USER_TOTAL；⭐ R15（2026-09-24）：品牌A**只取登录节点（o2o）本身**，
 *   不再切镜像子账号镜像子账号求和（镜像无投放）。
 *   switchshop（credentials:include，Set-Cookie 落进**浏览器** cookie store —— 纯 Node 切换对
 *   浏览器无效），再重新导航抓下一轮；遍历完切回登录节点。
 *   ⚠️ 该页 = **全站推广**（品牌A消耗主要就在这，与页面显示 76.97 一致）；斗金等其他形式未覆盖。
 *
 * 【品牌B yifeng → 纯 Node 斗金 BP（v2 通路，USER_DATE 全部形式）】
 *   品牌B在 Wholepromotion 页全 0（消耗在其他形式），但 eleChain USER_DATE（6 产品全集）实测
 *   出数（近7天 269.11）→ 保留纯 Node 通路。若哪天也被限流/清零，再迁页面驱动。
 *   ⭐ R19（2026-09-24）：另以登录节点身份调 MDA ② 族采集预计收入（incomeLogin），
 *   供看板现算品牌B闪购 ROI = 品牌B预计收入 ÷ 品牌B斗金推广消耗（与品牌A口径不同，见 R16）。
 *
 * 数据形状（实测标定）：
 *   · Wholepromotion USER_TOTAL 顶层**没有 cost 标量**（dim 为空串）；窗口汇总 = list 行求和。
 *   · list 行按 `time` 分流：区间行 time=YYYY-MM-DD（逐日）；今日行 time="0".."23"（分时，
 *     另有 bizDate）。qzGmv（全站交易额）在顶层。
 *   · USER_DATE（eleChain）行 = 日期×门店×产品，按 bizDate 聚合 = 逐日；支持 T+0 查今天。
 *
 * ⚠️ cookie：MTOP 套（nr.ele.me，节点发现）；纯 Node BP 还需 .ele.me 父域套（品牌B分支）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCookieSmart, loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall, ensureMtopToken } from "./lib/mtop.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";
import { connectToPage } from "./lib/cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acct = resolveAccount(process.argv);
const STEM = acct.key === "quanyi" ? "taobao" : `taobao-${acct.key}`;
const PORT = acct.port; // 调试浏览器端口（9222 品牌A Chrome / 9223 品牌B Edge）
const OUT = dataPath(acct, "taobao-promo");

/** ⭐ 通路开关（见头注释）：品牌A页面驱动；品牌B纯 Node。 */
const PAGE_DRIVEN = acct.key === "quanyi";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";
const SHELL_URL = "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next";
const WHOLE_PROMO_URL = "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next#/pc/Wholepromotion/";
const ymd = (offset = 0) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() + offset * 86400_000)).replace(/-/g, "");
const dash = (offset = 0) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() + offset * 86400_000));
const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const rnd = (v, d = 2) => (v === null || v === undefined ? null : Number((v).toFixed(d)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`账号 ${acct.label}（${acct.key}）  调试浏览器端口 ${PORT}  ${PAGE_DRIVEN ? "v4 页面驱动（Wholepromotion / eleAllSiteChain）" : "v4 纯 Node 斗金 BP（USER_DATE 全部形式）"}`);

// ════════ 公共：MTOP cookie + 节点发现（两条通路都用）════════
let { cookies: mtCookies } = await loadCookieSmart({ stem: STEM, port: PORT, host: "nr.ele.me", required: ["WMSTOKEN"] });
if (!mtCookies._m_h5_tk) {
  // 网关引导（ensureMtopToken 失败时**返回原对象不抛错**，所以要自己检查结果）
  const boot = await ensureMtopToken(mtCookies, { host: "mtop.ele.me", jsv: "2.5.8" });
  if (boot?._m_h5_tk) mtCookies = { ...mtCookies, ...boot };
}
if (!mtCookies._m_h5_tk) {
  // ⚠️ 调试浏览器刚重启时，profile 里的 _m_h5_tk（会话级 cookie）会丢、引导也可能拿不到
  //    → 用静态文件 cookie 兜底做节点发现（只读接口；令牌过期靠 mtopCall 的自愈重试）。
  console.log("[cookie] profile 缺 _m_h5_tk 且网关引导未拿到 → 用静态文件 cookie 兜底");
  try {
    const header = loadCookieHeader(STEM);
    const { cookies: fileCookies } = parseCookieString(header);
    mtCookies = { ...mtCookies, ...fileCookies };
  } catch (e) {
    console.log(`[cookie] 静态文件兜底失败：${e.message}`);
  }
}

const call = async (api, data) => {
  const r = await mtopCall({ api, data, cookies: mtCookies, host: "nrshop.ele.me", jsv: "2.5.8" });
  if (!r.ok) return { error: r.ret?.[0] ?? r.ret };
  const dd = r.data?.data;
  return { data: dd?.dataItems ?? dd ?? null };
};

const loginResp = await call("mtop.ele.newretail.ebai.MultiLevelMtopService.getLoginnode", {});
if (loginResp.error) { console.error(`⛔ getLoginnode 失败：${loginResp.error}`); process.exit(2); }
const loginInfo = (loginResp.data?.loginNodeInfo) ?? {};
const loginNode = {
  name: String(loginInfo.nodeName ?? acct.label),
  nodeId: String(loginInfo.nodeId ?? ""),
  bizId: String(loginInfo.nodeBusinessId ?? loginInfo.supplierId ?? ""),
};
if (!loginNode.nodeId) { console.error("⛔ 登录节点没有 nodeId"); process.exit(2); }
const childNodes = [];
const childResp = await call("mtop.ele.newretail.ebai.MultiLevelMtopService.getChildNodeList", { nodeId: loginNode.nodeId }).catch(() => null);
const childRaw = childResp && !childResp.error ? (childResp.data?.childNodeList ?? []) : [];
for (const c of childRaw) {
  if (String(c.nodeType) === "2") childNodes.push({ name: String(c.nodeName), nodeId: String(c.nodeId) });
}
/**
 * ⭐⭐ R15（2026-09-24 经营者指示）：品牌A推广口径改为**只取「品牌Ao2o」子节点**，
 *   跳过「镜像子账号」镜像子账号（其本身无投放）。
 *   ⚠️ 实测教训（11:20-11:35 三连 75s 超时）：**登录节点「眼镜店」在 Wholepromotion 页不出数**
 *   （页面停在壳首页、0 个 eleAllSiteChain 请求）——数据挂在 o2o 子节点名下，必须 switchshop 过去。
 *   o2o 识别：子节点名含 "o2o"（实测 nodeName=「品牌A（o2o）」）；找不到则退回登录节点并如实告警。
 *   只影响页面驱动通路（品牌A）；品牌B本就是单账号，不受影响。
 */
const SELF_ONLY = PAGE_DRIVEN;
const o2oChild = childNodes.find((c) => /o2o/i.test(c.name))
  ?? childNodes.find((c) => c.nodeId === "17388905922760001")
  ?? null;
const multiNode = false; // R15：任何情况都不再跑多节点循环（求和改为最多单节点）
const targets = SELF_ONLY
  ? (o2oChild
      ? [o2oChild]
      : (() => { console.log("⚠️ R15：子节点里没找到 o2o 节点，退回登录节点（可能出不了数）"); return [{ name: loginNode.name || acct.label, nodeId: loginNode.nodeId }]; })())
  : (multiNode ? childNodes : [{ name: loginNode.name || acct.label, nodeId: loginNode.nodeId }]);
console.log(SELF_ONLY
  ? `⓪ R15 口径：只抓「${targets[0].name}」（nodeId ${targets[0].nodeId}）—— 镜像子账号不再抓取`
  : multiNode
    ? `⓪ 检测到 ${childNodes.length} 个子账号：${childNodes.map((c) => c.name).join(" + ")}`
    : `⓪ 单节点账号（${targets[0].name}）`);

const today = dash(0), yest = dash(-1);

// ════════ 共享：登录节点视角预计收入（MDA ② 族）—— 闪购 ROI 分子（R16/R19）════════
// ⭐ 两品牌的闪购 ROI 口径**不同**（经营者 2026-09-24 强调必须区分）：
//   · 品牌A ROI = 「眼镜店」总账号预计收入 ÷ 「品牌A（o2o）」全站推广消耗（R16）；
//   · 品牌B ROI = 「品牌B」预计收入 ÷ 「品牌B」斗金推广消耗（R19）。
//   分子取法相同：以**登录节点**身份调 MDA ② 族（今日=homepage 实时；昨日/近7/近30=biz.getMasterData；
//   逐日 30 天=biz.getTrendChartData；今日/昨日分时=homepage.getCustomerHourTrendChartData）。
//   品牌A页面驱动通路的内存 cookie 从未被 switchshop 污染（它只动浏览器 cookie store）→ 天然登录节点视角；
//   品牌B纯 Node 通路全程不 switchshop（multiNode=false）→ 登录节点 = 品牌B本身。
const collectIncomeLogin = async (sourceLabel) => {
  const y8 = (d) => String(d).replace(/-/g, "");
  const bizWin = async (s, e) => {
    // ⚠️ 日期格式必须用 YYYYMMDD（无横线）——与 fetch-taobao-mda.mjs 完全一致。
    //   实测带横线格式下 biz.getMasterData 返回异常值（昨日 79.4 vs 逐日曲线 2570.02）。
    const r = await call("mtop.nr.mda.portal.biz.getMasterData", { datePeriodTypeCode: "day", startDate: y8(s), endDate: y8(e) });
    return r.error ? { error: r.error } : { expectIncome: num(r.data?.expect_income?.currValue) ?? null };
  };
  const home = await call("mtop.nr.mda.portal.homepage.getCustomerHourMasterData", { compareStartDate: yest, compareEndDate: yest });
  const trend = await call("mtop.nr.mda.portal.biz.getTrendChartData", {
    indexCodes: JSON.stringify(["expect_income"]), datePeriodTypeCode: "day", startDate: ymd(-30), endDate: ymd(0),
  }).catch(() => null);
  const hourT = await call("mtop.nr.mda.portal.homepage.getCustomerHourTrendChartData", {
    indexCode: "expect_income", indexCodes: JSON.stringify(["expect_income"]), compareStartDate: yest, compareEndDate: yest,
  }).catch(() => null);
  const pickHours = (items, suffix) => (Array.isArray(items) ? items : [])
    .filter((x) => String(x.type ?? "").includes(suffix))
    .map((x) => ({ hour: Number(x.hour), income: num(x.value) ?? 0 }))
    .filter((x) => Number.isFinite(x.hour))
    .sort((a, b) => a.hour - b.hour);
  const dashed = (s) => (/^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : String(s));
  return {
    source: sourceLabel,
    loginNodeName: loginNode.name,
    loginNodeId: loginNode.nodeId,
    windows: {
      today: home.error ? { error: home.error } : { expectIncome: num(home.data?.expect_income?.currValue) ?? null },
      yesterday: await bizWin(yest, yest),
      d7: await bizWin(ymd(-7), ymd(-1)),
      d30: await bizWin(ymd(-30), ymd(-1)),
    },
    daily: (Array.isArray(trend?.data) ? trend.data : [])
      .filter((x) => !String(x.type ?? "").includes("上一期"))
      .map((x) => ({ date: dashed(x.day), income: num(x.value) ?? 0 }))
      .filter((x) => x.date)
      .sort((a, b) => a.date.localeCompare(b.date)),
    hourly: {
      today: pickHours(hourT?.data, "当期值"),
      yesterday: pickHours(hourT?.data, "上一期值"),
    },
  };
};
const logIncomeLogin = (li) => {
  const w = li.windows;
  console.log(`④ 登录节点（${loginNode.name}）预计收入：今日 ${w.today.expectIncome ?? "—"} / 昨日 ${w.yesterday.expectIncome ?? "—"} / 近7天 ${w.d7.expectIncome ?? "—"} / 近30天 ${w.d30.expectIncome ?? "—"} 元 · 逐日 ${li.daily.length} 天 · 分时 ${li.hourly.today.length}+${li.hourly.yesterday.length} 段`);
};

// ═══════════════════════════════════════════════════════════════
// 通路 A：页面驱动（品牌A）—— Wholepromotion / eleAllSiteChain
// ═══════════════════════════════════════════════════════════════
if (PAGE_DRIVEN) {
  /** 解析 USER_TOTAL 响应：窗口汇总 = list 行求和（顶层无 cost 标量，实测标定）。 */
  const parseTotal = (params, body) => {
    const j = JSON.parse(body);
    const res = j.result ?? {};
    const hourly = [], dailyByDate = new Map();
    const total = { cost: 0, impression: 0, click: 0, orderNum: 0, orderGrossGmv1d: 0 };
    for (const row of res.list ?? []) {
      const t = String(row.time ?? "");
      const isDate = /^\d{4}-\d{2}-\d{2}$/.test(t);
      const isHour = !isDate && /^\d{1,2}$/.test(t);
      if (!isDate && !isHour) continue;
      for (const k of Object.keys(total)) total[k] += num(row[k]) ?? 0;
      if (isDate) {
        const cur = dailyByDate.get(t) ?? { date: t, cost: 0, impression: 0, click: 0, orderNum: 0, orderGrossGmv1d: 0 };
        cur.cost += num(row.cost) ?? 0; cur.impression += num(row.impression) ?? 0; cur.click += num(row.click) ?? 0;
        cur.orderNum += num(row.orderNum) ?? 0; cur.orderGrossGmv1d += num(row.orderGrossGmv1d) ?? 0;
        dailyByDate.set(t, cur);
      } else {
        hourly.push({ hour: Number(t), cost: num(row.cost) ?? 0, impression: num(row.impression) ?? 0, click: num(row.click) ?? 0 });
      }
    }
    for (const k of Object.keys(total)) total[k] = rnd(total[k]);
    total.qzGmv = num(res.qzGmv) ?? null;
    total.roi = total.cost > 0 && total.orderGrossGmv1d > 0 ? rnd(total.orderGrossGmv1d / total.cost) : null;
    const daily = [...dailyByDate.values()]
      .map((x) => ({ ...x, cost: rnd(x.cost), orderGrossGmv1d: rnd(x.orderGrossGmv1d), roi: x.cost > 0 && x.orderGrossGmv1d > 0 ? rnd(x.orderGrossGmv1d / x.cost) : null }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { params, success: j.success !== false, total, hourly: hourly.sort((a, b) => a.hour - b.hour), daily };
  };

  /** 单节点抓取（页面内 switchshop → 导航 → 拦 USER_TOTAL → 点近7天/近30天 → 余额/计划）。 */
  const captureNode = async (node, { needSwitch }) => {
    const cdp = await connectToPage(PORT, { freshTab: "auto" });
    const captured = [];
    let chained = Promise.resolve();
    cdp.on("Fetch.requestPaused", (e) => {
      chained = chained.then(async () => {
        try {
          const url = e.request?.url ?? "";
          const isBp = /call_one_bp_eb/.test(url);
          const isBal = /IGwBalanceService/.test(url);
          if (isBp || isBal) {
            let body = null;
            try {
              const resp = await cdp.send("Fetch.getResponseBody", { requestId: e.requestId });
              body = resp?.base64Encoded ? Buffer.from(resp.body, "base64").toString("utf8") : (resp?.body ?? null);
            } catch { /* 留空 */ }
            if (body != null) {
              let params = null, envId = null, bizToken = null, bizCode = null;
              try {
                const post = JSON.parse(e.request?.postData ?? "{}");
                params = post.params?.[1] ?? null;
                envId = post.id ?? null;
                bizToken = post.biz_token ?? null;
                bizCode = post.params?.[0]?.bizCode ?? null;
              } catch { /* postData 缺失时只留 body */ }
              const kind = isBal ? "balance"
                : /findTotalReport/.test(url) ? "total"
                : /findPage/.test(url) ? "plans" : null;
              if (kind) captured.push({ kind, url, params, body, bizCode, id: envId, bizToken });
            }
          }
        } finally {
          try { await cdp.send("Fetch.continueRequest", { requestId: e.requestId }); } catch { /* 已结束 */ }
        }
      });
    });
    await cdp.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*call_one_bp_eb*", requestStage: "Response" },
        { urlPattern: "*IGwBalanceService*", requestStage: "Response" },
      ],
    }).catch(() => {});
    await cdp.send("Page.enable").catch(() => {});
    await cdp.send("Runtime.enable").catch(() => {});

    /** doujin iframe 上下文求值（每次现查 frameId + 隔离世界） */
    const evalInIframe = async (expression, { timeoutMs = 20_000 } = {}) => {
      const tree = await cdp.send("Page.getFrameTree").catch(() => null);
      const find = (f) => (!f ? null : /doujin-isv-manage/.test(f.frame?.url ?? "") ? f.frame : (f.childFrames ?? []).map(find).find(Boolean) ?? null);
      const frame = find(tree?.frameTree);
      if (!frame) return "noframe";
      const world = await cdp.send("Page.createIsolatedWorld", { frameId: frame.id }).catch(() => null);
      if (!world) return "noworld";
      const r = await cdp.send("Runtime.evaluate", {
        expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true,
      }, { timeoutMs }).catch((e) => ({ result: { value: "err:" + e.message } }));
      return r.result?.value;
    };
    const clickTab = async (label) => evalInIframe(`(() => {
      const els = [...document.querySelectorAll('button, span, div, a, li, [class*="tab"]')];
      const hit = els.filter(el => el.children.length === 0 && (el.textContent || '').trim() === ${JSON.stringify(label)});
      if (!hit.length) return 'notfound';
      let t = hit[hit.length - 1];
      while (t.parentElement && t.parentElement.textContent.trim() === t.textContent.trim()) t = t.parentElement;
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'clicked';
    })()`);

    /** 页面上下文（壳 origin）里调 switchshop —— Set-Cookie 落进浏览器 cookie store */
    const switchInPage = async (node2) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          try {
            const r = await fetch('https://nracc.ele.me/bwm_newretail.recrm_merchant/manager/switchshop', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ switchShopName: ${JSON.stringify(node2.name)}, switchNodeId: ${JSON.stringify(node2.nodeId)} }),
            });
            return await r.json();
          } catch (e) { return { result: false, errorMessage: String(e && e.message) }; }
        })()`,
        returnByValue: true, awaitPromise: true,
      }, { timeoutMs: 20_000 }).catch((e) => ({ result: { value: { result: false, errorMessage: e.message } } }));
      const v = r.result?.value;
      return v === true || v?.result === true ? true : v;
    };

    const waitForTotal = async (pred, timeoutMs) => {
      const dl = Date.now() + timeoutMs;
      while (Date.now() < dl) {
        const hit = [...captured].reverse().find((c) => c.kind === "total" && !c._used && pred(c));
        if (hit) { hit._used = true; return hit; }
        await sleep(400);
      }
      return null;
    };

    const out = { name: node.name, nodeId: node.nodeId, chainId: null, balance: null, windows: {}, hourly: [], dailyWins: null, plans: null, switched: false, error: null };
    try {
      // ① about:blank → 壳（确保真实重载；同 URL 导航可能被当作同文档跳转而不发请求）
      await cdp.send("Page.navigate", { url: "about:blank" }).catch(() => {});
      await sleep(1200);
      await cdp.send("Page.navigate", { url: SHELL_URL }).catch(() => {});
      await sleep(6000);

      // ② 多供应商：页面内切换（先切再进推广页，让 iframe 用新会话加载）
      if (needSwitch) {
        const sw = await switchInPage(node);
        if (sw !== true) { out.error = `页面内 switchshop 失败：${JSON.stringify(sw)?.slice(0, 120)}`; return out; }
        out.switched = true;
        await sleep(2000);
      }

      // ③ 导航 Wholepromotion（about:blank 中转确保真实重载）
      await cdp.send("Page.navigate", { url: "about:blank" }).catch(() => {});
      await sleep(1200);
      await cdp.send("Page.navigate", { url: WHOLE_PROMO_URL }).catch(() => {});
      const todayCap = await waitForTotal((c) => c.params?.reportTypeEnum === "USER_TOTAL" && c.params?.reportStartDate === today && c.params?.reportEndDate === today, 75_000);
      if (!todayCap) { out.error = "等今日 USER_TOTAL 超时（75s）—— 页面未出数（登录态/改版?）"; return out; }
      out.chainId = todayCap.id ?? null;

      // ④ 近7天 / 近30天：点标签 → 等区间 USER_TOTAL（优先匹配期望日期，兜底任意未用区间）
      for (const [label, key, startExp] of [["近7天", "d7", dash(-7)], ["近30天", "d30", dash(-30)]]) {
        let cap = null;
        for (let i = 0; i < 3 && !cap; i++) {
          const st = await clickTab(label).catch(() => "err");
          if (st === "clicked") {
            cap = await waitForTotal((c) => c.params?.reportTypeEnum === "USER_TOTAL"
              && c.params?.reportStartDate !== c.params?.reportEndDate
              && c.params?.reportStartDate === startExp, 14_000)
              ?? await waitForTotal((c) => c.params?.reportTypeEnum === "USER_TOTAL"
                && c.params?.reportStartDate !== c.params?.reportEndDate, 8_000);
          } else await sleep(3000);
        }
        if (cap) {
          const t = parseTotal(cap.params, cap.body);
          out.windows[key] = { start: cap.params.reportStartDate, end: cap.params.reportEndDate, ...t.total };
          // ⚠️ d7 与 d30 的逐日行有 7 天重叠 —— 分开存，装配时优先 d30（合并会把重叠天算双倍）
          out.dailyWins = out.dailyWins ?? {};
          out.dailyWins[key] = t.daily;
        } else {
          out.windows[key] = null;
        }
      }

      // ⑤ 今日（窗口 = 分时行求和）
      const t0 = parseTotal(todayCap.params, todayCap.body);
      out.windows.today = { start: today, end: today, ...t0.total };
      out.hourly = t0.hourly;

      // ⑥ 余额：页面自己发的优先；没有就用拦截到的信封在 doujin iframe 现调（agw 不限流）
      const balCap = captured.find((c) => c.kind === "balance");
      if (balCap) {
        try {
          const j = JSON.parse(balCap.body);
          const bal = num(j?.result?.detail?.balance);
          if (bal != null) out.balance = rnd(bal / 100); // ⚠️ 分 → 元
        } catch { /* fallthrough */ }
      }
      if (out.balance == null && out.chainId) {
        const balRaw = await evalInIframe(`(async () => {
          try {
            const r = await fetch('https://agw.ele.me/gw/h5api/alsc-ad-account.IGwBalanceService.findBalanceInfo?source=NR_EBAI&h=doujin-isv-manage.faas.ele.me', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'current-shop-id': String(${JSON.stringify(out.chainId)}), 'ksid': ${JSON.stringify(todayCap.bizToken ?? "")} },
              body: JSON.stringify({ params: [{}] }),
            });
            return await r.text();
          } catch (e) { return 'err:' + e.message; }
        })()`, { timeoutMs: 25_000 });
        try {
          const j = JSON.parse(balRaw);
          const bal = num(j?.result?.detail?.balance);
          if (bal != null) out.balance = rnd(bal / 100);
        } catch { /* 留空 */ }
      }

      // ⑦ 计划列表（页面自己的 findPage）
      const planCap = [...captured].reverse().find((c) => c.kind === "plans");
      if (planCap) {
        try {
          const j = JSON.parse(planCap.body);
          const list = Array.isArray(j.result) ? j.result : (j.result?.list ?? []);
          out.plans = {
            totalCount: num(j.totalCount) ?? list.length,
            list: list.slice(0, 20).map((p) => ({
              id: p.id, title: p.title, state: p.state, deliveryState: p.deliveryState,
              budget: num(p.budget), longTerm: !!p.longTerm, startTimeStr: p.startTimeStr, endTimeStr: p.endTimeStr,
            })),
          };
        } catch { /* 留空 */ }
      }
    } catch (err) {
      out.error = String(err?.message ?? err).slice(0, 200);
    } finally {
      await cdp.close().catch(() => {});
    }
    return out;
  };

  // ── 逐节点抓取 ──
  const perNode = [];
  for (let i = 0; i < targets.length; i++) {
    const node = targets[i];
    console.log(`→ [${i + 1}/${targets.length}] 抓取「${node.name}」${node.nodeId !== loginNode.nodeId ? "（页面内切换供应商）" : ""}`);
    // ⭐ R15：needSwitch 不再绑 multiNode —— 只要目标节点不是登录节点就要 switchshop 过去
    const rec = await captureNode(node, { needSwitch: node.nodeId !== loginNode.nodeId });
    perNode.push(rec);
    if (rec.error) console.log(`   ⚠️ ${rec.error}`);
    else {
      const w = rec.windows;
      console.log(`   今日 ${w.today?.cost ?? "—"} 元 · 近7天 ${w.d7?.cost ?? "—"} 元 · 近30天 ${w.d30?.cost ?? "—"} 元 · 余额 ${rec.balance ?? "—"} 元 · 分时 ${rec.hourly.length} 段 · 逐日 ${(rec.dailyWins?.d30 ?? rec.dailyWins?.d7 ?? []).length} 天 · 计划 ${rec.plans?.totalCount ?? "—"}`);
    }
  }

  // ── 抓取后切回登录节点（恢复浏览器会话，别挤掉网页端）──
  // ⭐ R15：判定条件改为「目标节点不是登录节点」（原来绑 multiNode，单节点切换路径漏掉切回）
  const didSwitchAway = targets.some((n) => n.nodeId !== loginNode.nodeId);
  if (didSwitchAway) {
    try {
      const cdp = await connectToPage(PORT, { freshTab: "auto" });
      await cdp.send("Page.navigate", { url: "about:blank" }).catch(() => {});
      await sleep(1200);
      await cdp.send("Page.navigate", { url: SHELL_URL }).catch(() => {});
      await sleep(5000);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          try {
            const r = await fetch('https://nracc.ele.me/bwm_newretail.recrm_merchant/manager/switchshop', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ switchShopName: ${JSON.stringify(loginNode.name)}, switchNodeId: ${JSON.stringify(loginNode.nodeId)} }),
            });
            return await r.json();
          } catch (e) { return { result: false }; }
        })()`,
        returnByValue: true, awaitPromise: true,
      }, { timeoutMs: 20_000 }).catch(() => null);
      const ok = r?.result?.value?.result === true || r?.result?.value === true;
      console.log(ok ? `↩ 已在浏览器里切回登录节点（${loginNode.name}）` : `⚠️ 切回登录节点未确认（请留意网页端当前供应商）`);
      await cdp.close().catch(() => {});
    } catch (e) {
      console.log(`⚠️ 切回登录节点失败：${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  // ── 装配（多节点求和）──
  const okNodes = perNode.filter((n) => !n.error);
  const mergeTotals = (key) => {
    const parts = okNodes.map((n) => n.windows[key]).filter(Boolean);
    if (!parts.length) return null;
    const sum = (f) => parts.reduce((a, w) => a + (num(w[f]) ?? 0), 0);
    const cost = sum("cost"), gmv = sum("orderGrossGmv1d"), qz = sum("qzGmv");
    return {
      start: parts[0].start, end: parts[0].end,
      cost: rnd(cost), impression: sum("impression"), click: sum("click"),
      orderNum: sum("orderNum"), orderGrossGmv1d: rnd(gmv),
      roi: cost > 0 && gmv > 0 ? rnd(gmv / cost) : null,
      qzGmv: rnd(qz),
      promoShare: cost > 0 && qz > 0 ? rnd((cost / qz) * 100) : null,
      nodes: parts.length,
    };
  };
  const windows = { today: mergeTotals("today"), d7: mergeTotals("d7"), d30: mergeTotals("d30") };

  const dayMap = new Map();
  for (const n of okNodes) {
    // ⚠️ 优先 d30 的逐日行；d30 缺失才退 d7（两者重叠 7 天，合并会双倍）
    const rows = n.dailyWins?.d30?.length ? n.dailyWins.d30 : (n.dailyWins?.d7 ?? []);
    for (const d of rows) {
      const cur = dayMap.get(d.date) ?? { date: d.date, cost: 0, impression: 0, click: 0, orderNum: 0, orderGrossGmv1d: 0 };
      cur.cost += d.cost ?? 0; cur.impression += d.impression ?? 0; cur.click += d.click ?? 0;
      cur.orderNum += d.orderNum ?? 0; cur.orderGrossGmv1d += d.orderGrossGmv1d ?? 0;
      dayMap.set(d.date, cur);
    }
  }
  const dailySeries = dayMap.size
    ? [...dayMap.values()]
        .map((x) => ({ ...x, cost: rnd(x.cost), orderGrossGmv1d: rnd(x.orderGrossGmv1d), roi: x.cost > 0 && x.orderGrossGmv1d > 0 ? rnd(x.orderGrossGmv1d / x.cost) : null }))
        .sort((a, b) => a.date.localeCompare(b.date))
    : null;

  const hourMap = new Map();
  for (const n of okNodes) {
    for (const h of n.hourly) {
      const cur = hourMap.get(h.hour) ?? { hour: h.hour, cost: 0, impression: 0, click: 0 };
      cur.cost += h.cost ?? 0; cur.impression += h.impression ?? 0; cur.click += h.click ?? 0;
      hourMap.set(h.hour, cur);
    }
  }
  const todayHourly = hourMap.size
    ? { date: today, cost: windows.today?.cost ?? null, hourly: [...hourMap.values()].map((x) => ({ ...x, cost: rnd(x.cost) })).sort((a, b) => a.hour - b.hour) }
    : null;

  const balanceSum = okNodes.reduce((a, n) => a + (n.balance ?? 0), 0);
  const hasBalance = okNodes.some((n) => n.balance != null);
  const planList = [];
  const planParts = okNodes.filter((n) => n.plans);
  const planTotal = planParts.reduce((a, n) => a + (n.plans.totalCount ?? 0), 0);
  for (const n of planParts) planList.push(...(n.plans.list ?? []));

  console.log(`\n③ 汇总（${multiNode ? `${targets.length} 供应商求和` : "单账号"}）：`);
  console.log(`   今日 ${windows.today?.cost ?? "—"} 元 / 近7天 ${windows.d7?.cost ?? "—"} 元 / 近30天 ${windows.d30?.cost ?? "—"} 元`);
  console.log(`   逐日序列：${dailySeries ? `${dailySeries.length} 天（${dailySeries[0].date} ~ ${dailySeries[dailySeries.length - 1].date}）` : "⚠️ 区间响应无逐日行，仅窗口汇总"}`);
  console.log(`   余额 ${hasBalance ? rnd(balanceSum) : "—"} 元 · 分时 ${todayHourly ? `${todayHourly.hourly.length} 段` : "—"} · 计划 ${planList.length || planTotal ? planTotal : "—"}`);

  const anyOk = windows.today != null || windows.d7 != null || windows.d30 != null || hasBalance;
  if (!anyOk) {
    const errs = perNode.map((n) => `${n.name}:${n.error ?? "无数据"}`).join("；");
    console.error(`\n⛔ 页面驱动抓取全部失败，**不覆盖** ${OUT}`);
    console.error(`   各节点：${errs}`);
    console.error(`   检查：调试浏览器（端口 ${PORT}）是否开着、登录态是否有效（打开 ${WHOLE_PROMO_URL} 人工看一眼）。`);
    process.exit(2);
  }

  // ── ⭐⭐ R16（2026-09-24 经营者指示）：登录节点（「眼镜店」总账号）视角的预计收入 ──
  //   用途：闪购 ROI 分子。分母 = 上面的 windows/daily/hourly（o2o 全站推广消耗）。
  //   R19 起取法抽成 collectIncomeLogin 与品牌B共用（见函数上方口径注释）。
  let loginIncome = null;
  if (SELF_ONLY) {
    try {
      loginIncome = await collectIncomeLogin("MDA ② 族 @ 登录节点（眼镜店总账号视角，不 switchshop）");
      logIncomeLogin(loginIncome);
    } catch (e) {
      console.log(`⚠️ 登录节点预计收入采集失败：${String(e?.message ?? e).slice(0, 140)}`);
      loginIncome = { error: String(e?.message ?? e).slice(0, 140) };
    }
  }

  const primary = okNodes[0];
  const payload = {
    fetchedAt: new Date().toISOString(),
    account: { key: acct.key, label: acct.label },
    source: "taobao-shangou-wholepromo-page",
    family: "页面驱动（Wholepromotion 壳内全站推广页，eleAllSiteChain；Fetch.enable 响应拦截页面原生请求）",
    caliber:
      "闪购推广（页面驱动）。金额单位=**元**；balance 由分转元。" +
      "数据源=壳内「全站推广」页 `#/pc/Wholepromotion/`（bizCode=eleAllSiteChain，页面原生请求响应拦截；" +
      "纯 Node 直调 BP 网关 eleChain 数据页对品牌A当日全空且被限流，已弃用）。" +
      "**该页口径=全站推广**（品牌A消耗主要在此；斗金等其他形式未覆盖）。" +
      (SELF_ONLY
        ? "⭐ R15（2026-09-24）：品牌A = **品牌Ao2o 供应商（单账号）**，镜像子账号镜像子账号不再求和（其本身无投放）。"
        : multiNode
          ? "品牌A = 品牌Ao2o 供应商 + 镜像子账号供应商 两账号求和（页面内 switchshop 分账号抓取后合并）。"
          : "单账号。") +
      "窗口汇总=页面 USER_TOTAL 的 list 行求和（顶层无汇总标量）；今日 T+0；近7天/近30天到昨天。" +
      "qzGmv=全站交易额；promoShare=消耗÷全站交易额×100。ROI=成交÷消耗（仅两者均>0 时有值）。" +
      "⚠️ 与美团推广口径不同，两平台**不可相加**。",
    merchantName: primary?.name ?? loginNode.name,
    chainId: primary?.chainId ?? null,
    balance: hasBalance ? rnd(balanceSum) : null,
    perNode: perNode.map((n) => ({
      name: n.name, nodeId: n.nodeId, chainId: n.chainId, balance: n.balance,
      switched: n.switched ?? false,
      todayCost: n.windows.today?.cost ?? null, d7Cost: n.windows.d7?.cost ?? null, d30Cost: n.windows.d30?.cost ?? null,
      dailyDays: (n.dailyWins?.d30 ?? n.dailyWins?.d7 ?? []).length, error: n.error ?? null,
    })),
    windows,
    daily30: dailySeries ? { start: dailySeries[0].date, end: dailySeries[dailySeries.length - 1].date, daily: dailySeries } : { error: "页面区间响应无逐日行（窗口汇总不受影响）" },
    todayRealtime: windows.today
      ? { date: today, daily: [{ date: today, cost: windows.today.cost, impression: windows.today.impression, click: windows.today.click, orderNum: windows.today.orderNum, orderGrossGmv1d: windows.today.orderGrossGmv1d, roi: windows.today.roi }] }
      : { error: "各节点今日均无数据" },
    todayHourly: todayHourly ?? { error: "各节点今日均无分时行" },
    plans: planList.length || planTotal ? { totalCount: planTotal, list: planList.slice(0, 20) } : { error: "页面未发出计划列表请求（findPage）" },
    ...(loginIncome ? { incomeLogin: loginIncome } : {}),
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\n落盘 ${OUT}`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
// 通路 B：纯 Node 斗金 BP（品牌B）—— USER_DATE 全部形式（v2 通路，实测出数）
// ═══════════════════════════════════════════════════════════════

// ── BP cookie（.ele.me 父域，必须来自浏览器 profile）──
const bp0 = await loadCookieSmart({ stem: STEM, port: PORT, host: "ele.me", required: [] });
console.log(`[cookie] BP 套（${bp0.source}）${bp0.count} 项（host=ele.me）`);
if (bp0.source === "file") {
  console.error("⛔ BP 套 cookie 只能来自浏览器 profile（.ele.me 父域，静态文件里没有/已过期）。");
  console.error("   请先在调试浏览器里开过闪购后台（Shell 会写入 .ele.me 域 cookie），再跑本脚本。");
  process.exit(2);
}
const nracc0 = await loadCookieSmart({ stem: STEM, port: PORT, host: "nracc.ele.me", required: [] }).catch(() => null);
let switchCookie = [mtCookies.header ?? null, bp0.header ?? null, nracc0?.header ?? null].filter(Boolean).join("; ");
let bpHeader = bp0.header ?? "";

const rotated = {};
const applySetCookies = (setc) => {
  const merge = (header) => {
    const map = new Map();
    for (const p of String(header ?? "").split("; ").filter(Boolean)) { const i = p.indexOf("="); if (i > 0) map.set(p.slice(0, i), p); }
    for (const raw of setc) { const [pair] = raw.split(";"); const i = pair.indexOf("="); if (i > 0) map.set(pair.slice(0, i), pair); }
    return [...map.values()];
  };
  const all = merge(switchCookie);
  switchCookie = all.join("; ");
  const merged = Object.fromEntries(all.map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
  mtCookies = { ...merged, WMSTOKEN: merged.WMSTOKEN ?? mtCookies.WMSTOKEN };
  if (merged._m_h5_tk) rotated._m_h5_tk = merged._m_h5_tk;
  bpHeader = merge(bpHeader).join("; ");
};

let curShard = null;
const switchTo = async (node) => {
  const attempt = async (shard) => {
    const r = await fetch("https://nracc.ele.me/bwm_newretail.recrm_merchant/manager/switchshop", {
      method: "POST",
      headers: {
        "Accept": "application/json", "Content-Type": "application/json",
        "Origin": "https://nr.ele.me", "Referer": "https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next",
        "User-Agent": UA, ...(shard ? { "X-Shard": `nrshopid=${shard}` } : {}),
        Cookie: switchCookie,
      },
      body: JSON.stringify({ switchShopName: node.name, switchNodeId: node.nodeId }),
    });
    const setc = r.headers.getSetCookie?.() ?? [];
    const j = await r.json().catch(() => null);
    return { ok: !!j?.result, msg: j?.errorMessage ?? r.status, setc };
  };
  let out = await attempt(curShard);
  if (!out.ok) out = await attempt(node.bizId ?? node.nodeId);
  if (out.ok) {
    applySetCookies(out.setc);
    curShard = node.bizId ?? node.nodeId;
  }
  return out;
};

const bpHeaders = () => ({
  "Content-Type": "application/json",
  "Origin": "https://doujin-isv-manage.faas.ele.me",
  "Referer": "https://doujin-isv-manage.faas.ele.me/",
  "User-Agent": UA,
  "Cookie": bpHeader,
});

const shopToken = async () => {
  const mt = await mtopCall({
    api: "mtop.ele.newretail.ebai.accountreadmtopservice.getshopuserinfo",
    data: {}, cookies: { ...mtCookies, ...rotated }, host: "nrshop.ele.me", jsv: "2.5.8",
  });
  if (!mt.ok) return { error: mt.ret?.[0] ?? mt.ret };
  const info = mt.data?.data ?? {};
  return { eleSoaToken: info.eleSoaToken ?? "", merchantName: info.loginMerchantName ?? "" };
};

const chainIdOf = async () => {
  const r2 = await fetch(
    "https://agw.ele.me/gw/h5api/alsc-ad-account.IGwShopInfoService.findCurrentShopId?source=NR_EBAI&h=doujin-isv-manage.faas.ele.me",
    { method: "POST", headers: bpHeaders(), body: JSON.stringify({ params: [{}] }) },
  );
  const j2 = await r2.json().catch(() => null);
  return { chainId: j2?.result, raw: j2 };
};

const callOneBp = (token, chainId, service, method, bizCode, bizParams) => {
  const body = {
    bizType: "xiaoducrm_supplier",
    biz_token: token,
    biz_type: "xiaoducrm_supplier",
    id: chainId,
    ksid: token,
    method,
    thirdToken: "", // 实测不校验
    params: [{ loginId: chainId, bizCode, isChain: true, nrRole: "supplier" }, bizParams],
    service,
    system: "eb",
    wmstoken: mtCookies.WMSTOKEN ?? "",
    wmuss: mtCookies.WMSTOKEN ?? "",
  };
  return fetch(`https://httpizza.ele.me/vas.gateway/one_route/call_one_bp_eb?m=${service}.${bizCode}.${method}`, {
    method: "POST", headers: bpHeaders(), body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => null);
};

const balanceInfo = async (token, chainId) => {
  const r = await fetch(
    "https://agw.ele.me/gw/h5api/alsc-ad-account.IGwBalanceService.findBalanceInfo?source=NR_EBAI&h=doujin-isv-manage.faas.ele.me",
    {
      method: "POST",
      headers: { ...bpHeaders(), "current-shop-id": String(chainId), ksid: token },
      body: JSON.stringify({ params: [{}] }),
    },
  )
    .then((r) => r.json())
    .catch(() => null);
  const bal = num(r?.result?.detail?.balance); // ⚠️ 分
  return bal === null ? null : rnd(bal / 100);
};

/** 全部形式 = 平台数据页 6 产品全集（productIdList 传空/不传都不是全部，必须显式传） */
const ALL_PRODUCTS = [102301117, 102301009, 102302011, 102301103, 102301107, 102301113];
const REALTIME_PRODUCTS = [102301117, 102301009]; // 平台实时口径仅含全站推广+斗金推广

const rowKeyFields = (cur, row) => {
  cur.cost += row.cost ?? 0;
  cur.impression += row.impression ?? 0;
  cur.click += row.click ?? 0;
  cur.orderNum += row.orderNum ?? 0;
  cur.orderGrossGmv1d += row.orderGrossGmv1d ?? 0;
  cur.realCost += row.realCost ?? 0;
};

const userDateDaily = async (token, chainId, start, end) => {
  const pageSize = 300;
  let rows = [];
  let totalCount = null;
  for (let pageNum = 1; pageNum <= 5; pageNum++) {
    const j = await callOneBp(token, chainId, "oneReportService", "findReportPage", "eleChain", {
      accountFlag: [1, 2], pageSize, pageNum,
      reportStartDate: start, reportEndDate: end, reportTypeEnum: "USER_DATE",
      shopIds: [], productIdList: ALL_PRODUCTS,
    });
    if (!j?.success) return { error: j?.errorMsg ?? j?.errorCode ?? "success=false" };
    rows = rows.concat(j.result ?? []);
    totalCount = num(j.totalCount) ?? rows.length;
    if (rows.length >= totalCount) break;
  }
  const byDay = new Map();
  for (const row of rows) {
    const d = String(row.bizDate ?? row.time ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const cur = byDay.get(d) ?? { date: d, cost: 0, impression: 0, click: 0, orderNum: 0, orderGrossGmv1d: 0, realCost: 0 };
    rowKeyFields(cur, row);
    byDay.set(d, cur);
  }
  const daily = [...byDay.values()]
    .map((x) => ({
      date: x.date,
      cost: rnd(x.cost), impression: x.impression, click: x.click,
      orderNum: x.orderNum, orderGrossGmv1d: rnd(x.orderGrossGmv1d),
      roi: x.cost > 0 ? rnd(x.orderGrossGmv1d / x.cost) : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!daily.length) return { error: "USER_DATE 0 行" };
  return { start, end, daily, rows: rows.length };
};

const sumWindow = (daily, from, to) => {
  const rows = daily.filter((x) => x.date >= from && x.date <= to);
  if (!rows.length) return null;
  const cost = rows.reduce((a, x) => a + (x.cost ?? 0), 0);
  const gmv = rows.reduce((a, x) => a + (x.orderGrossGmv1d ?? 0), 0);
  return {
    start: from, end: to, days: rows.length,
    cost: rnd(cost), impression: rows.reduce((a, x) => a + (x.impression ?? 0), 0),
    click: rows.reduce((a, x) => a + (x.click ?? 0), 0),
    orderNum: rows.reduce((a, x) => a + (x.orderNum ?? 0), 0),
    orderGrossGmv1d: rnd(gmv),
    roi: cost > 0 ? rnd(gmv / cost) : null,
  };
};

const diagToday = async (token, chainId) => {
  const yestD = dash(-1);
  const merged = new Map();
  let totalCost = 0, changedCost = null;
  for (const pid of REALTIME_PRODUCTS) {
    const j = await callOneBp(token, chainId, "oneReportService", "findTotalReport", "eleChain", {
      reportStartDate: today, reportEndDate: today, productIdList: [pid],
      compareDate: yestD, reportTypeEnum: "CHAIN_HOME_DATA_DIAGNOSE", showDetail: true, initialize: true,
    });
    if (!j?.success) continue;
    const res = j.result ?? {};
    totalCost += num(res.cost) ?? 0;
    if (changedCost === null && res.changedCost !== undefined) changedCost = num(res.changedCost);
    for (const row of res.list ?? []) {
      const h = row.hour ?? (row.time !== undefined && row.time !== null ? Number(row.time) : null);
      if (!Number.isFinite(h) || h < 0 || h > 23) continue;
      const cur = merged.get(h) ?? { hour: h, cost: 0, impression: 0, click: 0 };
      cur.cost += num(row.cost) ?? 0;
      cur.impression += num(row.impression) ?? 0;
      cur.click += num(row.click) ?? 0;
      merged.set(h, cur);
    }
  }
  const hourly = [...merged.values()]
    .map((x) => ({ hour: x.hour, cost: rnd(x.cost), impression: x.impression, click: x.click }))
    .sort((a, b) => a.hour - b.hour);
  if (!hourly.length && !totalCost) return { error: "诊断卡无数据" };
  return { date: today, cost: rnd(totalCost), changedCost, hourly };
};

const planPage = async (token, chainId) => {
  for (let i = 0; i < 2; i++) {
    const j = await callOneBp(token, chainId, "oneSolutionService", "findPage", "eleAllSiteChain", {
      pageNum: 1, pageSize: 20, state: null, entityName: null, fuzzySearch: null,
      reportQuery: { initialize: true, showDetail: false, reportEndDate: `${today} 23:59:59`, reportStartDate: `${today} 00:00:00`, reportTypeEnum: "campaign" },
      queryTag: { campaignRequired: true, adGroupRequired: true, adGroupLineReportRequired: false, reportRequired: true },
    });
    if (j?.success) {
      return {
        totalCount: num(j.totalCount) ?? (j.result ?? []).length,
        list: (j.result ?? []).slice(0, 20).map((p) => ({
          id: p.id, title: p.title, state: p.state, deliveryState: p.deliveryState,
          budget: num(p.budget), longTerm: !!p.longTerm, startTimeStr: p.startTimeStr, endTimeStr: p.endTimeStr,
        })),
      };
    }
    await new Promise((r) => setTimeout(r, 3000)); // 限流 → 3s 重试
  }
  return { error: "限流/失败（重试后仍失败）" };
};

// ── 逐节点取数（品牌B = 单账号不切换；保留 switchTo 以备多节点）──
const d7 = dash(-7), d30 = dash(-30);
const perNode = [];
let merchantName = "";

/** 遍历前的当前节点指纹（昨日窗口 成交/有效单）—— 结束后切回它 */
let originFp = null;
if (multiNode) {
  const ds = ymd(-1);
  const fp = await call("mtop.nr.mda.portal.biz.getMasterData", { datePeriodTypeCode: "day", startDate: ds, endDate: ds });
  const D = fp.data ?? {};
  originFp = `${D.original_amt?.currValue ?? "x"}/${D.valid_order_cnt?.currValue ?? "x"}`;
  console.log(`   原节点指纹（昨日 成交/有效单）：${originFp}`);
}

for (const node of targets) {
  const rec = { name: node.name, nodeId: node.nodeId, chainId: null, balance: null, error: null };
  perNode.push(rec);
  try {
    if (multiNode) {
      const sw = await switchTo(node);
      if (!sw.ok) { rec.error = `switchshop 失败：${sw.msg}`; console.log(`   ⚠️ 切换到「${node.name}」失败（${rec.error}），该节点数据缺失`); continue; }
      console.log(`→ 已切换到「${node.name}」`);
    }
    const t = await shopToken();
    if (!t.eleSoaToken) { rec.error = `getshopuserinfo 失败：${t.error ?? "无 eleSoaToken"}`; console.log(`   ⚠️ ${node.name}: ${rec.error}`); continue; }
    merchantName = t.merchantName || merchantName;
    const c = await chainIdOf();
    if (!c.chainId || typeof c.chainId !== "number") { rec.error = `findCurrentShopId 失败：${JSON.stringify(c.raw)?.slice(0, 150)}`; console.log(`   ⚠️ ${node.name}: ${rec.error}`); continue; }
    rec.chainId = c.chainId;

    rec.daily30 = await userDateDaily(t.eleSoaToken, c.chainId, d30, yest);
    rec.dailyToday = await userDateDaily(t.eleSoaToken, c.chainId, today, today);
    rec.diag = await diagToday(t.eleSoaToken, c.chainId);
    rec.balance = await balanceInfo(t.eleSoaToken, c.chainId);
    rec.plans = await planPage(t.eleSoaToken, c.chainId);

    const d7sum = (rec.daily30.daily ?? []).filter((x) => x.date >= d7).reduce((a, x) => a + (x.cost ?? 0), 0);
    console.log(`   ${node.name}（chainId=${c.chainId}）：近7天消耗 ${rnd(d7sum) ?? 0} 元 · 今日 ${rec.dailyToday.daily?.[0]?.cost ?? 0} 元 · 余额 ${rec.balance ?? "—"} 元 · 分时 ${rec.diag.hourly?.length ?? 0} 段${rec.daily30.error ? ` · 逐日⚠️${rec.daily30.error}` : ""}`);
  } catch (err) {
    rec.error = String(err?.message ?? err).slice(0, 200);
    console.log(`   ⚠️ ${node.name} 取数异常：${rec.error}`);
  }
}

if (multiNode) {
  for (const node of [...targets, loginNode]) {
    const sw = await switchTo({ ...node, bizId: node.bizId ?? node.nodeId });
    if (!sw.ok) continue;
    const ds = ymd(-1);
    const fp = await call("mtop.nr.mda.portal.biz.getMasterData", { datePeriodTypeCode: "day", startDate: ds, endDate: ds });
    const D = fp.data ?? {};
    const f = `${D.original_amt?.currValue ?? "x"}/${D.valid_order_cnt?.currValue ?? "x"}`;
    if (f === originFp) { console.log(`↩ 已切回原节点（${node.name}，指纹一致）`); break; }
  }
}

// ── ⭐⭐ R19（2026-09-24 经营者指示）：品牌B闪购 ROI 分子 = 品牌B预计收入 ──
//   ⚠️ 两品牌 ROI 口径**不同**，必须区分：品牌A = 眼镜店收入 ÷ o2o 全站推广消耗（R16）；
//   品牌B = **品牌B预计收入 ÷ 品牌B斗金推广消耗**。品牌B单账号、全程不 switchshop，
//   登录节点视角 = 品牌B本身；取法与品牌A共用 collectIncomeLogin。
let loginIncome = null;
try {
  loginIncome = await collectIncomeLogin("MDA ② 族 @ 登录节点（品牌B，单账号视角）");
  logIncomeLogin(loginIncome);
} catch (e) {
  console.log(`⚠️ 登录节点预计收入采集失败：${String(e?.message ?? e).slice(0, 140)}`);
  loginIncome = { error: String(e?.message ?? e).slice(0, 140) };
}

// ── 装配 ──
const okNodes = perNode.filter((n) => !n.error || n.daily30?.daily?.length || n.dailyToday?.daily?.length || n.diag?.hourly?.length || n.balance != null);
const dailyMap = new Map();
let todayRow = null;
const hourMap = new Map();
let diagCost = 0, diagChanged = null;
let balanceSum = 0, hasBalance = false;
const planList = [];
let planTotal = 0, planErr = null;

for (const n of perNode) {
  for (const d of n.daily30?.daily ?? []) {
    const cur = dailyMap.get(d.date) ?? { date: d.date, cost: 0, impression: 0, click: 0, orderNum: 0, orderGrossGmv1d: 0 };
    cur.cost += d.cost ?? 0; cur.impression += d.impression ?? 0; cur.click += d.click ?? 0;
    cur.orderNum += d.orderNum ?? 0; cur.orderGrossGmv1d += d.orderGrossGmv1d ?? 0;
    dailyMap.set(d.date, cur);
  }
  const td = n.dailyToday?.daily?.[0];
  if (td) {
    todayRow = todayRow ?? { date: td.date, cost: 0, impression: 0, click: 0, orderNum: 0, orderGrossGmv1d: 0 };
    todayRow.cost += td.cost ?? 0; todayRow.impression += td.impression ?? 0; todayRow.click += td.click ?? 0;
    todayRow.orderNum += td.orderNum ?? 0; todayRow.orderGrossGmv1d += td.orderGrossGmv1d ?? 0;
  }
  for (const h of n.diag?.hourly ?? []) {
    const cur = hourMap.get(h.hour) ?? { hour: h.hour, cost: 0, impression: 0, click: 0 };
    cur.cost += h.cost ?? 0; cur.impression += h.impression ?? 0; cur.click += h.click ?? 0;
    hourMap.set(h.hour, cur);
  }
  if (n.diag?.cost != null) diagCost += n.diag.cost;
  if (n.diag?.changedCost != null) diagChanged = (diagChanged ?? 0) + n.diag.changedCost;
  if (n.balance != null) { balanceSum += n.balance; hasBalance = true; }
  const pl = n.plans;
  if (pl && !pl.error) { planTotal += pl.totalCount ?? 0; planList.push(...(pl.list ?? [])); }
  else if (pl?.error) planErr = pl.error;
}
void planErr;
const daily30 = dailyMap.size
  ? [...dailyMap.values()]
      .map((x) => ({ ...x, cost: rnd(x.cost), orderGrossGmv1d: rnd(x.orderGrossGmv1d), roi: x.cost > 0 ? rnd(x.orderGrossGmv1d / x.cost) : null }))
      .sort((a, b) => a.date.localeCompare(b.date))
  : { error: "所有节点 USER_DATE 均无行" };
const todayHourly = hourMap.size
  ? { date: today, cost: rnd(diagCost), changedCost: diagChanged, hourly: [...hourMap.values()].map((x) => ({ ...x, cost: rnd(x.cost) })).sort((a, b) => a.hour - b.hour) }
  : { error: "所有节点诊断卡均无分时" };
if (todayRow) todayRow = { ...todayRow, cost: rnd(todayRow.cost), orderGrossGmv1d: rnd(todayRow.orderGrossGmv1d), roi: todayRow.cost > 0 ? rnd(todayRow.orderGrossGmv1d / todayRow.cost) : null };

const w7 = Array.isArray(daily30) ? sumWindow(daily30, d7, yest) : null;
const w30 = Array.isArray(daily30) ? sumWindow(daily30, d30, yest) : null;
console.log(`\n③ 汇总（${multiNode ? `${perNode.length} 供应商求和` : "单账号"}）：`);
console.log(`   近7天 消耗 ${w7 ? w7.cost : "0（窗口内无行）"} 元 / 曝光 ${w7?.impression ?? 0} / 点击 ${w7?.click ?? 0} / ROI ${w7?.roi ?? "—"}`);
console.log(`   近30天 消耗 ${w30 ? w30.cost : "0（窗口内无行）"} 元 / ${w30?.days ?? 0} 天`);
console.log(`④ 今日实时（USER_DATE T+0）：${todayRow ? `${todayRow.cost} 元 / 曝光 ${todayRow.impression}` : "无数据"}`);
console.log(`⑤ 今日分时（诊断卡 117+009）：${todayHourly.error ? `⚠️ ${todayHourly.error}` : `${todayHourly.hourly.length} 段 / ${todayHourly.cost} 元`}`);
console.log(`⑥ 推广账户余额：${hasBalance ? `${rnd(balanceSum)} 元` : "—"}`);
console.log(`⑦ 推广计划：${planList.length || planTotal ? `${planTotal} 个` : `⚠️ ${planErr ?? "无数据"}`}`);

const anyOk = Array.isArray(daily30) || !!todayRow || hourMap.size > 0 || hasBalance;
if (!anyOk) {
  const errs = perNode.map((n) => `${n.name}:${n.error ?? "无数据"}`).join("；");
  console.error(`\n⛔ 推广接口全部失败，**不覆盖** ${OUT}`);
  console.error(`   各节点：${errs}`);
  process.exit(2);
}

const primary = okNodes.find((n) => n.chainId != null) ?? perNode[0];
const payload = {
  fetchedAt: new Date().toISOString(),
  account: { key: acct.key, label: acct.label },
  source: "taobao-shangou-doujin-bp",
  family: "纯 Node 斗金 BP（httpizza call_one_bp_eb + agw h5api；品牌B在 Wholepromotion 页全 0，消耗在其他形式，故保留此通路）",
  caliber:
    "闪购推广（斗金 BP）。金额单位=**元**；balance 由分转元。" +
    "**口径=全部形式的推广消耗（经营者 2026-09-23 指示）**：" +
    `USER_DATE 取平台数据页 6 产品全集（${ALL_PRODUCTS.join("/")}）× 品牌资金+门店资金；` +
    (multiNode ? "多供应商 switchshop 分账号取数后按日合并。" : "品牌B = 品牌B账号（单账号）。") +
    "今日分时来自「数据诊断」卡（平台实时口径仅含全站推广+斗金推广），今日总额以 USER_DATE T+0 为准。" +
    "ROI=当日成交(orderGrossGmv1d)÷消耗（数据层保留；看板展示的 ROI=本看板现算 roiIncome，见 R19）。" +
    "⚠️ 与美团推广口径不同，两平台**不可相加**。",
  merchantName,
  chainId: primary?.chainId ?? null,
  balance: hasBalance ? rnd(balanceSum) : null,
  perNode: perNode.map((n) => ({
    name: n.name, nodeId: n.nodeId, chainId: n.chainId, balance: n.balance,
    dailyDays: Array.isArray(n.daily30?.daily) ? n.daily30.daily.length : 0,
    d7Cost: n.daily30?.daily ? rnd((n.daily30.daily ?? []).filter((x) => x.date >= d7).reduce((a, x) => a + (x.cost ?? 0), 0)) : null,
    todayCost: n.dailyToday?.daily?.[0]?.cost ?? null,
    error: n.error ?? null,
  })),
  products: ALL_PRODUCTS,
  daily30: Array.isArray(daily30) ? { start: d30, end: yest, daily: daily30 } : { error: daily30.error },
  todayRealtime: todayRow ? { date: today, daily: [todayRow] } : { error: "各节点今日均无行" },
  todayHourly,
  plans: planList.length || planTotal
    ? { totalCount: planTotal, list: planList.slice(0, 20) }
    : { error: planErr ?? "各节点均无计划数据" },
  ...(loginIncome ? { incomeLogin: loginIncome } : {}),
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
console.log(`\n落盘 ${OUT}`);
