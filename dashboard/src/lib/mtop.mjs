/**
 * 阿里 MTOP 协议客户端（饿了么 / 淘宝闪购零售商家端）。
 *
 * ⭐ 算法已从**目标应用自己的源码**逐字验证（不是从文档推断的）：
 *   `g.alicdn.com/eleme-nr-bfe-newretail/common-next/1.0.63/static/js/vendors.*.js`
 *   原文：
 *     e.token = e.token.split("_")[0]
 *     a = n.appKey || ("waptest" === subDomain ? "4272" : "12574478")
 *     s = (new Date).getTime()
 *     u = md5(r.token + "&" + s + "&" + a + "&" + n.data)
 *     c = { jsv: "2.5.8", appKey: a, t: s, sign: u }
 *
 *   → 与底座文档记录的 `md5(token & t & appKey & data)` **完全一致**。
 *
 * ✅ 因此本通路**不需要浏览器** —— 纯 Node 即可，在受限沙箱里也能跑。
 *    （对比：美团医药的 `mtgsig` 是设备指纹类，必须借页面风控 SDK，故走 CDP。）
 */
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/** MTOP 公共参数。源码实测值 —— 注意是 2.5.8，不是文档里常见的 2.7.0 */
const JSV = "2.5.8";
/** 源码里的默认 appKey（`n.appKey` 未显式指定时用它） */
export const DEFAULT_APP_KEY = "12574478";

/**
 * 解析 `name=value; name=value` 形式的 cookie 串。
 * ⚠️ 非 ASCII 值必须剔除：Node 的 fetch/undici 校验 header 值，
 * 含非 ASCII 会直接抛 `TypeError: Invalid character in header content`。
 */
export function parseCookieString(raw) {
  const kept = {};
  const dropped = [];
  for (const part of raw.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const i = seg.indexOf("=");
    if (i <= 0) continue;
    const name = seg.slice(0, i).trim();
    const value = seg.slice(i + 1).trim();
    if (/^[\x20-\x7E]*$/.test(value)) kept[name] = value;
    else dropped.push(name);
  }
  return { cookies: kept, dropped };
}

export const toHeader = (cookies) =>
  Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

/** 从 cookie 键值对里取 MTOP token（下划线之前那段） */
export function mtopToken(cookies) {
  const raw = cookies["_m_h5_tk"];
  if (!raw) throw new Error("cookie 里没有 `_m_h5_tk` —— 登录会话可能已失效，需重新注入");
  return String(raw).split("_")[0];
}

/** 算签名。`data` 必须是**与发送字串完全一致**的原始 JSON 字符串。 */
export function mtopSign(cookies, appKey, data, t = Date.now()) {
  const token = mtopToken(cookies);
  const ts = String(t);
  return { t: ts, sign: md5(`${token}&${ts}&${appKey}&${data}`) };
}

/**
 * 构造 MTOP 请求 URL。
 *
 * 源码里的拼法：`//<prefix>.<subDomain>.<mainDomain>/h5/<api 小写>/<v 小写>/`
 * 本项目的 prod 网关为 `mtop.ele.me`（页面 `<link rel=preconnect>` 实证）。
 *
 * @param {object} o
 * @param {string} [o.host]   默认 `mtop.ele.me`
 * @param {string} o.api      接口名，如 `mtop.ele.newretail.ebai.ShopReadMtopService.getShopInfo`
 * @param {string} [o.appKey] 默认 `12574478`（源码默认值）
 * @param {object} o.data     业务参数对象
 */
export function buildMtopUrl({ host = "mtop.ele.me", api, appKey = DEFAULT_APP_KEY, data, cookies, version = "1.0", jsv = JSV, t = Date.now() }) {
  // data 的 key 顺序必须固定，否则每次 JSON 字串不同、签名也对不上
  const json = JSON.stringify(data ?? {});
  const { t: ts, sign } = mtopSign(cookies, appKey, json, t);
  const qs = new URLSearchParams({
    jsv,
    appKey,
    t: ts,
    sign,
    api,
    v: version,
    type: "originaljson",
    dataType: "json",
    data: json, // URLSearchParams 负责编码；签名用的是编码前的 json
  });
  return `https://${host}/h5/${api.toLowerCase()}/${version}/?${qs.toString()}`;
}

/**
 * 已知的网关（同一平台下**不同应用走不同网关**，这是本项目踩过的最大坑）：
 *
 * | 应用 | 网关 | 来源 |
 * |---|---|---|
 * | 商家后台壳 `common-next` | `mtop.ele.me` | 页面 preconnect |
 * | 数据分析微应用 `eb_data_analysis` | **`nrshop.ele.me`** | 源码环境表 `prefix:nrshop` + `mainDomain:ele.me` |
 *
 * 走错网关的表现是**所有接口一律 `UNKNOWN_FAIL_CODE::系统开小差了`** ——
 * 看起来像参数错或没权限，实际是路由不对。
 */
export const GATEWAYS = {
  shell: { host: "mtop.ele.me", jsv: "2.5.8" },
  mda: { host: "nrshop.ele.me", jsv: "2.7.5" },
};

/**
 * 从 Set-Cookie 里取出**整对** MTOP 令牌。
 *
 * ⚠️⚠️ 必须成对处理：`_m_h5_tk` 是签名用的（下划线前那段参与 md5），
 *      而 `_m_h5_tk_enc` 是服务端校验用的加密对偶 —— **缺了它服务端会报
 *      `FAIL_SYS_TOKEN_EMPTY::令牌为空`**（字面意思是"令牌为空"，其实令牌明明有，
 *      只是少了配对的另一半，非常容易误判成登录失效）。
 *
 * 实测依据：品牌A的闪购 cookie 有 `_m_h5_tk_enc`，品牌B的没有 —— 同一套代码，
 * 品牌A全部成功、品牌B全部 `令牌为空`。
 * 早先这里用 `/_m_h5_tk=([^;,\s]+)/` 只抓了前者，把后者丢掉了。
 */
function h5TkPair(resp) {
  const out = {};
  for (const c of resp.headers.getSetCookie?.() ?? []) {
    const m = /^(_m_h5_tk(?:_enc)?)=([^;,\s]+)/.exec(c);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** 兼容旧调用：只取签名令牌 */
function newH5Tk(resp) {
  return h5TkPair(resp)._m_h5_tk ?? null;
}

/**
 * ⭐ 令牌引导：cookie 里没有 `_m_h5_tk` 时，**主动打一次网关把它要回来**。
 *
 * 为什么需要：`_m_h5_tk` 不是登录时发的，而是**服务端在你第一次访问 MTOP 网关时**
 * 通过 `Set-Cookie` 下发的（浏览器就是这样拿到的）。
 * 所以「有 WMSTOKEN 但没有 _m_h5_tk」**不代表登录失效** —— 只是这个 profile 还没访问过网关。
 *
 * 早先的做法是直接抛错 `cookie 里没有 _m_h5_tk —— 登录会话可能已失效`，
 * 于是品牌B闪购明明登录着却整段跑不了。现在先引导、再判断。
 *
 * @returns {Promise<object>} 补齐了 `_m_h5_tk` 的 cookies（失败则原样返回）
 */
export async function ensureMtopToken(cookies, { host = "mtop.ele.me", jsv = JSV, appKey = DEFAULT_APP_KEY } = {}) {
  if (cookies["_m_h5_tk"]) return cookies;
  // 用签名算法里那个「空 token」形态打一发：服务端会先回 TOKEN_EMPTY 并附带新 token
  const api = "mtop.ele.newretail.ebai.AccountShopCookieService.getAccountInfo";
  const json = "{}";
  const ts = String(Date.now());
  const sign = md5(`&${ts}&${appKey}&${json}`); // token 为空时的签名形态
  const qs = new URLSearchParams({
    jsv, appKey, t: ts, sign, api, v: "1.0", type: "originaljson", dataType: "json", data: json,
  });
  const url = `https://${host}/h5/${api.toLowerCase()}/1.0/?${qs.toString()}`;
  try {
    const r = await fetch(url, { headers: { cookie: toHeader(cookies) } });
    // ⚠️ 必须把**整对**令牌都收下：只拿 `_m_h5_tk` 会得到 `FAIL_SYS_TOKEN_EMPTY`
    const pair = h5TkPair(r);
    if (pair._m_h5_tk) return { ...cookies, ...pair };
  } catch {
    /* 网络问题就让调用方按原逻辑报错 */
  }
  return cookies;
}

/**
 * 发一次 MTOP 请求，带 **token 自愈**。
 *
 * @returns {{ ok:boolean, ret:string, data:any, cookies:object, attempts:number, raw?:any }}
 *   `cookies` 会带回更新后的 `_m_h5_tk`，调用方应写回凭据，下次直接用新的。
 */
export async function mtopCall({
  host = "mtop.ele.me",
  api,
  appKey = DEFAULT_APP_KEY,
  data = {},
  cookies,
  version = "1.0",
  jsv = JSV,
  retries = 3,
  timeoutMs = 20_000,
  extraHeaders = {},
} = {}) {
  let cur = { ...cookies };
  const extra = {}; // 本次运行内累积的新 cookie，返回值里给调用方

  for (let attempt = 1; attempt <= retries; attempt++) {
    const url = buildMtopUrl({ host, api, appKey, data, cookies: cur, version, jsv });
    const resp = await fetch(url, {
      headers: {
        Cookie: toHeader(cur),
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await resp.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON：可能是登录跳转页或网关错误页
      const looksHtml = /^\s*</.test(text);
      return {
        ok: false,
        ret: looksHtml ? "非 JSON 响应（疑似登录页/网关页）" : "JSON 解析失败",
        data: null,
        cookies: cur,
        attempts: attempt,
        raw: text.slice(0, 300),
        status: resp.status,
      };
    }

    const ret = String(body?.ret?.[0] ?? "");
    if (ret.startsWith("SUCCESS")) {
      return { ok: true, ret, data: body.data ?? body, cookies: cur, attempts: attempt };
    }

    // ⭐ 自愈：令牌过期/非法时，服务端会在 Set-Cookie 下发新令牌（**成对**）
    const pair = h5TkPair(resp);
    const recoverable = /TOKEN|ILLEGAL_ACCESS/i.test(ret);
    if (pair._m_h5_tk && recoverable && attempt < retries) {
      cur = { ...cur, ...pair };
      Object.assign(extra, pair);
      await new Promise((r) => setTimeout(r, 600)); // 服务端令牌生效有微小延迟
      continue;
    }

    return { ok: false, ret, data: body?.data ?? null, cookies: cur, attempts: attempt, raw: body };
  }

  return { ok: false, ret: "重试耗尽", data: null, cookies: cur, attempts: retries };
}

/** MTOP 的 ret 码速查（排障用） */
export const RET_HINT = {
  FAIL_SYS_TOKEN_ILLEGAL: "令牌过期/非法 —— 正常应被自愈；若反复出现说明登录会话也失效了",
  FAIL_SYS_ILLEGAL_ACCESS: "签名错，或 token 与签名不匹配",
  FAIL_SYS_SESSION_EXPIRED: "登录会话过期 —— 需人工重新注入 cookie",
  FAIL_SYS_ILLEGAL_ARGUMENT: "业务参数不合法",
};
