/**
 * 登录态判据 · 共用库 —— `check-sessions.mjs`（体检）与 `keepalive-sessions.mjs`（保活）共用**同一套**判据。
 *
 * ⛔ 为什么必须抽出来：2026-10-21 那次教训是「判据两边不一致 → 假阳性」。
 *    体检说「有登录态」，保活按另一套判断说「也能跑」，可实际一导航就被踢到登录页，
 *    连续 7 天全挂没人发现。**两套判据打架时，没有任何一方会报警。**
 *    所以：判定规则只写在这里一份，两个脚本都调它。
 *
 * 判据分三层（由严到宽）：
 *   ① **健康**：`required` 里的具体 cookie 名，以**本域专属**（domain 正好等于 host）形态存在。
 *   ② **失效**（`deadSession`）：`required` 只在**父域副本**上有 —— 请求里带得上，但服务端会话已不认。
 *      ⚠️ 别用「数量」当判据：失效账号照样能凑到 7 项，但全是埋点/设备类。
 *   ③ **SSO 型**：本域不存自己的登录 cookie，靠美团 SSO 自动鉴权 —— cookie 层**判不出来**，
 *      不能靠它下结论，否则就是误报（见 TARGETS 里 `sso: true` 的注释）。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { connectBrowser, getAllCookies } from "./cdp.mjs";

const DAY = 86400_000;

/** 去掉域前面的点：`.meituan.com` → `meituan.com`（RFC 6265 里两者等价，比较前必须归一）。 */
export const normDomain = (s) => String(s ?? "").replace(/^\./, "");

/** RFC 6265 域匹配：cookie 域为 d 时，对 host 生效当且仅当 host === d 或以 `.d` 结尾。 */
export function domainMatches(host, cookieDomain) {
  const d = normDomain(cookieDomain);
  return !!d && (host === d || host.endsWith("." + d));
}

/**
 * 每个平台/账号要检查什么。`host` 必须是**具体请求主机名**，不能用宽松域（见 loadCookieSmart 注释）。
 *
 * ⚠️ `sso: true`（推广 ka）：它**不在 ka 域上存自己的登录 cookie**，
 *    而是走美团 SSO —— 页面一打开就自动鉴权。
 *    所以「ka 域下没有 token」**不代表不可用**（实测：ka 域 0 项关键 cookie，
 *    但 fetch-ka.mjs 照样取到了正确的报表）。这类要实跑才算数，不能靠 cookie 层下结论。
 *
 * ⭐ `strictHost`：`required` 必须以「本域专属」形态存在。
 *    美团把 `token`/`acctId`/`bsid` 在 `.meituan.com` 父域上也存一份会话副本；
 *    品牌B yiyao 会话被清空后，profile 里只剩父域残骸，`required` 照样满足 → 假阳性。
 *
 * `homeUrl`：保活时打开的那一页。
 *   ⛔ **只开首页，不点菜单、不提交表单** —— 首页 SPA 自己会发业务请求，
 *   服务端据此刷新活跃时间即可；额外动作会引入「点了某个菜单触发写操作」的风险。
 * `loginCmd`：该账号掉登录时，经营者该双击的启动器（登录必须由**人**来做）。
 *
 * ⭐ `staticFallback: true` —— **只给闪购用**。profile 里没有**本域**关键 cookie 时，
 *    允许 `.secrets/*.cookie.txt` 静态文件把它救活（**仅限 kind='noauth'**，且文件未过期）。
 *
 *    为什么美团系**不允许**：美团医药的静态文件是更老的快照，profile 会话被清空时它只会更死；
 *    报「🟡 仅文件」会让人干等它自愈（2026-10-21 品牌B挂了 7 天就是这么来的）。
 *
 *    为什么闪购**必须允许**：闪购的 `WMSTOKEN` / `_m_h5_tk` 由服务端 Set-Cookie 落到**父域 `.ele.me`**，
 *    `nr.ele.me` 上前端视角只有 `arms_uid` / `nr_alpha_grey` 这些埋点。
 *    `.secrets/taobao*.cookie.txt` 是 `save-cookies.mjs` 从活会话导出的**同源正本**，不是更老快照。
 *    不加这条：保活对两个闪购账号报「⛔ 需登录」并对它们**零动作**，而体检脚本说「🟡 仅文件」——
 *    两套判据打架，正是本库要消灭的东西。
 *    ⚠️ 静态文件本身过期时仍判「需重新登录」，不放行。
 */
export const TARGETS = [
  { label: "品牌A", platform: "美团医药", stem: "meituan", port: 9222, host: "yiyao.meituan.com", homeUrl: "https://yiyao.meituan.com/", required: ["token", "acctId"], strictHost: true, loginCmd: "start-chrome.cmd" },
  { label: "品牌B", platform: "美团医药", stem: "meituan-yifeng", port: 9223, host: "yiyao.meituan.com", homeUrl: "https://yiyao.meituan.com/", required: ["token", "acctId"], strictHost: true, loginCmd: "start-edge-yifeng.cmd" },
  { label: "品牌A", platform: "推广 ka", stem: "ka", port: 9222, host: "ka.waimai.meituan.com", homeUrl: "https://ka.waimai.meituan.com/", required: [], sso: true },
  { label: "品牌B", platform: "推广 ka", stem: "ka-yifeng", port: 9223, host: "ka.waimai.meituan.com", homeUrl: "https://ka.waimai.meituan.com/", required: [], sso: true },
  { label: "品牌A", platform: "淘宝闪购", stem: "taobao", port: 9222, host: "nr.ele.me", homeUrl: "https://nr.ele.me/", required: ["_m_h5_tk", "WMSTOKEN"], strictHost: true, parentOk: true, staticFallback: true, loginCmd: "start-chrome.cmd" },
  // ⚠️ 品牌B的闪购 cookie 在 **Edge** profile（9223）里，不在 9222。
  //    早先这里错写成 9222，于是读到品牌A的闪购 cookie 却报成「品牌B ✅」—— 假阳性。
  { label: "品牌B", platform: "淘宝闪购", stem: "taobao-yifeng", port: 9223, host: "nr.ele.me", homeUrl: "https://nr.ele.me/", required: ["_m_h5_tk", "WMSTOKEN"], strictHost: true, parentOk: true, staticFallback: true, loginCmd: "start-edge-yifeng.cmd" },
];

/** 需要保活（会真的导航首页）的目标：SSO 型 cookie 层定不了论，但导航本身就能续命，所以也算。 */
export const isSsotype = (t) => !!t.sso;

/** 剩余寿命文案 */
export const fmtLeft = (expires) => {
  if (expires === undefined || expires === null || expires === -1) return "(会话级)";
  if (expires < 0) return "永久";
  const left = expires * 1000 - Date.now();
  if (left <= 0) return `⛔ 已过期 ${(-left / DAY).toFixed(1)} 天`;
  if (left < DAY) return `⚠️ 剩 ${(left / 3600_000).toFixed(1)} 小时`;
  if (left < 3 * DAY) return `⚠️ 剩 ${(left / DAY).toFixed(1)} 天`;
  return `剩 ${(left / DAY).toFixed(1)} 天`;
};

/**
 * 把 profile 里读到的全量 cookie 按某个 target 评估成一份**结构化结论**。
 * 纯函数，不连浏览器 —— 所以能单测、两边脚本也绝不会算出不同答案。
 *
 * @param {object} t   TARGETS 中的一项
 * @param {object[]} all profile 里的全量 cookie（CDP Cookie 对象）
 * @returns {{kind:'down'|'ok'|'dead'|'noauth'|'sso', usable:string, detail:string, keyInfo:string, deadSession:boolean, keep:object[], counts:object}}
 *   kind: down=浏览器没开/读不到；ok=健康；dead=父域残骸（需重新登录）；noauth=缺关键 cookie；sso=SSO 型
 *   `keyInfo` **不包含**「剩 N 天」以外的推断：寿命只是提示，不参与健康判定。
 */
export function assessTarget(t, all) {
  if (!all) {
    return { kind: "down", usable: "⚪ 浏览器未开", detail: "端口 DOWN，无法体检", keyInfo: "", deadSession: false, keep: [], counts: { keep: 0, own: 0 } };
  }
  const keep = all.filter((c) => domainMatches(t.host, c.domain));

  if (t.sso) {
    const mtSession = all.find((c) => c.name === "token" && /meituan\.com$/.test(normDomain(c.domain)));
    const detail =
      `走美团 SSO（本域 cookie ${keep.length} 项）` +
      (mtSession
        ? `；美团系 token 存在（${normDomain(mtSession.domain)} ${fmtLeft(mtSession.expires)}）→ 大概率可用`
        : `；**未见美团系 token** → 大概率需要重新登录`);
    return {
      kind: "sso",
      usable: "❔ SSO（需实跑）",
      detail,
      keyInfo: "SSO 型，cookie 层无法定论，请实跑 fetch-ka.mjs 确认",
      deadSession: false,
      keep,
      counts: { keep: keep.length, own: keep.filter((c) => normDomain(c.domain) === t.host).length },
    };
  }

  const names = new Set(keep.map((c) => c.name));
  const missing = t.required.filter((r) => !names.has(r));
  // ⭐ 「本域专属」= cookie 的域**正好等于** host。父域副本不算。
  const hostOwnArr = keep.filter((c) => normDomain(c.domain) === t.host);
  const hostOwnNames = new Set(hostOwnArr.map((c) => c.name));
  const missingOwn = t.strictHost ? t.required.filter((r) => !hostOwnNames.has(r)) : [];
  const counts = { keep: keep.length, own: hostOwnArr.length };

  if (missing.length) {
    return { kind: "noauth", usable: "⛔ 无", detail: `无登录态（缺 ${missing.join(",")}）`, keyInfo: "", deadSession: false, keep, counts };
  }
  /**
   * ⭐ `ok-parent`（2026-10-22 评审裁定新增）：required **只在父域**满足，本域没有。
   *
   * 为什么要单独一个态，而不是简单判 ok 或 dead：
   *   - 判 `ok`（✅ profile）→ 父域残骸与健康账号**完全无差别**，正是本库存在的意义被悄悄破掉；
   *   - 判 `dead`（⛔ 需登录）→ 对**闪购是误报**：实测 `--probe` 打 MTOP，
   *     `quanyi ✅ 可用` / `yifeng ✅ 可用` —— 父域 `.ele.me` 的票据对 MTOP **确实能签名生效**，
   *     这是闪购的设计（`_m_h5_tk` 由服务端首次请求下发到父域），与美团 yiyao 的情形**本质不同**。
   * 所以单列一档：`🟢 父域票据`，并**必须把寿命报出来** ——
   * 实测 `_m_h5_tk` 只剩 1 小时也满足 required，若不说寿命，判据就不反映新鲜度。
   *
   * ⚠️ 只有闪购（`parentOk: true`）走这条。美团医药的父域残骸**仍然是 dead**
   *    （2026-10-21 品牌B假阳性就是它：父域副本满足 required 却一导航就被踢到登录页）。
   */
  const missingOwnOnly = t.strictHost ? missingOwn : [];
  if (missingOwnOnly.length) {
    const parents = [...new Set(keep.map((c) => normDomain(c.domain)).filter((d) => d !== t.host))];
    /**
     * 父域票据的寿命**必须报出来**：实测 `_m_h5_tk` 只剩 1 小时也满足 required，
     * 不报寿命这个判据就不反映新鲜度（评审 2026-10-22 的原话：这是「真实的钝化」）。
     */
    const lifeOfParent = (c) => {
      if (typeof c.expires !== "number" || c.expires <= 0) return { t: -Infinity, label: "(会话级)" };
      return { t: c.expires * 1000, label: fmtLeft(c.expires) };
    };
    const parentKeyInfo = missingOwnOnly
      .map((r) => {
        const cands = keep.filter((c) => c.name === r);
        if (!cands.length) return null;
        const sorted = cands.slice().sort((a, b) => lifeOfParent(b).t - lifeOfParent(a).t);
        const best = lifeOfParent(sorted[0]);
        return `${r} @${normDomain(sorted[0].domain)} ${best.label}`;
      })
      .filter(Boolean)
      .join(" · ");
    if (t.parentOk) {
      /**
       * 最短寿命 < 3 小时时额外标 ⚠️：`_m_h5_tk` 是 MTOP 运行时票据，服务端会随请求续发，
       * 但只剩 1 小时说明**这份 profile 近期没被访问过** —— 保活的价值恰恰在这里。
       */
      const shortest = missingOwnOnly
        .map((r) => {
          const cands = keep.filter((c) => c.name === r);
          if (!cands.length) return Infinity;
          const sorted = cands.slice().sort((a, b) => lifeOfParent(b).t - lifeOfParent(a).t);
          const e = sorted[0].expires;
          return typeof e === "number" && e > 0 ? e * 1000 - Date.now() : Infinity;
        })
        .reduce((a, b) => Math.min(a, b), Infinity);
      const stale = Number.isFinite(shortest) && shortest < 3 * 3600_000;
      return {
        kind: "ok-parent",
        usable: "🟢 父域票据",
        detail:
          `${t.host} 本域没有 ${missingOwnOnly.join(" / ")}，但父域（${parents.join(" / ") || "无"}）有 —— ` +
          `闪购的 ${missingOwnOnly.join("/")} 本就由服务端下发到父域，MTOP 可凭它签名` +
          (stale ? `\n        ⚠️ 但最短寿命已不足 3 小时，说明该 profile 近期未被访问 —— 这正是要保活的场景` : ""),
        keyInfo: parentKeyInfo,
        deadSession: false,
        parentOnly: true,
        keep,
        counts,
      };
    }
    return {
      kind: "dead",
      usable: "⛔ 需重新登录",
      detail:
        `⛔ **登录态已失效** —— ${t.host} 域上没有 ${missingOwnOnly.join(" / ")}\n` +
        `        凑够 ${keep.length} 项的全是父域副本（${parents.join(" / ") || "无"}），` +
        `本域只剩 ${hostOwnArr.length} 项埋点/设备类 cookie，服务端会话已不认`,
      keyInfo: "",
      deadSession: true,
      keep,
      counts,
    };
  }

  /**
   * ⚠️ 报「寿命」时不要只报按路径优先选中的那一份。
   *    同名 cookie 常常有好几份（美团按子域各存一份），其中一份是会话级、另一份能活 30 天。
   *    只报前者会显示成 `(会话级)`，让人误以为「关浏览器就掉」——实测关掉重开后登录态完好。
   *    所以报**同名里最长的那条寿命**，两者不同时都标出来。
   */
  const lifeOf = (c) => {
    if (typeof c.expires !== "number" || c.expires <= 0) return { t: -Infinity, label: "(会话级)" };
    return { t: c.expires * 1000, label: fmtLeft(c.expires) };
  };
  const keyInfo = t.required
    .map((r) => {
      const cands = keep.filter((c) => c.name === r);
      if (!cands.length) return null;
      const sorted = cands.slice().sort((a, b) => lifeOf(b).t - lifeOf(a).t);
      const best = lifeOf(sorted[0]);
      const others = [...new Set(sorted.slice(1).map((c) => lifeOf(c).label))].filter((x) => x !== best.label);
      return `${r} ${best.label}` + (others.length ? `（另有 ${others.join("/")}）` : "");
    })
    .filter(Boolean)
    .join(" · ");

  return {
    kind: "ok",
    usable: "✅ profile",
    detail: `有登录态（${keep.length} 项，其中 ${t.host} 专属 ${hostOwnArr.length} 项）`,
    keyInfo,
    deadSession: false,
    keep,
    counts,
  };
}

/**
 * 按端口缓存 profile 快照（同端口只连一次）。
 *
 * 顺带问出**这个端口背后是哪个浏览器、有几个标签页** —— 曾因「不知道端口后面是谁」把结论整个弄反
 * （同一台机器上可能同时跑着日常 Chrome 和调试 Chrome）。
 *
 * 结果形状：{ cookies|null, browser|null, tabs|null, error|null }
 * cookies 为 null 表示**端口不通**，调用方必须据此报「未开」，绝不能当成健康。
 *
 * @param {Record<number,number>} [portOverride] 端口覆盖表（`--port=9223:9333` 用），
 *   只改「去连哪个端口」，不改 TARGETS 本身的语义 —— 用于**降级隔离测试**：
 *   把某端口指到一个没人监听的端口，验证「一边挂了另一边照常」。
 *
 * ⚠️ 第二参 `{ fresh: true }` 跳过缓存、重新连一次（A20 冷启动重试用），
 *    并在成功后**覆盖缓存**，让同一轮里后续 target 看到的是新结论。
 */
export function makeProfileReader(portOverride = {}) {
  const cache = new Map();
  return async function readProfile(port, { fresh = false } = {}) {
    if (!fresh && cache.has(port)) return cache.get(port);
    const actual = Number(portOverride[port] ?? port);
    const info = { cookies: null, browser: null, profile: null, tabs: null, error: null, actualPort: actual };
    try {
      const cdp = await connectBrowser(actual);
      try {
        info.browser = (await fetch(`http://127.0.0.1:${actual}/json/version`).then((r) => r.json()).catch(() => ({}))).Browser ?? null;
        // 标签页数是很有效的判据：调试浏览器通常 1-2 个页面，日常浏览器动辄五六个。
        const list = await fetch(`http://127.0.0.1:${actual}/json/list`).then((r) => r.json()).catch(() => []);
        info.tabs = list.filter((t) => t.type === "page").length;
        info.cookies = await getAllCookies(cdp);
      } finally {
        await cdp.close(); // proc=null → 不会杀掉经营者开着的浏览器
      }
    } catch (e) {
      info.error = `${e.message}${actual !== port ? `（端口覆盖 ${port}→${actual}）` : ""}`;
    }
    cache.set(port, info);
    return info;
  };
}

/**
 * 体检一个 target 并给出**最终判定**（连浏览器 + 评估 + 结论，一步到位）。
 *
 * 这是两个脚本唯一的判定入口。`kind` 的语义：
 *   down   端口不通（浏览器没开）→ 调用方**必须**如实报「未开」，不许当成健康
 *   ok     健康（本域专属关键 cookie 齐全）
 *   ok-parent ⭐ required **只在父域**满足（闪购：`.ele.me` 票据对 MTOP 有效）→ 报「🟢 父域票据」，
 *           **不报 ✅ profile**，否则父域残骸与健康账号在报告里无差别
 *   dead   父域残骸且该平台**不认**父域票据（美团 yiyao），需人工重新登录 → 调用方不得做无谓导航
 *   noauth 连关键 cookie 都没有 → 同上（除 `staticFallback` 的闪购）
 *   sso    美团 SSO 型，cookie 层定不了论（导航后看是否落登录页才算数）
 *
 * ⚠️ 静态文件（`.secrets/*.cookie.txt`）**默认不参与**判定：它是更老的快照，
 *    profile 都失效了它只会更死。只有 `staticFallback: true`（闪购）且 kind='noauth'
 *    且文件未过期时，才把结论降级为 `ok-static` 并在 `detail` 里说清来源。
 *    **`dead` 与 `ok-parent` 都不走兜底** —— 前者不是快照能补的，后者本来就已经可用。
 *
 * ⭐ A20 冷启动重试：`readProfile` 连一次就下结论是有坑的（`HANDOVER.md:246`：
 *    浏览器刚起 1 秒内 `check-sessions` 误报「无登录态」）——profile 的 cookie DB 还没
 *    从磁盘载入完。所以 cookie 为空、或所有 target 期望的关键项都不在时，重试 2 次、间隔 1.5s。
 *    ⚠️ 只在**看起来像冷启动**时重试：端口本来就不通（cookies 为 null）不重试，
 *    否则「浏览器没开」会被拖慢 3 秒且毫无意义。
 *
 * @returns kind 之外还带：`source`（profile|static|none）、`detail`、`file`、`retried`
 */
export async function checkTarget(t, readProfile, secretsDir) {
  const pinfo = await readProfile(t.port);
  const file = staticFileState(join(secretsDir, `${t.stem}.cookie.txt`));
  let kind = pinfo.cookies ? null : "down";
  let a = assessTarget(t, pinfo.cookies);
  let retried = 0;

  /**
   * A20：只在「端口通但 cookie 读不全」时重试 —— 这是冷启动的指纹。
   * 判据：cookies 为空数组，或 required 的关键项一个都不在（说明可能还没载入完）。
   */
  const looksCold = pinfo.cookies !== null && (pinfo.cookies.length === 0 || (t.required?.length && a.kind === "noauth"));
  if (looksCold && t.required?.length) {
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      retried++;
      const again = await readProfile(t.port, { fresh: true });
      a = assessTarget(t, again.cookies);
      if (a.kind !== "noauth" && again.cookies?.length) break;
    }
  }
  kind = a.kind;
  let detail = a.detail;
  let usable = a.usable;
  let source = pinfo.cookies ? "profile" : "none";

  /**
   * ⭐ 闪购兜底：仅 kind='noauth'（缺关键 cookie）才考虑，**不救 dead**。
   *    `dead` 意味着本域会话被服务端清空，那不是静态文件能补的。
   *    `file.expired` 为真时也不放行 —— 一份过期快照救不了任何人。
   */
  if (t.staticFallback && kind === "noauth") {
    if (file.has && !file.expired) {
      kind = "ok-static";
      source = "static";
      usable = "🟡 仅文件";
      detail =
        `${a.detail}；但 .secrets/${t.stem}.cookie.txt 是 ${file.ageText}更新的同源快照，` +
        `取数链路（loadCookieSmart）会回退到它 → 视为可用`;
    } else {
      detail = a.detail + `；静态文件${file.has ? "已过期" : "不存在"}，无处回退 → 需重新登录`;
    }
  }

  return {
    target: t,
    kind,
    source,
    detail,
    keyInfo: a.keyInfo,
    usable,
    deadSession: a.deadSession,
    parentOnly: !!a.parentOnly,
    counts: a.counts,
    file,
    browser: pinfo.error ? null : pinfo.browser,
    tabs: pinfo.tabs,
    portError: pinfo.error,
    retried,
  };
}

/**
 * 静态 cookie 文件的状态（默认只作展示；`staticFallback` 的闪购会拿它兜底）。
 *
 * `expired`：从文件 mtime 粗判 —— 闪购静态文件是每次成功取数时刷新的，
 * 超过 `STATIC_TTL_DAYS` 天没刷新，说明取数链路自己都拿不到新票据了，不能再当正本。
 */
export const STATIC_TTL_DAYS = 3;
export function staticFileState(path) {
  if (!existsSync(path)) return { has: false, text: "无文件", ageDays: null, ageText: "", expired: true };
  const ageDays = (Date.now() - statSync(path).mtimeMs) / DAY;
  const ageText = `${ageDays.toFixed(1)} 天前`;
  return { has: true, text: `有（${ageText}）`, ageDays, ageText, expired: ageDays > STATIC_TTL_DAYS };
}
