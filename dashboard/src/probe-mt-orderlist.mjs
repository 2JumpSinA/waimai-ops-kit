/**
 * 探美团订单列表的「预计收入」字段（修正版）
 *   node src/probe-mt-orderlist.mjs [--port=9222]
 *
 * 关键修正：
 *   ① startDate/endDate 格式是 **YYYY-MM-DD**（带横线），不是 YYYYMMDD
 *   ② 订单详情在 `commonInfo` 里是**嵌套的 JSON 字符串**，需二次解析
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const argp = process.argv.find((a) => a.startsWith("--port="));
const PORT = argp ? Number(argp.split("=")[1]) : 9222;

/** ISO 日期（东八区） */
const iso = (o = 0) => {
  const t = new Date(Date.now() + o * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const cdp = await connectToPage(PORT);
console.log(`页面：${(await evaluate(cdp, `location.href`)).slice(0, 90)}\n`);

const call = async (pageNum, start, end) =>
  JSON.parse(
    await evaluate(
      cdp,
      `(async () => {
         const body = new URLSearchParams({
           tag: 'history_all',
           pageParam: JSON.stringify({pageSize:20,pageNum:${pageNum},sort:0,nextLabel:"",lastLabel:"",direction:0,sortField:1}),
           extParam: JSON.stringify({phfRollback:0,requestWmPoiId:"-1",searchTag:"14"}),
           startDate: '${start}',
           endDate: '${end}',
         });
         const r = await fetch('/gw/api/unified/r/order/list/page/history?ignoreSetRouterProxy=true', {
           method:'POST', credentials:'include',
           headers:{'Content-Type':'application/x-www-form-urlencoded'},
           body: body.toString(),
         });
         return await r.text();
       })()`,
    ),
  );

const r = await call(1, iso(0), iso(0));
const list = r.data?.orderList ?? [];
console.log(`data keys: ${JSON.stringify(Object.keys(r.data ?? {}))}`);
console.log(`订单数: ${list.length}\n`);

if (list[0]) {
  console.log("═══ 外层字段 ═══");
  console.log("  " + JSON.stringify(Object.keys(list[0])));
  // commonInfo 是 JSON 字符串
  let ci = {};
  try { ci = JSON.parse(list[0].commonInfo); } catch (e) { console.log("commonInfo 解析失败:", e.message); }
  console.log("\n═══ commonInfo 字段（共 " + Object.keys(ci).length + "）═══");
  console.log("  " + JSON.stringify(Object.keys(ci)));
  console.log("\n═══ 搜 income / amount / 收入 字段 ═══");
  const s = JSON.stringify(list);
  const m = [...s.matchAll(/"([\w]*(?:[Ii]ncome|[Aa]mount|[Pp]rice|[Ss]ettle|[Ff]ee)[\w]*)"\s*:\s*([^,}]{1,30})/g)];
  const seen = new Set();
  for (const x of m) {
    if (seen.has(x[1])) continue;
    seen.add(x[1]);
    console.log(`   ${x[1].padEnd(36)} = ${x[2]}`);
  }
  if (!seen.size) console.log("   （无匹配）");
}
await cdp.close();
