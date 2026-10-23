/**
 * 探「经营报告 / 经营首页」上的现成数据与曲线（重点：取消单 / 退款 的逐小时趋势）。
 *   node src/probe-report-page.mjs [--account=quanyi]
 *
 * 背景（经营者）：
 *   · 「取消单在平台上有现成的数据和曲线图，别翻今日订单」（今日翻单要 243 秒）
 *   · 他给的截图是「经营报告」页：核心数据含 退款金额/退款订单量，
 *     下面是「退款订单量-趋势图」，横轴 00:00~23:00 —— **逐小时曲线**
 *
 * 所以只需要回答一件事：**取消/退款的逐小时曲线走哪个接口、要什么参数**。
 * 方法照旧：让页面自己发一遍，把真实请求抄下来（猜枚举值是本项目栽过的坑）。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = acct.port;
const BASE = "https://yiyao.meituan.com/main/frame#";

const PAGES = [
  ["经营报告", "/page/analysis/report"],
  ["经营首页", "/page/analysis/home/o2o"],
];

const compact = (v, n = 240) => (v == null ? "(无)" : String(v).replace(/\s+/g, " ").slice(0, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = /catfront|msp\.meituan|dreport|logan|portal-portm|s3plus|s3\.meituan|awp-|api\.neixin|static-prod/i;

const cdp = await connectToPage(PORT);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (SKIP.test(u)) return;
  if (!/yiyao\.meituan\.com\/(api|gw|v2|sc)\//.test(u)) return;
  if (/emergencyAccess|latestTime|getLabelList|getCityDataList|poiList$|pushToken|permissions/.test(u)) return;
  seen.push({ method: p.request.method, url: u, postData: p.request.postData ?? null });
});

const dump = (from, label) => {
  const uniq = new Map();
  for (const h of seen.slice(from)) {
    const path = h.url.replace("https://yiyao.meituan.com", "").split("?")[0];
    const q = new URLSearchParams(h.url.split("?")[1] ?? "");
    for (const k of ["mtgsig", "yodaReady", "csecplatform", "csecversion", "ignoreSetRouterProxy", "jsVersion"]) q.delete(k);
    const key = h.method + " " + path + " " + q.toString() + " " + (h.postData ?? "");
    if (!uniq.has(key)) uniq.set(key, { method: h.method, path, q: q.toString(), postData: h.postData });
  }
  console.log(`\n   ── ${label}（${uniq.size} 条业务请求）──`);
  for (const h of uniq.values()) {
    console.log(`      ${h.method} ${h.path}`);
    if (h.q) console.log(`         q: ${compact(h.q, 240)}`);
    if (h.postData) console.log(`         b: ${compact(h.postData, 240)}`);
  }
};

for (const [name, hash] of PAGES) {
  console.log(`\n════════ ${name}  ${hash} ════════`);
  const m0 = seen.length;
  await cdp.send("Page.navigate", { url: "about:blank" });
  await sleep(1200);
  await cdp.send("Page.navigate", { url: BASE + hash });
  await sleep(22_000);
  console.log(`  落地: ${compact(await evaluate(cdp, "location.href").catch(() => "?"), 120)}`);

  /**
   * ⚠️ 控件在**同源 iframe** 里（这个坑吃过一次：顶层只看到外壳菜单）。
   *    顶层 + 所有 iframe 一起枚举。
   */
  const texts = await evaluate(
    cdp,
    `(() => {
       const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
       const out = new Set();
       const re = /取消|退款|流失|趋势|曝光|流量|统计时间|按日|按周|核心数据|实时|近7天|近30天/;
       for (const d of docs) {
         for (const e of d.querySelectorAll('div,span,td,th,button,a,label,h1,h2,h3')) {
           if (!e.offsetParent) continue;
           const t = (e.textContent || '').trim();
           if (t && t.length <= 22 && re.test(t)) out.add(t);
         }
       }
       return [...out].slice(0, 60);
     })()`,
  ).catch(() => []);
  console.log(`\n   可见相关文本（含 iframe）：${JSON.stringify(texts)}`);

  dump(m0, `${name} 加载时`);

  // 试试点「近7天」（报告页有这套页签），看趋势接口变不变
  const m1 = seen.length;
  const clicked = await evaluate(
    cdp,
    `(() => {
       const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
       for (const d of docs) {
         const c = [...d.querySelectorAll('button,a,span,li,div')]
           .filter(e => e.offsetParent && ['近7天','近7日'].includes((e.textContent||'').trim()));
         if (c.length) { c[0].click(); return { ok:true, text:(c[0].textContent||'').trim() }; }
       }
       return { ok:false };
     })()`,
  );
  console.log(`\n   点「近7天」→ ${JSON.stringify(clicked)}`);
  if (clicked?.ok) { await sleep(12_000); dump(m1, `${name} 点「近7天」后`); }
}

console.log("\n════════════════════════════════════════");
console.log("要的答案：取消/退款**逐小时曲线**走哪个接口、参数是什么。");
await cdp.close();
