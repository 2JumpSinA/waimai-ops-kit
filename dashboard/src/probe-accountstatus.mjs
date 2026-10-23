/**
 * 用页面真实的 body 调 accountstatus/get，读出「账号状态」到底怎么判的。
 *   node src/probe-accountstatus.mjs [--port=9223] [--bizLine=health_ka]
 *
 * 真实请求（嗅探得出）：
 *   POST /gw/api/implatform/dialogdispatch/accountstatus/get
 *   body {"accountId":"149608986","bizLine":"health_ka","poiId":"-1"}
 *
 * 上一版探测**没带 body**，得到 `bizLine为空` —— 那是我自己制造的假象，不是真因。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9223"));
const BIZ = arg("bizLine", "health_ka");

const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 60_000 }).catch(() => null);
await new Promise((r) => setTimeout(r, 5000));

const out = await evaluate(
  cdp,
  `(async () => {
     const res = {};
     const post = async (label, url, body) => {
       try {
         const r = await fetch(url, {
           method: 'POST', credentials: 'include',
           headers: { 'Content-Type': 'application/json;charset=UTF-8' },
           body: JSON.stringify(body),
         });
         res[label] = { status: r.status, body: (await r.text()).slice(0, 600) };
       } catch (e) { res[label] = { error: String(e && e.message) }; }
     };
     const ACCT = '149608986';
     // 用页面真实的 bizLine
     await post('真实 bizLine=' + ${JSON.stringify(BIZ)},
       '/gw/api/implatform/dialogdispatch/accountstatus/get',
       { accountId: ACCT, bizLine: ${JSON.stringify(BIZ)}, poiId: '-1' });
     // 对照：其它可能的业务线
     for (const bl of ['health', 'health_yiyao', 'waimai', 'health_shangou']) {
       await post('对照 bizLine=' + bl,
         '/gw/api/implatform/dialogdispatch/accountstatus/get',
         { accountId: ACCT, bizLine: bl, poiId: '-1' });
     }
     return JSON.stringify(res);
   })()`,
);

for (const [k, v] of Object.entries(JSON.parse(out))) {
  console.log(`\n── ${k} ──`);
  console.log(`   ${JSON.stringify(v).slice(0, 600)}`);
}

await cdp.close();
