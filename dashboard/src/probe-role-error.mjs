/**
 * 在 Edge profile 里打开 /main/frame，抓出「未关联角色」是哪个接口返回的，
 * 以及账号/角色/菜单相关接口都回了什么。
 *   node src/probe-role-error.mjs [--port=9223]
 *
 * 背景：经营者截图显示
 *   「您当前账号未关联角色/角色未关联任何权限，请联系品牌总账号重新为您分配角色权限」
 * acctId 与旧 profile 一致（149608986），所以不是"登错账号"，需要看接口怎么说。
 *
 * ⚠️ 只读响应，不做任何写操作。
 */
import { connectToPage } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9223"));
const URL_ = "https://yiyao.meituan.com/main/frame";

const cdp = await connectToPage(PORT);
const hits = [];
cdp.on("Network.responseReceived", async (p) => {
  const u = p.response?.url ?? "";
  if (!/menu|privilege|role|permission|account|user|login|auth|brand|home\/index|queryMenu/i.test(u)) return;
  hits.push({ url: u, status: p.response.status, mime: p.response.mimeType, reqId: p.requestId });
});

await cdp.send("Page.navigate", { url: URL_ });
await new Promise((r) => setTimeout(r, 15000));

const finalUrl = await (await import("./lib/cdp.mjs")).evaluate(cdp, "location.href");
console.log(`最终 URL：${finalUrl}\n`);

console.log(`══ 相关请求 ${hits.length} 条 ══`);
for (const h of hits.slice(0, 30)) {
  console.log(`  [${h.status}] ${h.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 130)}`);
}

// 直接问几个可能的「我是谁 / 我有什么菜单」接口
const probes = [
  "/health/center/merchant/home/index?pageItemCode=PITEM2&acctId=149608986&businessType=1&poiId=-1",
  "/api/health/center/task/statistics",
  "/v2/sc/index/r/poiInfo/get?acctId=149608986",
];
console.log(`\n══ 主动探测账号/权限接口 ══`);
const out = await (await import("./lib/cdp.mjs")).evaluate(
  cdp,
  `(async () => {
     const paths = ${JSON.stringify(probes)};
     const res = {};
     for (const p of paths) {
       try {
         const r = await fetch(p, { credentials: 'include' });
         const t = await r.text();
         res[p.split('?')[0]] = { status: r.status, text: t.slice(0, 400) };
       } catch (e) { res[p.split('?')[0]] = { error: String(e && e.message) }; }
     }
     return JSON.stringify(res);
   })()`,
);
for (const [k, v] of Object.entries(JSON.parse(out))) {
  console.log(`\n  ${k}`);
  console.log(`    ${JSON.stringify(v).slice(0, 420)}`);
}

await cdp.close();
