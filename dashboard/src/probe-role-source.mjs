/**
 * 追查「未关联角色」到底由哪个接口判定。
 *   node src/probe-role-source.mjs [--port=9223]
 *
 * 已知：`/queryMenu` 返回 code=0 且菜单完整 —— 说明**权限本身是有的**。
 * 所以错误页一定来自别的引导接口。逐个打一遍并打印完整响应。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";

const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 9223);
const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 60_000 }).catch(() => null);
await new Promise((r) => setTimeout(r, 6000));

const out = await evaluate(
  cdp,
  `(async () => {
     const res = {};
     const call = async (label, url, init) => {
       try {
         const r = await fetch(url, Object.assign({ credentials: 'include' }, init || {}));
         const t = await r.text();
         res[label] = { status: r.status, body: t.slice(0, 700) };
       } catch (e) { res[label] = { error: String(e && e.message) }; }
     };
     const acct = 149608986;
     const POST = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };

     await call('① accountstatus/get',
       '/gw/api/implatform/dialogdispatch/accountstatus/get');
     await call('② menu/category POST',
       '/api/health/center/menu/category', Object.assign({}, POST, { body: '' }));
     await call('③ task/menuConfig',
       '/api/health/center/task/menuConfig?acctId=' + acct);
     await call('④ poiInfo/get',
       '/v2/sc/index/r/poiInfo/get?acctId=' + acct);
     await call('⑤ account/biz-type',
       '/health/pc/account/biz-type?ignoreSetRouterProxy=true');
     await call('⑥ queryMenu',
       '/queryMenu');
     // 菜单数量：直接数 queryMenu 的 top-level menus
     try {
       const r = await fetch('/queryMenu', { credentials: 'include' });
       const j = await r.json();
       res['⑦ queryMenu 统计'] = {
         code: j.code, msg: j.msg,
         topMenus: (j.data?.menus || []).map(m => m.menuName),
         subCount: (j.data?.menus || []).reduce((s, m) => s + (m.subMenus?.length || 0), 0),
       };
     } catch (e) { res['⑦ queryMenu 统计'] = { error: String(e && e.message) }; }
     return JSON.stringify(res);
   })()`,
);

for (const [k, v] of Object.entries(JSON.parse(out))) {
  console.log(`\n── ${k} ──`);
  console.log(`   ${JSON.stringify(v).slice(0, 700)}`);
}

await cdp.close();
