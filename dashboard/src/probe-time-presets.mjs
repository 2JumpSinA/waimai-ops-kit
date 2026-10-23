/**
 * 探「平台现成的时间窗口入口」—— 第三轮：直接问 UI
 *   node src/probe-time-presets.mjs [--account=quanyi]
 *
 * 前两轮结论（别再重复）：
 *   · 订单页只有「今日」窗口，没有近7天/近30天预设按钮
 *   · todayOrderSummary 硬编码今日，传区间被忽略
 *   · 经营首页默认 dateType=realTime & beginTime=endTime=今天
 *   · core 接口的 compareBeginTime/compareEndTime 是**必填**，空着报「对比时间错误」
 *
 * 本轮：把「报表」页和经营首页都打开，列出页面上**所有**短文本，
 * 找出真正的时间切换控件并点它，录下点完之后的请求。
 *
 * 判据仍是数值：品牌A近30天预计收入 ≈ 121,869 元。
 * 不打印 cookie / token / mtgsig。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;
const ACCT_ID = acct.key === "quanyi" ? "236679097" : "149608986";
const BASE = "https://yiyao.meituan.com/main/frame#";

const PAGES = [
  { name: "报表", hash: "/page/analysis/report" },
  { name: "经营首页", hash: "/page/analysis/home/o2o" },
];

const INTERESTING = /manageHome|bizdata|analysis|report|chart|trend|order\/list|download/i;
const compact = (v, n = 300) => (v == null ? "(无)" : String(v).replace(/\s+/g, " ").slice(0, n));

/** 时间语义：从宽，宁可多列 */
const TIME_RE = /近\s*\d+\s*[天日周月]|\d+\s*[天日周月]|今日|今天|昨日|昨天|实时|本周|上周|本月|上月|自定义|全部|时间|日期|筛选|统计|环比|同比/;

const cdp = await connectToPage(PORT);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (!INTERESTING.test(u)) return;
  if (/catfront|horn\/v1|s3plus|s3\.meituan|portal-portm/.test(u)) return; // 埋点/静态资源
  seen.push({ method: p.request.method, url: u, postData: p.request.postData ?? null });
});

const dumpNew = (from, label) => {
  const list = seen.slice(from);
  const uniq = new Map();
  for (const h of list) {
    const key = h.method + " " + h.url.split("?")[0] + " " + String(h.postData ?? "").slice(0, 80);
    if (!uniq.has(key)) uniq.set(key, h);
  }
  console.log(`\n      ── ${label}（新增 ${list.length}，去重 ${uniq.size}） ──`);
  if (!uniq.size) { console.log("         （无）"); return; }
  for (const h of uniq.values()) {
    const path = h.url.replace("https://yiyao.meituan.com", "").split("?")[0];
    // query 里剔除签名类参数，只留业务参数，避免刷屏
    const q = new URLSearchParams(h.url.split("?")[1] ?? "");
    for (const k of ["mtgsig", "yodaReady", "csecplatform", "csecversion", "ignoreSetRouterProxy"]) q.delete(k);
    console.log(`         ${h.method} ${path}`);
    const qs = q.toString();
    if (qs) console.log(`            query: ${compact(qs, 240)}`);
    if (h.postData) console.log(`            body : ${compact(h.postData, 260)}`);
  }
};

for (const pg of PAGES) {
  const mark = seen.length;
  console.log(`\n════════ ${pg.name}  ${pg.hash} ════════`);

  await cdp.send("Page.navigate", { url: BASE + pg.hash });
  await new Promise((r) => setTimeout(r, 18_000));
  console.log(`   落地: ${compact(await evaluate(cdp, "location.href"), 130)}`);
  dumpNew(mark, "加载时");

  // 列出所有可见短文本，找出时间控件
  const labels = await evaluate(
    cdp,
    `(() => {
       const out = [];
       for (const e of document.querySelectorAll('button,a,span,div,li,label,p,input')) {
         if (!e.offsetParent) continue;
         const t = (e.textContent || e.placeholder || e.value || '').trim();
         if (t && t.length <= 14) out.push(t);
       }
       return [...new Set(out)];
     })()`,
  );
  const timeish = labels.filter((t) => TIME_RE.test(t));
  console.log(`\n   可见短文本 ${labels.length} 个，其中含时间语义 ${timeish.length} 个：`);
  console.log(`      ${JSON.stringify(timeish).slice(0, 900)}`);

  // 尝试点「近30天」
  const mark2 = seen.length;
  const clicked = await evaluate(
    cdp,
    `(() => {
       const re = /近?\\s*30\\s*[天日]|本月|近一月/;
       const cands = [...document.querySelectorAll('button,a,span,li,label,div')]
         .filter(e => e.offsetParent && re.test((e.textContent || '').trim()) && (e.textContent || '').trim().length <= 8);
       if (!cands.length) return { ok: false };
       cands[0].click();
       return { ok: true, text: (cands[0].textContent || '').trim(), n: cands.length };
     })()`,
  );
  console.log(`\n   点「近30天」: ${JSON.stringify(clicked)}`);
  if (clicked?.ok) {
    await new Promise((r) => setTimeout(r, 12_000));
    const q = await evaluate(
      cdp,
      `(() => {
         const b = [...document.querySelectorAll('button,a,span')]
           .filter(e => e.offsetParent && /^\\s*(查\\s*询|搜\\s*索|确\\s*定|统\\s*计)\\s*$/.test(e.textContent || ''));
         if (b.length) { b[0].click(); return (b[0].textContent||'').trim(); }
         return null;
       })()`,
    );
    if (q) { console.log(`   补点「${q}」`); await new Promise((r) => setTimeout(r, 12_000)); }
    dumpNew(mark2, "点完「近30天」之后");
  }
}

console.log("\n════════════════════════════════════════════════════════════");
console.log(`基准：品牌A近30天预计收入 ≈ 121,869 元`);
console.log("若上面某个请求返回的金额落在这个量级 → 平台确有现成聚合入口。");

await cdp.close();
