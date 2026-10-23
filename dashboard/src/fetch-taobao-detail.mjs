/**
 * 淘宝闪购「门店经营明细」取数（纯 Node / MTOP，**不需要浏览器**）。
 *   node src/fetch-taobao-detail.mjs [--account=quanyi|yifeng] [--port=9222|9223]
 *                                    [--ds=YYYYMMDD] [--min-orders=10]
 *
 * 为什么要有这个脚本：
 *   看板的闪购逐店表（订单 / 流失单 / 成交额 / 流失金额）读的是
 *   `data/raw/taobao-stores-detail-<账号>.json`，而这份文件原先**只由
 *   `src/calibrate3.mjs`（一次性标定脚本）产出** —— 刷新流水线根本不生成它。
 *   后果（2026-09-21 发现）：品牌A那份停在 09-17，品牌B那份从来没有。
 *   于是看板上一整块数据「点了刷新也不会变」。本脚本就是补上这一环。
 *
 * 口径（来自 calibrate3.mjs 的窗口对齐实验，**已验证**）：
 *   大盘 KPI  `proteinCode=SC8LRHx`，门店明细 `proteinCode=SEn1HKG`；
 *   实测只有 **begin = ds-6, end = ds** 这一组能让 Σ门店 对上大盘
 *   （另两组 begin=ds / begin=ds-7 都对不上）。ds = 昨天。
 *   接口：`mtop.me.ele.newretail.data.analysis.proteinQueryForArea`，走 **mda 网关**
 *   （host `nrshop.ele.me`）—— 走错网关会像「参数错/没权限」。
 *
 * ⛔ 故意**不提供 `--days`**：其他窗口长度的 `prd_type` / `date_type` 组合没标定过。
 *   猜枚举值是本项目栽过跟头的方式（美团 dateType 那次）。要用别的窗口，
 *   先照 calibrate3 的做法做一次窗口对齐实验，别直接参数化。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCookieSmart } from "./lib/cookie.mjs";
import { mtopCall, ensureMtopToken, GATEWAYS } from "./lib/mtop.mjs";
import { resolveAccount, dataPath } from "./lib/account.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};

const acctMeta = resolveAccount(process.argv);
/** 账号 -> cookie 文件 stem（品牌A沿用历史的 `taobao`） */
const STEM = acctMeta.key === "quanyi" ? "taobao" : `taobao-${acctMeta.key}`;
const OUT = dataPath(acctMeta, "taobao-stores-detail");
/**
 * ⚠️ 闪购 cookie 所在的浏览器必须与该账号一致：品牌A → Chrome(9222)，品牌B → Edge(9223)。
 *    写死 9222 的话品牌B会读**品牌A profile** 的 cookie —— 看着「读到了」，
 *    其实拿的是另一个账号的凭据，比读不到更危险。
 */
const PORT = Number(arg("port", acctMeta.key === "quanyi" ? "9222" : "9223"));
const MIN_ORDERS = Number(arg("min-orders", "10"));
const PAGE_SIZE = 500;
/**
 * 网关与 jsv。
 *
 * ⚠️ `lib/mtop.mjs` 的 `GATEWAYS.mda` 写的是 **jsv 2.7.5**，但实测 2.7.5 会让
 *    proteinQueryForArea 报 `FAIL_SYS_SERVICE_INNER_FAULT::服务内部故障`；
 *    `calibrate3.mjs` 当初跑通用的 **2.7.0** 是好的。
 *    → **以实测为准**（`--jsv=` 可覆盖）。常量与实证冲突时，先信实证，再把常量改掉。
 */
const GATEWAY = { host: GATEWAYS.mda.host, jsv: arg("jsv", "2.7.0") };

/** 东八区日期，`YYYYMMDD`。绝不用 toISOString（按 UTC 算，晚 8 点后会跳天）。 */
const ymd = (dayOffset = 0) => {
  const t = new Date(Date.now() + dayOffset * 86400_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
};
const ymdMinus = (base, days) => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(base));
  if (!m) throw new Error(`--ds 格式应为 YYYYMMDD，收到 ${base}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - days);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};
const n = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));

console.log(`账号 ${acctMeta.label}（${acctMeta.key}）  cookie stem = ${STEM}  端口 ${PORT}`);

let { cookies } = await loadCookieSmart({
  stem: STEM,
  port: PORT,
  host: "nr.ele.me",
  // ⚠️ 只把 WMSTOKEN（登录会话）当硬条件；`_m_h5_tk` 是访问 MTOP 网关时才下发的
  required: ["WMSTOKEN"],
});

if (!cookies._m_h5_tk) {
  console.log("[cookie] 缺 `_m_h5_tk`（MTOP 签名令牌），向网关引导一次…");
  cookies = await ensureMtopToken(cookies, { host: GATEWAY.host, jsv: GATEWAY.jsv });
  console.log(
    cookies._m_h5_tk
      ? `[cookie] ✅ 引导成功（长度 ${String(cookies._m_h5_tk).length}）—— 登录会话本身是好的`
      : "[cookie] ⚠️ 引导失败：该账号的闪购登录会话可能真的失效了",
  );
}

/** 服务端会轮换 `_m_h5_tk`，累计下来退出前写回凭据文件 */
const rotated = {};
const call = async (data) => {
  const r = await mtopCall({
    api: "mtop.me.ele.newretail.data.analysis.proteinQueryForArea",
    data,
    cookies: { ...cookies, ...rotated },
    host: GATEWAY.host,
    jsv: GATEWAY.jsv,
  });
  if (r.cookies?._m_h5_tk && r.cookies._m_h5_tk !== (rotated._m_h5_tk ?? cookies._m_h5_tk)) {
    rotated._m_h5_tk = r.cookies._m_h5_tk;
    console.log(`   ↻ 服务端轮换了 _m_h5_tk`);
  }
  return r;
};

// ── 登录节点：proteinCode 需要 id/role 作为 context ──
const nodeResp = await mtopCall({
  api: "mtop.ele.newretail.ebai.MultiLevelMtopService.getLoginnode",
  data: {},
  cookies: { ...cookies, ...rotated },
  host: GATEWAY.host,
  jsv: GATEWAY.jsv,
});
if (!nodeResp.ok) {
  console.error(`\n⛔ 取登录节点失败：${nodeResp.ret}`);
  process.exit(2);
}
const login = (nodeResp.data?.data ?? nodeResp.data)?.loginNodeInfo ?? {};
const ID = String(login.nodeId ?? "");
const ROLE = String(login.nodeType ?? "");
if (!ID) { console.error("\n⛔ 登录节点里没有 nodeId，无法继续"); process.exit(2); }
console.log(`  登录节点 nodeId=${ID} nodeType=${ROLE}`);

/** proteinQueryForArea 的固定信封 */
async function protein(proteinCode, parameters) {
  const data = {
    context: JSON.stringify({ appName: "kbtdatacenter", userName: ROLE, userId: ID }),
    request: JSON.stringify({
      proteinCode,
      withTracker: true,
      parameters: { id: ID, role: ROLE, ...parameters },
    }),
  };
  const r = await call(data);
  if (!r.ok) return { error: r.ret };
  const dd = r.data?.data;
  return { result: dd?.result, parameters: dd?.parameters };
}

// ── 窗口：两个接口**参数不同**，这是标定实验的结论，别拍平 ──
const ds = arg("ds", ymd(-1));
const begin = ymdMinus(ds, 6);
const WIN_BASE = { prd_type: "week", date_type: "近7日", ds };
/**
 * ⛔ 大盘 KPI 与门店明细的 `begin_day` **不一样**：
 *   · 大盘 KPI  —— `begin_day = end_day = ds`（页面就是这么发的；服务端自己按
 *                  `ds + prd_type=week` 展开成近7日）
 *   · 门店明细  —— `begin_day = ds-6, end_day = ds`（标定实验里唯一能对上大盘的一组；
 *                  另两组 begin=ds / begin=ds-7 都对不上）
 *   我第一版把同一个窗口喂给两个接口，大盘直接报
 *   `FAIL_SYS_SERVICE_INNER_FAULT::服务内部故障` —— 症状看着像权限或 jsv 问题，
 *   其实是参数错了。**标定脚本里的「差异」是有信息量的，别顺手归一化。**
 */
const KPI_WIN = { ...WIN_BASE, begin_day: ds, end_day: ds };
const DETAIL_WIN = { ...WIN_BASE, begin_day: begin, end_day: ds };
console.log(`\n窗口（近7日，已标定）：`);
console.log(`  大盘 KPI    begin=${ds} end=${ds}`);
console.log(`  门店明细    begin=${begin} end=${ds}\n`);

// ── ① 大盘 KPI（自校用）──
console.log("──── ① 大盘 KPI ────");
const kpiResp = await protein("SC8LRHx", { ...KPI_WIN });
if (kpiResp.error) {
  console.error(`⛔ 大盘 KPI 失败：${kpiResp.error}`);
  process.exit(2);
}
const K = kpiResp.result?.records?.[0] ?? {};
console.log(`  总成交额 ${K.order_total_amt}  有效订单 ${K.order_cnt}  流失订单 ${K.invalid_order_cnt}`);

// ── ② 门店明细（分页）──
console.log("\n──── ② 门店明细 ────");
const raw = [];
let pageNum = 1;
let lastRecords = null;
for (;;) {
  const r = await protein("SEn1HKG", { ...DETAIL_WIN, pageSize: String(PAGE_SIZE), pageNum: String(pageNum) });
  if (r.error) {
    // 第一页就失败 → 整体失败；后续页失败 → 保留已取到的并如实记录
    if (pageNum === 1) { console.error(`⛔ 门店明细首页失败：${r.error}`); process.exit(2); }
    console.warn(`  ⚠️ 第 ${pageNum} 页失败（${r.error}），以已取到的 ${raw.length} 家为准`);
    break;
  }
  const recs = r.result?.records ?? [];
  lastRecords = recs;
  raw.push(...recs);
  process.stdout.write(`\r  已取 ${raw.length} 家…   `);
  if (recs.length < PAGE_SIZE) break;
  if (pageNum > 20) break; // 安全阀
  pageNum++;
}
process.stdout.write("\r" + " ".repeat(40) + "\r");
console.log(`  门店 ${raw.length} 家`);

/**
 * ⛔ 一条都没取到就**不要落盘**。
 *    真实翻车：品牌A闪购 cookie 过期后重跑，脚本照样把空结果写进文件，
 *    **把上一份好数据覆盖了**。这里沿用同一条规矩。
 */
if (raw.length === 0) {
  console.error(`\n⛔ 门店明细返回 0 条，**不覆盖** ${OUT}`);
  console.error(`   最可能：cookie 失效（看错误码是不是 FAIL_SYS_TOKEN_* / 非法令牌）`);
  console.error(`   请更新 .secrets/${STEM}.cookie.txt 后重跑。原有数据文件保持不变。`);
  process.exit(2);
}

const range = raw[0]?.date_range ?? `${begin}~${ds}`;
const stores = raw.map((x) => ({
  name: x.shop_name,
  id: x.shop_id,
  city: x.city_name,
  supplier: x.supplier_name,
  orders: n(x.order_cnt),
  invalid: n(x.invalid_order_cnt),
  // ⚠️ rate 存**小数**：build-dashboard 会 `× 100`（量纲踩过一次，别再改）
  rate: n(x.order_cnt) ? n(x.invalid_order_cnt) / n(x.order_cnt) : 0,
  amt: n(x.order_total_amt),
  invalidAmt: n(x.invalid_order_amt),
  u: n(x.invalid_order_cnt_user),
  del: n(x.invalid_order_cnt_del),
  shop: n(x.invalid_order_cnt_shop),
  oth: n(x.invalid_order_cnt_oth),
  range: x.date_range,
}));

// ── ③ 自校：Σ门店 应 ≈ 大盘（这正是窗口对齐实验的判据）──
const sumCnt = stores.reduce((s, x) => s + x.orders, 0);
const sumAmt = Number(stores.reduce((s, x) => s + x.amt, 0).toFixed(2));
const sumInv = stores.reduce((s, x) => s + x.invalid, 0);
const kOrder = n(K.order_cnt);
const kAmt = Number(n(K.order_total_amt).toFixed(2));
/**
 * ⚠️ KPI 字段缺失时必须判「无法判定」，**不能**判通过。
 *    原版 calibrate3.mjs 的写法是 `Math.abs(sumCnt - n(K.order_cnt)) <= 2`，
 *    而 `n(undefined)` = 0 —— KPI 挂了的时候 `|0-0| <= 2` 成立，
 *    于是它打印出一个 **假的 ✅**（我实测复现过：
 *    「Σ订单 0 ✅ 大盘 undefined」）。假阳性比报错更坏，它让人以为没事。
 */
const kpiPresent = K.order_cnt != null && K.order_total_amt != null;
const selfCheck = {
  windowRange: range,
  sumOrders: sumCnt, kpiOrders: kpiPresent ? kOrder : null,
  ordersDiff: kpiPresent ? sumCnt - kOrder : null,
  sumAmount: sumAmt, kpiAmount: kpiPresent ? kAmt : null,
  amountDiff: kpiPresent ? Number((sumAmt - kAmt).toFixed(2)) : null,
  sumInvalid: sumInv, kpiInvalid: kpiPresent ? n(K.invalid_order_cnt) : null,
  ok: kpiPresent ? Math.abs(sumCnt - kOrder) <= 2 && Math.abs(sumAmt - kAmt) <= 5 : null,
  note: kpiPresent ? "" : "大盘 KPI 未返回 order_cnt/order_total_amt，无法自校（不是「通过」）",
};

console.log(`\n──── ③ 自校（Σ门店 vs 大盘）────`);
if (!kpiPresent) {
  console.log(`  ◻️ 大盘 KPI 缺字段，无法自校：${JSON.stringify(K).slice(0, 120)}`);
} else {
  console.log(`  Σ订单 ${sumCnt}  大盘 ${kOrder}  差 ${selfCheck.ordersDiff}`);
  console.log(`  Σ成交额 ${sumAmt}  大盘 ${kAmt}  差 ${selfCheck.amountDiff}`);
  console.log(`  Σ流失单 ${sumInv}  大盘 ${selfCheck.kpiInvalid}`);
  console.log(`  ${selfCheck.ok ? "✅ 门店级与大盘窗口一致" : "⚠️ 对不上 —— 窗口或口径可能变了，别默默当成对的"}`);
}

// ── 高取消门店（小样本门槛，避免 1 单 100% 的噪音）──
const ranked = stores.filter((s) => s.orders >= MIN_ORDERS).sort((a, b) => b.rate - a.rate);
console.log(`\n──── 高流失占比门店（订单数 ≥ ${MIN_ORDERS}，共 ${ranked.length} 家）────`);
for (const s of ranked.slice(0, 5)) {
  console.log(`  ${(s.rate * 100).toFixed(1).padStart(5)}%  ${String(s.name).slice(0, 24).padEnd(26)} 订单 ${String(s.orders).padStart(4)}  流失 ${String(s.invalid).padStart(3)}`);
}

// ── 写回轮换的 token ──
if (rotated._m_h5_tk) {
  const merged = { ...cookies, ...rotated };
  const header = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("; ");
  await writeFile(join(ROOT, ".secrets", `${STEM}.cookie.txt`), header + "\n", "utf8");
  console.log(`\n   ↻ 已把轮换后的 _m_h5_tk 写回 .secrets/${STEM}.cookie.txt`);
}

const result = {
  fetchedAt: new Date().toISOString(),
  account: { key: acctMeta.key, label: acctMeta.label },
  source: "taobao-shangou-store-detail",
  caliber:
    "近7日 = 昨天往前 7 天（begin=ds-6, end=ds）；门店明细 proteinCode=SEn1HKG，" +
    "大盘 KPI proteinCode=SC8LRHx，走 mda 网关（nrshop.ele.me）。rate 存小数。",
  windowParams: { kpi: KPI_WIN, detail: DETAIL_WIN },
  window: range,
  kpi: K,
  storeCount: stores.length,
  minOrders: MIN_ORDERS,
  selfCheck,
  stores,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(result, null, 2), "utf8");
console.log(`\n已落盘 ${OUT}（${(JSON.stringify(result).length / 1024).toFixed(0)} KB，${stores.length} 家）`);
