/**
 * Cookie 装载。
 *
 * 支持三种来源，按优先级：
 *   1. 环境变量  MEITUAN_COOKIE / TAOBAO_COOKIE
 *   2. .secrets/<name>.cookie.txt   纯 `name=value; name=value` 一行
 *   3. .secrets/<name>.curl.txt     「Copy as cURL」整段文本（自动正则提取）
 *
 * ⚠️ 不落盘、不回显：本模块只把 cookie 交给调用方放进请求头。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SECRETS_DIR = join(ROOT, ".secrets");

/**
 * 拆成键值对。
 * ⚠️ 非 ASCII 值必须剔除：美团 cookie 里的 `wmPoiName` 是未编码的中文店名，
 * Node 的 fetch/undici 对 header 值做严格校验，含非 ASCII 会直接抛
 * `TypeError: Invalid character in header content`。
 * 实测这类项只用于前端展示，剔除不影响接口 —— 但**必须打印剔除了什么**，别静默丢。
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

/** 从「Copy as cURL」整段文本里提取 cookie（支持 -b / --cookie 的 $'...' 转义串）。 */
export function cookieFromCurl(text) {
  const m = /(?:-b|--cookie)\s+\$?(['"])([\s\S]*?)(?<!\\)\1/.exec(text);
  if (!m) return null;
  let s = m[2];
  if (/(?:-b|--cookie)\s+\$'/.test(text)) {
    // bash $'...'：还原 \uXXXX / \n / \' / \xNN
    s = s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, "\n")
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
  }
  return s;
}

/** 读取指定平台的 cookie，返回 `name=value; ...` 请求头值。 */
export function loadCookieHeader(name) {
  const envKey = { meituan: "MEITUAN_COOKIE", taobao: "TAOBAO_COOKIE" }[name];
  if (envKey && process.env[envKey]) {
    const { cookies, dropped } = parseCookieString(process.env[envKey]);
    report(name, "环境变量 " + envKey, cookies, dropped);
    return toHeader(cookies);
  }

  for (const file of [`${name}.cookie.txt`, `${name}.curl.txt`]) {
    const p = join(SECRETS_DIR, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const raw = file.endsWith(".curl.txt") ? cookieFromCurl(text) : text;
    if (!raw) throw new Error(`${p} 里没找到 cookie`);
    const { cookies, dropped } = parseCookieString(raw);
    report(name, file, cookies, dropped);
    return toHeader(cookies);
  }

  throw new Error(
    `未找到 ${name} 的 cookie。请放到 ${join(SECRETS_DIR, name + ".cookie.txt")}，` +
      `或设置环境变量 ${envKey}。`,
  );
}

/**
 * 同 `loadCookieHeader`，但**找不到就返回 null 而不抛**。
 *
 * 用途：cookie 文件只是「省得你手工登录」的加速器 ——
 * 浏览器 profile 里本来就有持久化登录态时，没有 cookie 文件也该照常跑。
 * （历史坑：给 fetch-ka 加注入后，品牌A因为缺 ka.cookie.txt 直接崩，
 *   而它此前一直靠 profile 登录态跑得好好的。）
 */
export function tryLoadCookieHeader(name) {
  try {
    return loadCookieHeader(name);
  } catch {
    console.log(`[cookie] ${name} 无 cookie 文件，改为依赖浏览器 profile 里的登录态`);
    return null;
  }
}

/**
 * 判断一个 cookie 是否适用于请求 `host` + `path`（RFC 6265 语义）。
 *   - 域匹配：`host === domain` 或 `host.endsWith("." + domain)`（domain 去掉前导点）
 *   - 路径匹配：`path` 以 cookie.path 开头
 */
function cookieApplies(c, host, reqPath) {
  const d = String(c.domain ?? "").replace(/^\./, "");
  if (!(host === d || host.endsWith("." + d))) return false;
  const cp = c.path ?? "/";
  if (cp === "/") return true;
  return reqPath === cp || reqPath.startsWith(cp.endsWith("/") ? cp : cp + "/");
}

/**
 * ⭐ 优先从**浏览器 profile** 读活 cookie，读不到再回退静态文件。
 *
 * 为什么这是「不用经常更新 cookie」的正解：
 *   `.secrets/*.cookie.txt` 是一份**静态快照** —— 抓下来那一刻就定死了。
 *   文件里**只有 name=value、没有到期时间**，所以脚本自己判断不出它是否快过期，
 *   只能等接口报错才知道（闪购就是这么炸的：`FAIL_SYS_TOKEN_ILLEGAL::非法令牌`）。
 *   而浏览器 profile 里的 cookie 会被 Chrome 按服务端 `Set-Cookie` **自动续期** ——
 *   只要调试浏览器偶尔开着，profile 里的登录态就一直是新的。
 *
 * ⚠️⚠️ **必须传 `host`，不能传一个宽松的域列表** —— 这是踩过的坑：
 *   美团把 `token` / `bsid` / `acctId` / `wmPoiId` / `device_uuid` **按子域各存一份**，
 *   实测同一账号下：
 *     `waimaie.meituan.com`      → 剩 29.9 天
 *     `yiyao.meituan.com`        → 剩 29.9 天
 *     `ka.waimai.meituan.com`    → 剩 **21.9 小时**（推广侧的会话天生短命）
 *   早期用 `domains: [".meituan.com"]` 过滤，会把三份同名 cookie **全收进来**，
 *   拼成 `token=A; …; token=B; …; token=C` —— 服务端取哪一份全看解析顺序，
 *   拿到 ka 那份就 22 小时后就死。**必须按 host 精确匹配 + 同名去重。**
 *
 * 同名去重规则（模拟浏览器）：**路径最长者优先**；路径相同则**剩余寿命最长者优先**
 * （宁可多活，也不赌服务端取哪一份）。
 *
 * @param {object}   o
 * @param {string}   o.stem       静态文件名（不含 .cookie.txt）
 * @param {string}   o.host       ⭐ 请求目标主机名，如 `yiyao.meituan.com`
 * @param {number}   [o.port]     调试端口；不传/连不上/没登录态 → 回退静态文件
 * @param {string}   [o.path]     请求路径，默认 `/`
 * @param {string[]} [o.required] 必须存在的 cookie 名（缺了说明 profile 里没登录态）
 */
export async function loadCookieSmart({ stem, port, host, path = "/", required = [] }) {
  if (port) {
    try {
      // browser 级 CDP：不依赖渲染进程，浏览器只要开着就能读
      const { connectBrowser, getAllCookies } = await import("./cdp.mjs");
      const cdp = await connectBrowser(port);
      try {
        const all = await getAllCookies(cdp);
        const now = Date.now();
        const usable = all.filter(
          (c) => cookieApplies(c, host, path) && !(typeof c.expires === "number" && c.expires > 0 && c.expires * 1000 < now),
        );

        /**
         * ⭐⭐ 「读得出」≠「可用」—— 2026-10-21 血的教训。
         *
         * 域匹配用的是 RFC 6265：`host === d || host.endsWith("." + d)`。
         * 于是 `.meituan.com` 上的 `token` / `acctId` / `bsid` **父域副本**
         * 对 `yiyao.meituan.com` 也成立，会一起被收进来。
         *
         * 危害：品牌B的 yiyao 会话被服务端清空后，profile 里只剩下父域那几份副本，
         * `required: ["token","acctId"]` 照样满足 → 判定「登录态健康」→
         * 实际一导航就被踢到 `waimaie.meituan.com` 登录页，连续挂了 7 天才被发现。
         *
         * 判据（2026-10-21 实测名单）：健康账号在 yiyao 域上有 65 项 cookie，
         * 含 `token` `acctId` `bsid` `acctLogin` `yy-epassport-accessToken` `WEBDFPID`；
         * 失效账号只剩 7 项且**全是埋点/设备类**（`Path` `__mta` `device_uuid`
         * `pushToken` `shopCategory` `uuid_update` `wpush_server_url`）。
         *
         * ⚠️ 别用「专属 cookie 数量」当判据 —— 试过 `>= 5`，失效账号凑到 7 项照样漏报。
         *    必须看 `required` 里那几个**具体名字**是否以本域专属形态存在。
         *
         * 这里只**告警**、不改行为：真要拒收的话，静态文件兜底往往更差
         * （那是一份更老的快照），失败应该在调用方被清晰地报出来。
         */
        const norm = (d) => String(d ?? "").replace(/^\./, "");
        const hostOwnArr = usable.filter((c) => norm(c.domain) === host);
        const hostOwn = hostOwnArr.length;
        const hostOwnNames = new Set(hostOwnArr.map((c) => c.name));
        const missingOwn = required.filter((r) => !hostOwnNames.has(r));

        // 同名去重：路径最长优先，其次剩余寿命最长
        const best = new Map();
        const dropped = [];
        for (const c of usable) {
          const prev = best.get(c.name);
          if (!prev) {
            best.set(c.name, c);
            continue;
          }
          const pLen = String(c.path ?? "/").length;
          const pPrev = String(prev.path ?? "/").length;
          const eOf = (x) => (typeof x.expires === "number" && x.expires > 0 ? x.expires : 0);
          const better = pLen !== pPrev ? pLen > pPrev : eOf(c) > eOf(prev);
          if (better) {
            dropped.push(prev);
            best.set(c.name, c);
          } else {
            dropped.push(c);
          }
        }

        const names = new Set(best.keys());
        const missing = required.filter((r) => !names.has(r));
        if (best.size >= 5 && !missing.length) {
          console.log(
            `[cookie] ${stem} ← 浏览器 profile:${port} @ ${host}（活 cookie ${best.size} 项，其中 ${host} 专属 ${hostOwn} 项，含 ${required.join("/")}` +
              (dropped.length ? `，同名去重丢弃 ${dropped.length} 项：${[...new Set(dropped.map((c) => c.name))].slice(0, 6).join(",")}` : "") +
              `）`,
          );
          if (missingOwn.length) {
            /**
             * ⚠️ 措辞要克制：这条对**美团医药（yiyao）**是铁证，但对**闪购（nr.ele.me）**
             *    常常只是「profile 里没有、靠 .secrets 静态文件兜底也照样跑」。
             *    实测 2026-10-21：品牌A闪购的静态文件 0.1 天前刚更新、接口正常，
             *    但 profile 里就是没有本域 WMSTOKEN —— 若写成「一定是登录态失效」就是误报。
             *    所以只陈述事实 + 给出两种可能，让调用方自己遇错时能对上号。
             */
            console.warn(
              `[cookie] ⚠️ ${host} 域上没有 ${missingOwn.join(" / ")} —— 只有父域副本` +
                `（本域专属 ${hostOwn} 项，无会话类）。\n` +
                `         ↳ 若本次调用随后被踢到登录页 / 报非法令牌，原因就在这里（需重新登录）；\n` +
                `           若能靠 .secrets 静态文件跑通，则可忽略。`,
            );
          }
          return {
            header: [...best.values()].map((c) => `${c.name}=${c.value}`).join("; "),
            source: "profile",
            count: best.size,
            dropped: dropped.length,
            cookies: Object.fromEntries([...best].map(([k, c]) => [k, c.value])),
          };
        }
        console.log(
          `[cookie] profile:${port} 在 ${host}${path} 下只找到 ${best.size} 项可用 cookie` +
            `（其中 ${host} 专属 ${hostOwn} 项）` +
            (missing.length ? `，缺关键项 ${missing.join(", ")}` : "") +
            ` → 回退静态文件`,
        );
      } finally {
        await cdp.close(); // proc=null，不会杀掉你开着的浏览器
      }
    } catch (e) {
      console.log(`[cookie] 读 profile:${port} 失败（${e.message}）→ 回退静态文件`);
    }
  }
  const header = loadCookieHeader(stem);
  const { cookies } = parseCookieString(header);
  return { header, source: "file", count: Object.keys(cookies).length, dropped: 0, cookies };
}

const toHeader = (cookies) =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

function report(name, src, cookies, dropped) {
  const n = Object.keys(cookies).length;
  console.log(`[cookie] ${name} ← ${src}：保留 ${n} 项` + (dropped.length ? `，剔除非 ASCII：${dropped.join(", ")}` : ""));
}

/** 常用 cookie 值（acctId / wmPoiId / token 等），避免各处重复解析。 */
export function cookieValue(header, key) {
  const m = new RegExp(`(?:^|;\\s*)${key}=([^;]*)`).exec(header);
  return m ? m[1] : undefined;
}
