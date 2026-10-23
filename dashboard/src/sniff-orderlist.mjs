/**
 * 嗅探「全部订单」页真实发出的订单列表请求，拿到正确的 tag / 参数组合。
 *   node src/sniff-orderlist.mjs [--account=quanyi] [--port=9222]
 *
 * 背景：`fetch-meituan-*.mjs` 一直用 `tag=history_all`，之前能跑；
 * 但浏览器重启后同一请求变成 `{"code":1,"msg":"列表标签错误"}`。
 * 与其猜，不如让页面自己发一遍，把 postData 原样抄下来。
 */
import { connectToPage } from "./lib/cdp.mjs";
import { resolveAccount } from "./lib/account.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const acct = resolveAccount(process.argv);
const PORT = Number(arg("port", String(acct.port)));
const PAGE = "https://yiyao.meituan.com/main/frame#/page/orderbusiness#/order/history";

const cdp = await connectToPage(PORT);
const hits = [];
cdp.on("Network.requestWillBeSent", (p) => {
  const u = p.request?.url ?? "";
  if (/order\/list\/page\/history|order\/list\/interval|todayOrderSummary/.test(u)) {
    hits.push({
      method: p.request.method,
      url: u,
      postData: p.request.postData ?? null,
      headers: p.request.headers,
    });
  }
});

console.log(`导航到订单页：${PAGE}`);
await cdp.send("Page.navigate", { url: PAGE });
await new Promise((r) => setTimeout(r, 15000));

// 有的页面要先点一下「查询」才会发请求 —— 试着点一次含「查询/搜索」的按钮
try {
  const clicked = await (await import("./lib/cdp.mjs")).evaluate(
    cdp,
    `(() => {
       const btns = [...document.querySelectorAll('button,a,span,div')]
         .filter(e => /查\\s*询|搜\\s*索/.test(e.textContent || '') && e.offsetParent);
       if (btns.length) { btns[0].click(); return btns[0].textContent.trim().slice(0,20); }
       return null;
     })()`,
  );
  if (clicked) {
    console.log(`点了「${clicked}」按钮`);
    await new Promise((r) => setTimeout(r, 8000));
  }
} catch (e) {
  console.log(`点按钮失败：${e.message}`);
}

console.log(`\n══ 捕获到 ${hits.length} 条相关请求 ══`);
for (const h of hits) {
  console.log(`\n${h.method} ${h.url.slice(0, 120)}`);
  if (h.postData) {
    console.log(`  body: ${String(h.postData).slice(0, 500)}`);
  }
  const ref = h.headers?.Referer;
  if (ref) console.log(`  Referer: ${ref.slice(0, 120)}`);
}

if (!hits.length) {
  console.log("没抓到。当前页面 URL / 标题：");
  const info = await (await import("./lib/cdp.mjs")).evaluate(
    cdp,
    "location.href + ' | ' + document.title",
  );
  console.log("  " + info);
}

await cdp.close();
