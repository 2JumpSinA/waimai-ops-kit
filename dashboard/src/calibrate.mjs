/**
 * 口径标定：把「接口返回值」与「页面显示值」对齐。
 *   node src/calibrate.mjs [--port=9222]
 *
 * 做法（底座文档第九步之三）：
 *   让页面自己发请求 → 同时录下 ①请求参数 ②响应体 ③页面上显示的数字
 *   三者对上，才能确定接口字段的真实口径与量纲。
 *
 * 要回答的具体问题：
 *   - `SC8LRHx` 的 `ds=今日` 给出 order_cnt=5602、`ds=昨日` 只给 106，差 50 倍
 *   - 哪个才是「当日」？`ds` 到底是分区日期还是别的？
 *   - 金额单位是元还是分？
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage(PORT);
console.log("✅ 已连接");

// ── 采集 page 自己发出的 proteinQueryForArea 请求与响应 ──
const pending = new Map(); // requestId -> {params, api}
const results = [];

cdp.on("Network.requestWillBeSent", (p) => {
  const url = p.request?.url ?? "";
  if (!/proteinQueryForArea/i.test(url)) return;
  let qs = {};
  try { qs = Object.fromEntries(new URL(url).searchParams); } catch {}
  let inner = null;
  try { inner = JSON.parse(qs.data ?? "{}"); } catch {}
  let req = null;
  try { req = JSON.parse(inner?.request ?? "{}"); } catch {}
  pending.set(p.requestId, { proteinCode: req?.proteinCode, parameters: req?.parameters, context: inner?.context });
});

cdp.on("Network.loadingFinished", async (p) => {
  const info = pending.get(p.requestId);
  if (!info) return;
  pending.delete(p.requestId);
  try {
    const { body } = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
    let j = null;
    try { j = JSON.parse(body); } catch {}
    results.push({ ...info, response: j?.data ?? j });
  } catch (e) {
    results.push({ ...info, error: e.message });
  }
});

// ── 导航并等待页面把数据加载出来 ──
const PAGE = "https://nr.ele.me/eleme_nr_bfe_retail/eb_data_analysis/businessAnalysis?nav=zoneMiddlemen";
console.log(`打开 ${PAGE}`);
await cdp.send("Page.navigate", { url: PAGE });
await sleep(16000);

// ── 读页面上显示的文字 ──
const domText = await evaluate(
  cdp,
  `(() => {
     const t = document.body ? document.body.innerText : "";
     return t.replace(/\\n{2,}/g, "\\n").slice(0, 2500);
   })()`,
);
console.log("\n" + "═".repeat(72));
console.log("  页面显示的文字（KPI 区）");
console.log("═".repeat(72));
console.log(domText);

// ── 页面自己发的请求 + 它拿到的响应 ──
console.log("\n" + "═".repeat(72));
console.log(`  页面自己发出的 proteinQueryForArea 请求（${results.length} 条）`);
console.log("═".repeat(72));
for (const r of results) {
  console.log(`\n▸ 服务号 ${r.proteinCode}`);
  console.log(`  context  : ${r.context}`);
  console.log(`  参数     : ${JSON.stringify(r.parameters)}`);
  if (r.error) { console.log(`  ⛔ ${r.error}`); continue; }
  const res = r.response?.result ?? r.response;
  const rec = res?.record ?? {};
  const recs = res?.records ?? [];
  console.log(`  resultType: ${r.response?.resultType}  status: ${res?.statusCode ?? "-"}`);
  const fields = (r.response?.parameters?._downloadFields ?? "").split(",").filter(Boolean);
  if (fields.length) console.log(`  字段: ${fields.join(", ")}`);
  if (Object.keys(rec).length) console.log(`  记录: ${JSON.stringify(rec)}`);
  if (recs.length) {
    console.log(`  [${recs.length} 条]`);
    for (const x of recs.slice(0, 4)) console.log(`     ${JSON.stringify(x)}`);
  }
}

await mkdir(join(ROOT, "_recon", "raw"), { recursive: true });
await writeFile(join(ROOT, "_recon", "raw", "calibrate.json"), JSON.stringify({ domText, results }, null, 2), "utf8");

// 截图，便于肉眼核对页面上的数字
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1400, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
await writeFile(join(ROOT, "_recon", "raw", "calibrate.png"), Buffer.from(shot.data, "base64"));
console.log(`\n截图 _recon/raw/calibrate.png`);
console.log(`数据 _recon/raw/calibrate.json`);
await cdp.close();
