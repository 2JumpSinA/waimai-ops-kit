/**
 * 找「取消单」的计数接口 —— 用 UI 驱动法，抄订单页自己的请求。
 *   node src/probe-order-cancel.mjs [--account=quanyi]
 *
 * 为什么还要这一轮：
 *   平台在窗口模式下给了 16 个指标，但**没有 cancel 字段**（只有 refund）。
 *   还款/取消不是一回事，而「取消单数量与占比」是经营者点名的四项核心指标之一。
 *   先前 `page/history` 用的是 `tag=history_all` + `extParam.searchTag=14`。
 *   订单页上应该有「全部 / 待处理 / 已完成 / 已取消」这类标签页，
 *   每个标签对应一组 tag/searchTag —— 点一次就知道，别再猜。
 *
 * ⭐ 上一轮的教训：控件可能在**同源 iframe** 里。所以这次顶层 + 所有 iframe 一起搜。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const acct = resolveAccount(process.argv);
const PORT = acct.port;
const ORDER = "https://yiyao.meituan.com/main/frame#/page/orderbusiness#/order/history";
const compact = (v, n = 260) => (v == null ? "(无)" : String(v).replace(/\s+/g, " ").slice(0, n));

/** 只看业务接口 */
const KEEP = /^https:\/\/yiyao\.meituan\.com\/(api|gw|v2|sc)\//;
const BIZ = /order\/list|OrderSummary|countAndSum|interval|manageHome|orderDeal/i;

const cdp = await connectToPage(PORT);
const seen = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (!KEEP.test(u) || !BIZ.test(u)) return;
  seen.push({ method: p.request.method, url: u, postData: p.request.postData ?? null });
});

const dumpNew = (from, label) => {
  const uniq = new Map();
  for (const h of seen.slice(from)) {
    const k = h.method + " " + h.url.split("?")[0] + " " + String(h.postData ?? "").slice(0, 90);
    if (!uniq.has(k)) uniq.set(k, h);
  }
  console.log(`\n   ── ${label}（${uniq.size} 条） ──`);
  if (!uniq.size) { console.log("      （无）"); return; }
  for (const h of uniq.values()) {
    console.log(`      ${h.method} ${h.url.replace("https://yiyao.meituan.com", "").split("?")[0]}`);
    if (h.postData) console.log(`         body: ${compact(h.postData, 400)}`);
  }
};

console.log("── 真加载订单页 ──");
/** 新开标签页后立刻导航，偶发 "CDP 连接已关闭" —— 重连一次即可 */
const goto = async (url) => {
  for (let i = 0; i < 3; i++) {
    try {
      await cdp.send("Page.navigate", { url }, { timeoutMs: 20_000 });
      return true;
    } catch (e) {
      console.log(`   navigate 第 ${i + 1} 次失败：${String(e.message).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return false;
};

if (!(await goto("about:blank"))) { console.error("无法导航，放弃"); process.exit(1); }
await new Promise((r) => setTimeout(r, 2500));
const mark = seen.length;
if (!(await goto(ORDER))) { console.error("无法导航到订单页，放弃"); process.exit(1); }
await new Promise((r) => setTimeout(r, 28_000));
console.log(`   落地: ${compact(await evaluate(cdp, "location.href"), 120)}`);

/** 顶层 + 所有同源 iframe 的短文本 */
const LABELS = `(() => {
  const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
  const out = {};
  docs.forEach((d, i) => {
    const s = new Set();
    for (const e of d.querySelectorAll('button,a,span,li,label,div,em,i')) {
      const t = (e.textContent || '').trim();
      if (t && t.length <= 10 && e.offsetParent) s.add(t);
    }
    out['doc' + i] = [...s];
  });
  return out;
})()`;

const labels = await evaluate(cdp, LABELS);
for (const [doc, arr] of Object.entries(labels)) {
  const interesting = arr.filter((t) => /全部|待|取消|完成|历史|退款|售后|异常|进行|配送|新单|预|已/.test(t));
  console.log(`\n   ${doc}: 共 ${arr.length} 个短文本`);
  console.log(`      筛选类: ${JSON.stringify(interesting.slice(0, 40))}`);
}

dumpNew(mark, "订单页加载时");

/**
 * 在任意 doc（顶层 + 同源 iframe）里点第一个**文本等于**给定候选之一的元素。
 * 用「精确相等」而不是正则：标签页名字短且确定，正则反而容易误命中标题/说明文字。
 */
const clickAny = async (candidates, name) => {
  const mark2 = seen.length;
  const r = await evaluate(
    cdp,
    `(() => {
       const want = ${JSON.stringify(candidates)};
       const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
       for (let i = 0; i < docs.length; i++) {
         const cands = [...docs[i].querySelectorAll('button,a,span,li,label,div,em,i')]
           .filter(e => e.offsetParent && want.includes((e.textContent || '').trim()));
         if (cands.length) {
           cands[0].click();
           return { ok: true, doc: i, text: (cands[0].textContent || '').trim(), n: cands.length };
         }
       }
       return { ok: false };
     })()`,
  );
  console.log(`\n   ── 点「${name}」 → ${JSON.stringify(r)} ──`);
  if (!r?.ok) return false;
  await new Promise((x) => setTimeout(x, 13_000));
  dumpNew(mark2, `点「${name}」之后`);
  return true;
};

await clickAny(["已取消", "取消单", "取消"], "已取消");
await clickAny(["全部"], "全部");
await clickAny(["已完成"], "已完成");

console.log("\n════════════════════════════════════════════════════════════");
console.log("关注：点「已取消」后发的请求里，tag / searchTag / menuTags 的取值；");
console.log("      若能带日期区间且只返回计数，就是取消单的聚合接口。");
await cdp.close();
