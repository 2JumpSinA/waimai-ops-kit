/**
 * MTOP 模块自检（不联网）。
 *   node src/test-mtop.mjs
 *
 * 验证签名公式与 URL 构造符合从源码提取的原文：
 *   sign = md5(token + "&" + t + "&" + appKey + "&" + data)
 *   url  = //<prefix>.<subDomain>.<mainDomain>/h5/<api 小写>/<v 小写>/
 *   params = { jsv: "2.5.8", appKey, t, sign, data, ... }
 */
import { createHash } from "node:crypto";
import { buildMtopUrl, mtopSign, mtopToken, DEFAULT_APP_KEY } from "./lib/mtop.mjs";

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${extra}`); }
};

const COOKIES = { _m_h5_tk: "abc123def456_1699999999999" };
const T = 1700000000000;
const DATA = JSON.stringify({ a: 1, b: "中文" });

console.log("=== 1. token 取法 ===");
ok('截取下划线之前 → "abc123def456"', mtopToken(COOKIES) === "abc123def456", `实得 ${mtopToken(COOKIES)}`);

console.log("\n=== 2. 签名公式（与独立计算比对）===");
const expected = createHash("md5")
  .update(`abc123def456&${T}&${DEFAULT_APP_KEY}&${DATA}`, "utf8")
  .digest("hex");
const { sign, t } = mtopSign(COOKIES, DEFAULT_APP_KEY, DATA, T);
ok("sign 与 md5(token&t&appKey&data) 一致", sign === expected, `\n     期望 ${expected}\n     实得 ${sign}`);
ok('t 为毫秒字符串', t === String(T));
ok("appKey 默认为 12574478", DEFAULT_APP_KEY === "12574478");

console.log("\n=== 3. URL 构造 ===");
const api = "mtop.ele.newretail.ebai.AccountShopCookieService.getAccountInfo";
const url = buildMtopUrl({ api, data: { a: 1, b: "中文" }, cookies: COOKIES, t: T });
ok("走 mtop.ele.me 网关", url.startsWith("https://mtop.ele.me/h5/"));
ok("api 路径已转小写", url.includes("/h5/mtop.ele.newretail.ebai.accountshopcookieservice.getaccountinfo/1.0/"));
const qs = new URL(url).searchParams;
ok('jsv = "2.5.8"', qs.get("jsv") === "2.5.8", `实得 ${qs.get("jsv")}`);
ok("appKey 已带上", qs.get("appKey") === "12574478");
ok("t 已带上", qs.get("t") === String(T));
ok("sign 已带上", qs.get("sign") === expected);
ok("data 为原文（未编码的 JSON 还原后一致）", qs.get("data") === DATA, `实得 ${qs.get("data")}`);
ok('type = "originaljson"', qs.get("type") === "originaljson");

console.log("\n=== 4. data 的 key 顺序敏感性（必须固定顺序，否则签名对不上）===");
const j1 = JSON.stringify({ a: 1, b: 2 });
const j2 = JSON.stringify({ b: 2, a: 1 });
ok("不同顺序 → 不同签名（说明顺序必须固定）", mtopSign(COOKIES, DEFAULT_APP_KEY, j1, T).sign !== mtopSign(COOKIES, DEFAULT_APP_KEY, j2, T).sign);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
