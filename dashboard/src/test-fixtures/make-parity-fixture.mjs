/**
 * 生成 parity 的**合成** VM 夹具（`src/test-fixtures/parity-vm.json`）。
 *   node src/test-fixtures/make-parity-fixture.mjs
 *
 * ⚠️ 2026-09-22 从 `_recon/struct/` 迁到这里：`_recon/` 在交接文档里是「可清理」目录，
 *    而 `npm test` 的 parity 依赖这个夹具 —— 生成器若被清掉，夹具就再也没法复现。
 *    放在夹具旁边（`src/` 下）才是可持续的。
 *
 * 为什么要合成而不是直接抄真实 VM：真实 VM 里有营业额/门店等业务数据，
 *   不该固化进 `src/` 下的测试夹具。合成数据只要**形状**对（字段齐全、量纲正确、
 *   含空值与 false 分支），就足以驱动模板做模板级对照。
 *
 * 形状由 `buildProjectModel` + `buildDashboardVm` 自己产出 —— 这样夹具与产品永远同构，
 * 不会出现"手写的夹具字段名跟产品对不上"。
 *
 * ⚠️ 产品新增 VM 字段后**必须重跑本脚本**，否则 parity 的读集探针会如实报
 *    「字段名漂移：读到的恒为 undefined」（2026-09-22 加 windowSeries / ka.daily30 时踩过）。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjectModel, buildDashboardVm } from "../lib/dashboard-model.mjs";
import { INCOME } from "../lib/caliber.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "src", "test-fixtures", "parity-vm.json");

const iso = (d) => `2026-09-${String(d).padStart(2, "0")}`;

function synthetic(key, label, fullLabel, source, seed) {
  const daily = Array.from({ length: 30 }, (_, i) => ({
    date: iso(i + 1 > 30 ? 30 : i + 1),
    orderCount: 10 + ((i * 3 + seed) % 17),
    validOrderCount: 10 + ((i * 3 + seed) % 17),
    cancelCount: (i + seed) % 3,
    cancelRate: ((i + seed) % 3) / (10 + ((i * 3 + seed) % 17)),
    projectedIncome: 100 + ((i * 7 + seed) % 90),
    avgOrderValue: 10,
  }));
  const files = {
    mt: {
      panels: { overview: { latestTime: { data: "2026-09-22 09:00:00" } } },
      ctx: { acctId: `acct-${key}` },
      stores: [{ id: "s1", name: "合成店一", city: "杭州", status: "营业中", restReason: "" }],
      storeStatusDist: { 营业中: 3, 停业中: 1 },
    },
    inc: {
      source,
      selfCheck: { projectedIncomeDiff: 0 },
      officialToday: { settleIncome: 120 },
      daily,
      windows: {
        today: { label: "今日", start: iso(22), end: iso(21), orderCount: 12, validOrderCount: 11, cancelCount: 1, cancelRate: 1 / 12, projectedIncome: 120, cancelIncome: null, avgOrderValue: 10.9, source: "todayOrderSummary（官方今日实时汇总）" },
        yesterday: { label: "昨日", start: iso(21), end: iso(21), orderCount: 20, validOrderCount: 19, cancelCount: 1, cancelRate: 0.05, projectedIncome: 200, cancelIncome: null, avgOrderValue: 10.5, source: "fixTimeChart 昨日行 + order_cancel" },
      },
      byPoi: {
        d7: [{ poiId: "p1", poiName: "合成店一", orders: 30, cancel: 6, income: 300, rate: 0.2 }, { poiId: "p2", poiName: "合成店二", orders: 5, cancel: 0, income: 50, rate: 0 }],
        d30: [{ poiId: "p1", poiName: "合成店一", orders: 120, cancel: 12, income: 1200, rate: 0.1 }],
      },
    },
    ka: {
      results: [
        { kind: "overview", label: "今日", data: { cost: 0, showCount: 0, clickCount: 0, clickRate: 0, convertEffectRoi: null, convertOrderAmount: 0 } },
        { kind: "overview", label: "昨日", data: { cost: 11496, showCount: 5000, clickCount: 100, cpc: 91, cpm: 5150, clickRate: 0.02, convertEffectRoi: 6.0024, convertOrderAmount: 69004 } },
        { kind: "overview", label: "近7天", data: { cost: 73562, showCount: 35000, clickCount: 700, cpc: 91, cpm: 5150, clickRate: 0.02, convertEffectRoi: 7.1415, convertOrderAmount: 525345 } },
        /**
         * ⭐ 2026-09-22：`近30天` 必须带 `dayList`，否则 `ka.daily30` 为空、
         *   「近30天」窗口的推广曲线画不出来（夹具要覆盖这条新路径）。
         *   ⚠️ `dayList[].time` 是 **YYYYMMDD 无横线**（与 kind=list 的 YYYY-MM-DD 不同），
         *      夹具按真实格式给，才能验到归一化那一步。
         */
        { kind: "overview", label: "近30天", data: {
          cost: 300000, showCount: 150000, clickCount: 3000, cpc: 91, cpm: 5150, clickRate: 0.02,
          convertEffectRoi: 6.6, convertOrderAmount: 2000000,
          dayList: Array.from({ length: 30 }, (_, i) => ({
            time: `202609${String(i + 1).padStart(2, "0")}`,
            cost: 10000 + i * 7, showCount: 5000 + i, clickCount: 100 + (i % 5),
            convertEffectRoi: 6 + i / 100, convertOrderAmount: 60000 + i * 10,
          })),
        } },
        { kind: "list", data: { list: [{ time: iso(21), cost: 11496, showCount: 5000, clickCount: 100, convertEffectRoi: 6.0024, convertOrderAmount: 69004 }] } },
      ],
      /**
       * ⭐ 2026-09-22：推广**首页实时**（今日口径）。
       *   报表 T+1 查「今日」恒 0，今日改走这个；它还带 `todayList`/`yesterdayList`
       *   **分时**曲线 —— 「今日/昨日」窗口据此画真小时图。夹具必须覆盖这两条新路径，
       *   否则 parity 的读集探针会报 `ka.realtime` 恒为 undefined。
       *   ⚠️ `hour` 用 `HH:00`（源数据是 `00:00-01:00`，取数脚本已归一化）。
       */
      realtimeToday: {
        source: "ka-homepage-realtime", delayMin: 15,
        cost: 35.4, budget: 16350, costRate: 0.22, chainRatio: -34.9,
        showCount: 858, clickCount: 34, ecpm: 41.26, cpc: 1.04,
        spreadingPoiNum: 124, costPoiNum: 19, balance: 370.38,
        hourly: Array.from({ length: 24 }, (_, h) => ({
          hour: `${String(h).padStart(2, "0")}:00`, cost: 1 + (h % 4), showCount: 20 + h, clickCount: 1 + (h % 3), ecpm: 40, cpc: 1,
        })),
        hourlyYesterday: Array.from({ length: 24 }, (_, h) => ({
          hour: `${String(h).padStart(2, "0")}:00`, cost: 2 + (h % 5), showCount: 30 + h, clickCount: 2 + (h % 2), ecpm: 45, cpc: 1.1,
        })),
      },
    },
    expo: {
      source: "platform-total",
      caliber: "（合成夹具：原始文案不参与渲染）",
      fetchedAt: "2026-09-22T02:00:00.000Z",
      windows: {
        today: { days: 1, uv: 1000, pv: 3000, ringUv: 10, ringPv: 20, ringRateUv: 1, ringRatePv: 2, day: iso(21) },
        d7: { days: 7, uv: 7000, pv: 21000, ringUv: 100, ringPv: 300, ringRateUv: 1.4, ringRatePv: 1.4, day: iso(21) },
        d30: { days: 30, uv: 30000, pv: 90000, ringUv: 1000, ringPv: 3000, ringRateUv: 3.4, ringRatePv: 3.4, day: iso(21) },
      },
      daily: Array.from({ length: 30 }, (_, i) => ({ date: iso(i + 1 > 30 ? 30 : i + 1), uv: 900 + i, pv: 2700 + i * 3 })),
      dailyCaliber: "逐日来自 flowTransformationChart",
    },
    today: {
      date: iso(22),
      totals: { orders: 12, cancel: 1, amount: 120, cancelRate: 1 / 12 },
      recentHour: { orders: 3, cancel: 1, rate: 1 / 3 },
      recent3Hour: { orders: 8, cancel: 1, rate: 0.125 },
      hourly: [{ hour: "09:00", orders: 3, cancel: 1, income: 100, rate: 1 / 3 }, { hour: "10:00", orders: 5, cancel: 0, income: 200, rate: 0 }],
      // ⭐ 2026-09-22 新增：昨日逐小时（看板「昨日」窗口用）—— 夹具要覆盖这条新路径
      dateYesterday: iso(21),
      hourlyYesterday: Array.from({ length: 24 }, (_, h) => ({
        hour: `${String(h).padStart(2, "0")}:00`,
        orders: 2 + (h % 5), cancel: h % 3 === 0 ? 1 : 0, income: 100 + h * 3, rate: h % 3 === 0 ? 0.2 : 0,
      })),
      yesterdayTotals: { orders: 20, cancel: 1, cancelRate: 0.05, projectedIncome: 200, source: "order-list-local" },
      poiRank: [{ poiId: "p1", poiName: "合成店一", orders: 5 }],
      caliber: {
        recentHour: "近1小时取消 = 下单时间落在近 1 小时内的订单中已取消的",
        yesterdayHourly: "昨日逐小时 = 昨日订单按 order_time 分桶（合成夹具）",
      },
    },
    tb: { storeCount: 7, cityDist: { 杭州: 4, 成都: 3 }, stores: [] },
    tbDetail: { window: "20260915~20260921", kpi: { order_cnt: 100, order_total_amt: "51875.24" }, stores: [{ name: "闪购合成店", id: "t1", city: "杭州", supplier: "供应商", orders: 10, invalid: 1, rate: 0.1, amt: 1000, invalidAmt: 50, u: 1, del: 0, shop: 0, oth: 0, range: "20260915~20260921" }] },
  };
  // 最后一天的逐日必须与窗口对齐（不变量：曲线末点 == 最新日窗口）
  const last = files.expo.daily[files.expo.daily.length - 1];
  last.uv = files.expo.windows.today.uv;
  last.pv = files.expo.windows.today.pv;

  const unifiedAll = [
    { project: key, mtName: "合成店一", city: "杭州", kind: "planned", mtId: "p1", tbId: "t1", planned: true, duplicate: false, live: { mtStatus: "营业中" } },
    { project: key, mtName: "合成店二", city: "成都", kind: "normal_offline", mtId: "p2", tbId: "", planned: false, duplicate: false, live: { mtStatus: "停业中" } },
    { project: key, mtName: "合成店三", city: "", kind: "unplanned", mtId: "", tbId: "t3", planned: false, duplicate: false, live: { mtStatus: "" } },
    { project: key, mtName: "重复店-N", city: "成都", kind: "planned", mtId: "p9", tbId: "", planned: false, duplicate: true, live: { mtStatus: "停业中" } },
  ];
  const anomaliesAll = [
    { project: key, mtName: "合成店二", city: "成都", planned: false, offlineReason: "", anomaly: { meituan: true, eleme: false }, live: { mtStatus: "停业中", mtStatusFrom: "接口" } },
    { project: key, mtName: "合成店三", city: "", planned: true, offlineReason: "", anomaly: { meituan: false, eleme: true }, live: { tbStatus: "休息中", tbStatusFrom: "台账" } },
  ];
  return buildProjectModel({ key, label, fullLabel }, { unifiedAll, anomaliesAll, files });
}

const metas = [
  { key: "quanyi", label: "品牌A", fullLabel: "品牌A健康" },
  { key: "yifeng", label: "品牌B", fullLabel: "品牌B" },
];
const projects = [
  synthetic("quanyi", "品牌A", "品牌A健康", INCOME.SOURCE_PLATFORM, 0),
  synthetic("yifeng", "品牌B", "品牌B", INCOME.SOURCE_PLATFORM, 5),
];
const vm = buildDashboardVm({ projects, projectMetas: metas, generatedAt: "2026-09-22 10:00:00" });

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(vm, null, 2) + "\n", "utf8");
console.log(`已写出 ${OUT}`);
console.log(`  ${(JSON.stringify(vm).length / 1024).toFixed(1)} KB`);
console.log(`  projectOrder ${JSON.stringify(vm.projectOrder)}`);
console.log(`  notes ${vm.notes.length} 条 / selfCheckSpecs ${vm.selfCheckSpecs.length} 条 / caliber 顶层键 ${Object.keys(vm.caliber).length} 个`);
console.log(`  曝光末点==窗口: ${vm.projects.quanyi.exposure.daily.at(-1).pv === vm.projects.quanyi.exposure.windows.today.pv}`);
