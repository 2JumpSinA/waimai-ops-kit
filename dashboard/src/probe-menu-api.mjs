/**
 * 直问菜单/权限接口，看账号到底有没有角色。
 *   node src/probe-menu-api.mjs [--port=9223]
 *
 * 从网络嗅探得知，商家中心加载时会打：
 *   /queryMenu
 *   /api/health/center/menu/category
 *   /gw/api/unified/r/poi/menu/list
 * 其中 menu/list 决定左栏菜单，也是「未关联角色」的判定处。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9223"));

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
         res[label] = { status: r.status, body: t.slice(0, 900) };
       } catch (e) { res[label] = { error: String(e && e.message) }; }
     };
     const acct = 149608986;

     await call('queryMenu GET', '/queryMenu');
     await call('menu/category GET', '/api/health/center/menu/category');
     await call('poi/menu/list GET',
       '/gw/api/unified/r/poi/menu/list?ignoreSetRouterProxy=true&acctId=' + acct + '&businessType=1&poiId=-1');
     await call('poi/menu/list POST',
       '/gw/api/unified/r/poi/menu/list?ignoreSetRouterProxy=true',
       { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
         body: 'acctId=' + acct + '&businessType=1&poiId=-1' });
     await call('biz-type', '/health/pc/account/biz-type?ignoreSetRouterProxy=true');
     return JSON.stringify(res);
   })()`,
);

for (const [k, v] of Object.entries(JSON.parse(out))) {
  console.log(`\n── ${k} ──`);
  console.log(`   ${JSON.stringify(v).slice(0, 800)}`);
}

await cdp.close();
