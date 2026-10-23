/**
 * 美团营销平台取数（推广消耗 / ROI，支持 今日 / 昨日 / 7天 / 30天 / 逐日明细）
 *   node src/fetch-ka.mjs [--account=quanyi|yifeng] [--port=9222]
 *
 * 通路：CDP 页内请求（H5guard 已 hook fetch，签名自动附加）
 * 报表接口：POST /kepler/datacenter/api/ka/data/v2/history/{overview,list}
 * 参数：startDate / endDate（YYYYMMDD）+ 一堆 -1 表示「全部」
 *
 * ⚠️ 量纲：报表接口的金额是「分」，需 ÷100；
 *    而首页 /kepler/.../today/marketing 的金额是「元」。**同一平台两种量纲**。
 * ⚠️ 日期格式 YYYYMMDD（不带横线）—— 与美团医药订单接口的 YYYY-MM-DD 相反
 * ⚠️ 报表是 T+1：查「今日」恒为 0
 * ⚠️ 推广占比**不在这里算**：用户口径 = 推广消耗 ÷ **预计收入**（美团医药订单口径），
 *    而本文件只能拿到 ka 自己的 convertOrderAmount（转化口径，偏小）。
 *    下面打印的转化口径占比仅作参考，看板口径以「消耗 ÷ 预计收入」为准。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectToPage, pageFetchAll, setCookies, waitPageSettled } from "./lib/cdp.mjs";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = Number(arg("port", String(acct.port)));

const STEM = acct.key === "quanyi" ? "ka" : `ka-${acct.key}`;
const OUT = dataPath(acct, "ka");
const KA_DOMAIN = "ka.waimai.meituan.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 日期（东八区，绝不用 toISOString） */
const d = (offset = 0) => {
  const t = new Date(Date.now() + offset * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};
/** 报表的「昨日」是数据截止日；7日/30日窗口截止到昨日 */
const Y1 = d(-1);

const cdp = await connectToPage(PORT);
console.log(`账号 ${acct.label}（${acct.key}）  端口 ${PORT}`);
console.log("✅ 已连接调试浏览器");

// 注入 ka cookie。优先从 profile 读**活 cookie**（会自动续期），
// 没有 cookie 文件也不影响 —— 那就纯靠 profile 里的持久化登录态。
let COOKIE = null;
try {
  COOKIE = (await loadCookieSmart({
    stem: STEM,
    port: PORT,
    host: KA_DOMAIN,
    required: ["acctId"],
  })).header;
} catch {
  console.log("[cookie] 既无 cookie 文件、profile 也没读到，直接依赖 profile 登录态");
}
// ⭐ 2026-10-22 探测结论（§18）：**不再注入任何 cookie，纯靠 profile 登录态**。
// 原代码在这里 setCookies(cdp, COOKIE, [".meituan.com", KA_DOMAIN]) 注入父域，
// 违反「cookie 注入一律用单域」硬约束，且实测每次跑都在给 `.meituan.com`
// 制造会话级同名副本（探测到 19 项，正是历次注入的沉积）。
// 探测（_recon/_probe-ka-quanyi/yifeng.json）：无注入版两账号 exit 0、
// 5/5 区间齐全、字段与带注入版完全一致 —— ka 走 SSO（sessions.mjs sso:true），
// profile 本域 35 项活 cookie 足够，注入块是认知不一致期的遗留产物。

// 确保停在 ka 域下（页内请求需同源）
await cdp.send("Page.navigate", { url: `https://${KA_DOMAIN}/new#/newhome` });
/**
 * sleep 9s 是在等 ka 的前端把接口层初始化好，**不能删**。
 *
 * ⚠️ 但只有 sleep 不够（2026-10-21）：本步骤紧跟在 exposure 之后共用同一个浏览器，
 *    上一个进程刚放手时页面还在导航，ka 的 SSO 也可能在 9 秒之后才慢跳一次，
 *    结果 `pageFetchAll` 的 evaluate 撞上导航 → `Inspected target navigated or closed`。
 *    单独跑永远不复现，只有放进 refresh-account.ps1 的步骤序列里才会。
 *    所以 sleep 之后再等一次「页面真正不再乱跳」；跳到登录页会给出明确报错。
 */
await sleep(9000);
await waitPageSettled(cdp, { timeoutMs: 30_000, label: "推广 ka 后台" });
console.log(`已导航到 ${KA_DOMAIN}\n`);

/** 报表公共参数 */
const base = (start, end, extra = {}) =>
  ({
    startDate: start,
    endDate: end,
    cityIds: "-1",
    wmPoiIds: "-1",
    dpPoiIds: "-1",
    prodTypes: "1,36,35",
    searchRange: "0",
    platformType: "-1",
    fundTypes: "-1",
    acctBizType: "0",
    promotionType: "1",
    ...extra,
  });

async function callReport(label, start, end, kind = "overview") {
  const path =
    kind === "overview"
      ? "/kepler/datacenter/api/ka/data/v2/history/overview"
      : "/kepler/datacenter/api/ka/data/v2/history/list";
  const form = kind === "overview" ? base(start, end) : base(start, end, { pageSize: "50", pageNum: "1", queryType: "1" });
  const [r] = Object.values(
    await pageFetchAll(cdp, [{ key: "r", method: "POST", path, form }]),
  );
  return { label, start, end, kind, status: r.status, code: r.code, data: r.data };
}

const results = [];

console.log("═══ ① 今日（用于量纲对齐：应与首页「今日消耗」一致）═══");
const rToday = await callReport("今日", d(0), d(0));
results.push(rToday);
console.log(`  status=${rToday.status} code=${rToday.code}`);

console.log("\n═══ ② 昨日（完整一天）═══");
const rY1 = await callReport("昨日", Y1, Y1);
results.push(rY1);

console.log("═══ ③ 近 7 天 ═══");
const r7 = await callReport("近7天", d(-7), Y1);
results.push(r7);

console.log("═══ ④ 近 30 天 ═══");
const r30 = await callReport("近30天", d(-30), Y1);
results.push(r30);

console.log("═══ ⑤ 明细列表（近7天，逐日逐产品）═══");
const rList = await callReport("近7天明细", d(-7), Y1, "list");
results.push(rList);

// ════════ ⑥ 首页实时（今日口径）════════
/**
 * ⭐⭐ 为什么必须取这一组：**报表是 T+1，`history/overview` 查「今日」恒为 0**。
 *    而首页实时接口能拿到今天**当下**的花费/曝光/点击，还有**分时列表**
 *    （`todayList` 今日分时 + `yesterdayList` 昨日分时）。
 *    经营者 2026-09-22 的要求：「今日的推广数据在推广地址里面能看到，为我加进看板」。
 *
 * ⚠️ **量纲两种，别混**（reference `meituan-ka-api.md` §6.2）：
 *    · `/bff/ad/ka/v1/xfzyy/account/query/summary`      → **分**（todayCost / todayBudget）
 *    · `/kepler/.../data/index/today/marketing`          → **元**（cost / ecpm / cpc）
 *    实测两者互相印证：summary `todayCost=3539` 分 ↔ today/marketing `cost=35.4` 元。
 *    混用会把 35 元报成 3500 元。
 *
 * ⚠️ 实时数据**最长约 15 分钟延迟**（首页原话），看板必须如实标注，不能当成秒级实时。
 * ⚠️ 这份实时口径**没有 ROI / 转化金额** —— 今日 ROI 仍然只能等次日报表。
 */
console.log("\n═══ ⑥ 首页实时（今日）═══");
const rtRaw = await pageFetchAll(cdp, [
  { key: "summary", path: "/bff/ad/ka/v1/xfzyy/account/query/summary?fundType=1" },
  { key: "todayMkt", path: "/kepler/datacenter/api/ka/data/index/today/marketing?controlType=1&sceneType=-1" },
  { key: "balance", path: "/account/r/announcement?queryType=1" },
]);
const numOrNull = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const sRt = rtRaw.summary?.code === 0 ? rtRaw.summary.data ?? {} : null;
const mRt = rtRaw.todayMkt?.code === 0 ? rtRaw.todayMkt.data ?? {} : null;
/** "00:00-01:00" → "00:00"：与订单口径的逐小时标签（HH:00）对齐，X 轴才是同一套刻度 */
const normHourly = (rows) =>
  (rows ?? []).map((x) => ({
    hour: String(x.time ?? "").slice(0, 5),
    cost: numOrNull(x.cost),
    showCount: numOrNull(x.showCount),
    clickCount: numOrNull(x.clickCount),
    ecpm: numOrNull(x.ecpm),
    cpc: numOrNull(x.cpc),
  }));
const realtimeToday =
  sRt || mRt
    ? {
        source: "ka-homepage-realtime",
        /** 首页原话：数据预计最长有 15 分钟延迟 */
        delayMin: 15,
        /** 元：优先用 today/marketing（本来就是元），否则把 summary 的分 ÷100 */
        cost: mRt?.cost != null ? Number(mRt.cost) : sRt?.todayCost != null ? Number(sRt.todayCost) / 100 : null,
        budget: sRt?.todayBudget != null ? Number(sRt.todayBudget) / 100 : null,
        costRate: numOrNull(sRt?.todayCostRate),
        chainRatio: sRt?.todayCostChainRatio != null ? Number(sRt.todayCostChainRatio) : null,
        showCount: numOrNull(mRt?.showCount),
        clickCount: numOrNull(mRt?.clickCount),
        ecpm: numOrNull(mRt?.ecpm),
        cpc: numOrNull(mRt?.cpc),
        spreadingPoiNum: numOrNull(sRt?.spreadingPoiNum),
        costPoiNum: numOrNull(sRt?.costPoiNum),
        hourly: normHourly(mRt?.todayList),
        hourlyYesterday: normHourly(mRt?.yesterdayList),
        /**
         * ⚠️ `/account/r/announcement` 的 `data.balance` 是**对象**不是数字：
         *    `{balance: {...{lessThanCost, primaryBalance, balance: 370.38, ...}}}`
         *    直接 Number() 会得到 NaN（第一版就踩了，日志里打出了「余额 NaN 元」）。
         */
        balance: (() => {
          const b = rtRaw.balance?.data?.balance;
          if (b == null) return null;
          return typeof b === "number" ? b : numOrNull(b.balance);
        })(),
        balanceInsufficient: (() => {
          const b = rtRaw.balance?.data?.balance;
          return typeof b === "object" && b ? b.lessThanCost === true : null;
        })(),
      }
    : null;
if (realtimeToday) {
  console.log(
    `  今日消耗 ${realtimeToday.cost ?? "—"} 元（预算 ${realtimeToday.budget ?? "—"} 元，已用 ${realtimeToday.costRate ?? "—"}%）` +
      ` · 曝光 ${realtimeToday.showCount ?? "—"} · 点击 ${realtimeToday.clickCount ?? "—"}` +
      ` · 推广中门店 ${realtimeToday.spreadingPoiNum ?? "—"} 家（有消耗 ${realtimeToday.costPoiNum ?? "—"} 家）`,
  );
  console.log(`  分时：今日 ${realtimeToday.hourly.length} 段 / 昨日 ${realtimeToday.hourlyYesterday.length} 段 · 余额 ${realtimeToday.balance ?? "—"} 元`);
} else {
  console.log("  ⚠️ 首页实时接口没取到（code != 0）—— 今日推广仍将显示「—」，并保留 T+1 说明");
}


// ════════ 汇总输出 ════════
/**
 * ⚠️ overview 的**聚合值在 data 顶层**（showCount/clickCount/cost/cpc/cpm/clickRate），
 * 另外 data.list 是按 prodType 拆分的一层嵌套。
 * 我上一版误取 `data.list[0]`（那是 {prodType, prodTypeName, list} 包装），导致全 0。
 */
const pick = (d2) => d2 ?? {};
const num = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));

console.log("\n" + "═".repeat(78));
console.log("  报表汇总（金额字段为「分」，已换算为元）");
console.log("═".repeat(78));
console.log("  区间        曝光次数   点击次数    消耗(元)     CPC(元)  CPM(元)   点击率   ROI");
for (const r of results.filter((x) => x.kind === "overview")) {
  const x = pick(r.data);
  const cost = num(x.cost);
  console.log(
    `  ${r.label.padEnd(10)} ${String(num(x.showCount)).padStart(8)} ${String(num(x.clickCount)).padStart(10)} ` +
      `${(cost / 100).toFixed(2).padStart(11)} ${(num(x.cpc) / 100).toFixed(2).padStart(10)} ${(num(x.cpm) / 100).toFixed(2).padStart(9)} ` +
      `${(num(x.clickRate) * 100).toFixed(2).padStart(7)}% ${num(x.convertEffectRoi).toFixed(2).padStart(6)}`,
  );
}

console.log("\n  明细（近7天）逐条：");
const listRows = rList.data?.list ?? [];
console.log(`  共 ${rList.data?.total ?? 0} 条`);
for (const x of listRows.slice(0, 12)) {
  console.log(
    `    ${String(x.time).padEnd(11)} ${String(x.prodTypeName ?? "").padEnd(10)} ` +
      `消耗 ${(num(x.cost) / 100).toFixed(2).padStart(8)} 元   曝光 ${String(num(x.showCount)).padStart(6)}   ` +
      `ROI ${num(x.convertEffectRoi).toFixed(2).padStart(6)}   转化金额 ${(num(x.convertOrderAmount) / 100).toFixed(2)}`,
  );
}

// 按产品线拆分（overview 的 list 是 {prodType, prodTypeName, list:[...]} 一层嵌套）
console.log("\n  按产品线拆分：");
const ov = results.find((r) => r.kind === "overview" && r.label === "近7天")?.data;
for (const g of ov?.list ?? []) {
  const rows = g.list ?? [];
  const sumCost = rows.reduce((s, x) => s + num(x.cost), 0);
  const sumShow = rows.reduce((s, x) => s + num(x.showCount), 0);
  const sumConv = rows.reduce((s, x) => s + num(x.convertOrderAmount), 0);
  console.log(
    `    ${String(g.prodTypeName ?? g.prodType).padEnd(12)} 消耗 ${(sumCost / 100).toFixed(2).padStart(9)} 元   ` +
      `曝光 ${String(sumShow).padStart(7)}   转化金额 ${(sumConv / 100).toFixed(2).padStart(10)} 元   ROI ${sumCost ? (sumConv / sumCost).toFixed(2) : "—"}`,
  );
}

// ════════ 推广占比（派生）════════
console.log("\n" + "═".repeat(78));
console.log("  参考：转化口径占比（看板不用这个，看板用「消耗 ÷ 预计收入」）");
console.log("═".repeat(78));
for (const r of results.filter((x) => x.kind === "overview")) {
  const x = pick(r.data);
  const cost = num(x.cost), conv = num(x.convertOrderAmount);
  const ratio = conv ? (cost / conv) * 100 : null;
  console.log(
    `  ${r.label.padEnd(10)} 消耗 ${(cost / 100).toFixed(2).padStart(9)} 元   转化金额 ${(conv / 100).toFixed(2).padStart(11)} 元   ` +
      `转化口径占比 ${ratio === null ? "—（无转化金额）" : ratio.toFixed(2) + "%"}`,
  );
}

await mkdir(dirname(OUT), { recursive: true });
/**
 * ⚠️ 一个窗口都没成功时**不要落盘**。
 *
 * 真实翻车：某次刷新里 ka 的 5 个区间调用全部失败（`code != 0`），
 * 脚本照样把空结果写进 `ka-quanyi.json` —— 文件从 **221 KB 掉到 0.7 KB**，
 * 看板的推广板块直接变空，而且没有任何提示。
 * 落盘前先确认至少有一个窗口 `code === 0`，否则保留旧文件并明确报错。
 */
const okCount = results.filter((r) => r.code === 0).length;
if (okCount === 0) {
  console.error(`\n⛔ ${results.length} 个区间全部失败，**不覆盖** ${OUT}`);
  console.error(`   最后响应：${JSON.stringify(results[results.length - 1]?.data ?? results[results.length - 1]?.msg ?? null).slice(0, 200)}`);
  console.error(`   最可能：ka 页面没登录（推广走美团 SSO）。原有数据文件保持不变。`);
  await cdp.close();
  process.exit(2);
}
await writeFile(
  OUT,
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      account: { key: acct.key, label: acct.label },
      port: PORT,
      /** ⭐ 首页实时（今日口径）：额度/花费/曝光/点击 + 今日与昨日的**分时**曲线 */
      realtimeToday,
      results,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`\n落盘 ${OUT}（${okCount}/${results.length} 个区间成功${realtimeToday ? " + 首页实时" : "，无实时"}）`);

await cdp.close();
