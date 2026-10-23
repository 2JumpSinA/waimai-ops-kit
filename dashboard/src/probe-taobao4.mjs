/**
 * 淘宝闪购 · MDA 数据分析接口验证（第四轮，关键一轮）
 *   node src/probe-taobao4.mjs
 *
 * 这一族接口来自数据分析微应用 eb_data_analysis，与商家后台壳完全不同。
 * 拿它来取用户要的四项：
 *   ① 取消单数量/占比（今日 / 近1小时 / 近7天）→ getMasterData / getHourMasterData
 *   ② 异常未营业门店明细                    → 见另一路（门店营业状态）
 *   ③ 近7天高取消单占比门店                  → pageStoreDetails（默认按流失订单排）
 *   ④ 大盘曝光变化                          → flow.anls.ag.group.getMasterData
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCookieHeader, parseCookieString } from "./lib/cookie.mjs";
import { mtopCall } from "./lib/mtop.mjs";

const header = loadCookieHeader("taobao");
const { cookies } = parseCookieString(header);

/** 日期工具（东八区，绝不用 toISOString） */
const d = (offset) => {
  const t = new Date(Date.now() + offset * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    ymd: `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`,
    iso: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`,
  };
};
const TODAY = d(0), Y1 = d(-1), D6 = d(-6);

const cut = (v, n = 700) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > n ? s.slice(0, n) + "…" : s;
};

const results = [];
async function probe(label, api, data) {
  let r;
  try {
    r = await mtopCall({ api, data, cookies });
  } catch (e) {
    console.log(`💥 ${label.padEnd(30)} ${e.message}`);
    return null;
  }
  results.push({ label, api, data, ret: r.ret, ok: r.ok, sample: r.ok ? r.data : undefined });
  if (r.ok) {
    const dd = r.data;
    let shape;
    if (Array.isArray(dd)) shape = `[${dd.length}]` + (dd[0] ? ` 首项keys=${JSON.stringify(Object.keys(dd[0]).slice(0, 14))}` : "");
    else if (dd && typeof dd === "object") shape = `keys=${JSON.stringify(Object.keys(dd).slice(0, 18))}`;
    else shape = cut(dd, 120);
    console.log(`✅ ${label.padEnd(30)} ${shape}`);
    // 深挖一层：看 dataItems / dataItemMaps
    for (const k of ["dataItems", "dataItemMaps", "data"]) {
      const v = dd?.[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        console.log(`     ${k} 的键（${Object.keys(v).length}）：${JSON.stringify(Object.keys(v).slice(0, 30))}`);
      }
      if (Array.isArray(v) && v.length) {
        console.log(`     ${k}[${v.length}] 首项：${cut(v[0], 300)}`);
      }
    }
  } else {
    console.log(`⛔ ${label.padEnd(30)} ${r.ret}`);
  }
  await new Promise((res) => setTimeout(res, 380));
  return r;
}

const MDA = "mtop.nr.mda.portal";

console.log("═══ ① 今日营业统计（biz.getMasterData）═══");
for (const [name, data] of [
  ["YYYYMMDD 今日", { dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd }],
  ["YYYY-MM-DD 今日", { dateRangeTypeCode: "day", startDate: TODAY.iso, endDate: TODAY.iso }],
  ["带 roleType", { dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd, roleType: "1" }],
]) {
  await probe(`今日·${name}`, `${MDA}.biz.anls.ag.group.getMasterData`, data);
}

console.log("\n═══ ② 近7天营业统计 ═══");
await probe("近7天", `${MDA}.biz.anls.ag.group.getMasterData`, {
  dateRangeTypeCode: "day", startDate: D6.ymd, endDate: TODAY.ymd,
});

console.log("\n═══ ③ 按小时（近1小时口径的来源）═══");
await probe("按小时 今日", `${MDA}.biz.anls.ag.group.getHourMasterData`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd,
});
await probe("按小时 昨日", `${MDA}.biz.anls.ag.group.getHourMasterData`, {
  dateRangeTypeCode: "day", startDate: Y1.ymd, endDate: Y1.ymd,
});

console.log("\n═══ ④ 大盘曝光/流量（flow.getMasterData）═══");
await probe("流量 今日", `${MDA}.flow.anls.ag.group.getMasterData`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd,
});
await probe("流量 近7天", `${MDA}.flow.anls.ag.group.getMasterData`, {
  dateRangeTypeCode: "day", startDate: D6.ymd, endDate: TODAY.ymd,
});
await probe("流量 按小时今日", `${MDA}.flow.anls.ag.group.getHourMasterData`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd,
});
await probe("流量总览", `${MDA}.flow.overview.getmasterdata`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd,
});

console.log("\n═══ ⑤ 门店明细（按流失订单排）═══");
await probe("门店明细 今日", `${MDA}.biz.anls.ag.group.pageStoreDetails`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd, pageNum: 1, pageSize: 10,
});
await probe("门店明细 近7天", `${MDA}.biz.anls.ag.group.pageStoreDetails`, {
  dateRangeTypeCode: "day", startDate: D6.ymd, endDate: TODAY.ymd, pageNum: 1, pageSize: 10,
});
await probe("门店明细 流量", `${MDA}.flow.anls.ag.group.pageStoreDetails`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd, pageNum: 1, pageSize: 10,
});

console.log("\n═══ ⑥ 商品分析（退款/差评/热销）═══");
await probe("商品总览", `${MDA}.item.overview.anls.ag.group.getMasterData`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd,
});
await probe("退款商品明细", `${MDA}.item.refund.anls.ag.group.pageItemDetails`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd, pageNum: 1, pageSize: 10,
});
await probe("差评商品明细", `${MDA}.item.badeval.anls.ag.group.pageItemDetails`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd, pageNum: 1, pageSize: 10,
});
await probe("热销商品明细", `${MDA}.item.hotsale.anls.ag.group.pageItemDetails`, {
  dateRangeTypeCode: "day", startDate: TODAY.ymd, endDate: TODAY.ymd, pageNum: 1, pageSize: 10,
});

await mkdir("_recon/raw", { recursive: true });
await writeFile("_recon/raw/taobao-probe4.json", JSON.stringify(results, null, 2));
const okN = results.filter((r) => r.ok).length;
console.log(`\n汇总：${okN} / ${results.length} 可用 → _recon/raw/taobao-probe4.json`);
