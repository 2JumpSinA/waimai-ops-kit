"""美团外卖推广后台（ka.waimai.meituan.com）余额取数。

技术形态（已实测确认）：
- 网关 openresty 对 /account/r/queryAcctBalance 做 403 硬拦，
  签名 mtgsig 由页面内 H5guard SDK 生成且与请求强绑定 -> 逆向不划算。
- 对策：起 Chrome，注入用户 Cookie，先打开站点让 H5guard 初始化并让页面
  自己把余额拉出来（这一步同时证明签名链路已通），再在页面上下文里 fetch。
- 兜底：直接读页面渲染出来的「账户余额」文案。

实测返回结构（单位：元，无 100 倍量纲问题）：
    {"msg":"Success","code":0,
     "data":{"balance":{"primaryBalance":220.81,"balance":220.81,
                        "commonBalance":0.0,"fundDetailMap":{...}}}}

登录态自查：`/acct/info` 不被签名网关拦，未登录时干净返回 code=-1002。
所以它能用来区分「Cookie 过期（要重新登录）」和「签名失败（要等页面就绪）」，
这两种故障的处理方式完全不同。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from core import extract
from core.browser import Chrome, resolve_browser, resolve_browser_for, BrowserError
from core.netutil import extract_cookie_header
from platforms.base import BalanceResult, CookieExpired, NotConfigured, TransientError

CRED_KEY = "meituan_cookie"

# 接口返回的 primaryBalance/balance 本身即「元」，不需要再缩放。
RETURNS_YUAN = True


def curl_key_of(key: str) -> str:
    """来源请求快照也按账号分开存，否则多账号时会被互相覆盖。"""
    return f"{key}_curl"


def save_credential(store, text: str, cfg: dict,
                    cred_key: str | None = None, key: str = "meituan") -> tuple[bool, str]:
    cred_key = cred_key or CRED_KEY
    header, dropped, req = extract_cookie_header(text)
    if not header:
        return False, ("没能从粘贴的内容里找到 Cookie。请确认复制的是"
                       "「已登录状态」下的请求（右键 → 复制 → 以 cURL 格式复制）。")

    store.set(cred_key, header)
    if req:
        store.set(curl_key_of(key), json.dumps(
            {"url": req.url, "method": req.method, "headers": req.headers},
            ensure_ascii=False))

    msg = f"已保存美团凭据：{len(header.split(';'))} 个 Cookie 项"
    if dropped:
        msg += f"（已剔除非 ASCII 项：{', '.join(dropped)}）"
    if req:
        msg += f"；来源请求 {req.url[:90]}"
    return True, msg


# ---------------------------------------------------------------- 取数

_JS_FETCH = """(async () => {
  const url = %s;
  try {
    const r = await fetch(url, {
      method: 'GET', credentials: 'include',
      headers: {'Accept': 'application/json, text/plain, */*'}
    });
    const t = await r.text();
    return JSON.stringify({status: r.status, body: t.slice(0, 4000)});
  } catch (e) {
    return JSON.stringify({status: -1, body: String(e)});
  }
})()"""

_JS_BODY_TEXT = "document.body ? document.body.innerText.slice(0, 40000) : ''"

# 页面渲染出「余额」说明两件事已经成立：SPA 挂载完成 + 页面自己的余额请求
# 成功。后者意味着 H5guard 的签名链路已经通了，此时再调接口才稳。
# 只用 `typeof window.H5guard !== 'undefined'` 判断是不够的 —— 对象存在
# 不等于初始化完成，抢跑会拿到 403，然后被迫降级到读页面文案。
_JS_READY = "(document.body && document.body.innerText.indexOf('余额') >= 0) ? 1 : 0"


# 美团把「会话没了」表达成两个码：-1002（未登录）和 -1000（登录信息失效）。
# 2026-10-19 只认 -1002 的写法把 -1000 判成了 logged_in，于是「该重新登录」
# 被当成「可以重试」——每次白重试 3 轮、耗掉 ~250s，把采集器的 180s 超时撑爆，
# 整批结果（3 个账号明明取到了）来不及落盘，群里的「数据陈旧」就这么连续报了 50 次。
_EXPIRED_CODES = {-1000, -1002}
_EXPIRED_WORDS = ("登录信息失效", "登录已失效", "未登录", "Session过期", "session过期")


def _login_state(br, sid: str, gateway: str) -> tuple[str, str]:
    """用 /acct/info 判定登录态，返回 (verdict, detail)。

    verdict 取值：logged_in / expired / unknown。

    这是本模块头部写明的判别器：/acct/info 不被签名网关拦，未登录时干净返回
    code=-1002（会话失效是 -1000）。不查它、只凭「接口报错里有没有 403」去猜，
    就会把网络重置 / 页面未就绪误报成「登录已失效」，让人白跑一趟重新登录 ——
    2026-09-18 与 09-19 连续两天早上 09:00 的定时播报都这样误报过（同一个
    Cookie，十几分钟后再跑就正常了）。

    反过来也不成立：把「过期」误判成「正常」代价更大（见 _EXPIRED_CODES 注释）。
    除 0 以外的其它业务码一律返回 unknown —— 让调用方按「可重试」处理，
    比硬塞进 logged_in 诚实。
    """
    url = gateway.rstrip("/") + "/acct/info"
    try:
        res = br.js(_JS_FETCH % json.dumps(url), sid, await_promise=True, timeout=20)
        obj = json.loads(res or "{}")
        if obj.get("status") != 200:
            return "unknown", f"status={obj.get('status')} {str(obj.get('body'))[:120]}"
        payload = json.loads(obj.get("body") or "{}")
        code = payload.get("code")
        msg = str(payload.get("msg") or "")
        if code in _EXPIRED_CODES or any(w in msg for w in _EXPIRED_WORDS):
            return "expired", f"code={code} msg={msg}"
        if code not in (0, "0", None):
            return "unknown", f"code={code} msg={msg}"
        return "logged_in", f"code={code} msg={msg}"
    except Exception as e:                                # noqa: BLE001
        return "unknown", f"{type(e).__name__}: {e}"


def _expired_hint(key: str) -> str:
    """凭据过期的报错要直接给出「下一步敲什么」，否则用户只能看到一串英文。"""
    plat = key.replace("_", "-")
    # 提示里的目录必须是**这份代码实际所在**的目录，不能写死某个人的部署路径
    proj = Path(__file__).resolve().parents[1]
    return (f"登录已失效，请重新注入 Cookie：python bot.py set-{plat}"
            f"（或在 {proj} 下双击对应的「续期…cmd」，若随包提供）")


def _extract_balance(payload: dict) -> tuple[float | None, str]:
    """从接口返回里取余额。

    实测返回结构（单位：元，无 100 倍量纲问题）：
        {"msg":"Success","code":0,
         "data":{"balance":{"primaryBalance":220.81,"balance":220.81,
                            "commonBalance":0.0,"fundDetailMap":{...}}}}
    优先走这条精确路径；结构变了再退回模糊查找。
    """
    d = payload.get("data")
    if isinstance(d, dict):
        b = d.get("balance")
        if isinstance(b, dict):
            for k in ("balance", "primaryBalance"):
                v = b.get(k)
                if isinstance(v, (int, float)):
                    return float(v), f"接口 data.balance.{k}"
    val, keyname = extract.pick_balance_field(payload)
    if val is not None:
        return val, f"接口字段 {keyname}（模糊匹配）"
    return None, ""


def _merge_cookie_refresh(old_pairs: list[tuple[str, str]], fresh: list[dict]) -> str:
    """把浏览器 cookie 罐里刷新后的值合并成一条 header。

    以**浏览器里的新值**优先（那是服务端刚下发的 Set-Cookie），旧值里浏览器没提到的保留。
    与 `ele.py` 的「token 续期后写回」是同一个思路，只是美团这边要自己把罐子读回来 ——
    它的取数是「页面内 fetch」，JS 拿不到响应的 Set-Cookie，得从 CDP 的 cookie 罐里回读。
    """
    merged: dict[str, str] = {n: v for n, v in old_pairs}
    for c in fresh:
        name = str(c.get("name") or "")
        if name:
            merged[name] = str(c.get("value") or "")
    return "; ".join(f"{k}={v}" for k, v in merged.items())


# ---- 阿里系 cookie 名字（美团路径要反向剔除）--------------------------
#
# ⛔ 为什么需要：`profile_cookie.fetch_profile_cookies(port)` 返回**整个 profile**
#    所有域的 cookie。品牌B profile 里混着阿里系的大项 —— 实测
#    `elt`=1890B、`lt`=1631B、`tfstk`=481B，三项合计 4002B。
#    把它们注入 `ka.waimai.meituan.com`，服务端回
#    `400 Request Header Or Cookie Too Large`。
#
# 判据用「名字特征」而不是精确白名单：美团自己的 cookie 名无法穷举，
# 但阿里系的特征明显（`_m_h5_*` 令牌对、饿了么/闪购专用名、`elt`/`lt` 埋点）。
# 多丢一个无关项无害；留下一个几千字节的项就会 400。
#
# ⭐ 单一事实源：`share/ele-cookie-names.json`（sha256 AC45984D…0931，与
#    WorkBuddy\share\ 同一份）。本 frozenset 只是 **fail-safe 内置副本**。
#    子串判据（substring_patterns）也在 JSON 里，见 _load_substring_patterns。
_MEITUAN_NAMES_FALLBACK = frozenset({
    "_m_h5_tk", "_m_h5_tk_enc", "WMSTOKEN", "WMUSS", "cna", "cnaui", "tfstk",
    "isg", "xlly_s", "arms_uid", "nr_alpha_grey", "__ebg_utdid",
    "mtop_partitioned_detect", "__wpkreporterwid_", "OUTER_AUTH_LOGIN",
    "elt", "lt", "cookie2", "_l_g_", "sgcookie", "munb", "x5sec",
    "uc1", "uc3", "uc4", "biz_token",
})
_SUBSTR_FALLBACK = ("ele.me", "eleme", "nrshop", "nracc")


def _load_names() -> tuple[frozenset, tuple]:
    """从 share/ele-cookie-names.json 读白名单+子串；读不到回退内置副本。"""
    import json as _json
    from pathlib import Path as _P
    try:
        j = _json.loads((_P(__file__).resolve().parent.parent
                         / "share" / "ele-cookie-names.json").read_text("utf-8"))
        return frozenset(j["names"]), tuple(j.get("substring_patterns") or _SUBSTR_FALLBACK)
    except Exception:
        return _MEITUAN_NAMES_FALLBACK, _SUBSTR_FALLBACK


ELE_COOKIE_NAMES, ELE_SUBSTRINGS = _load_names()


def _is_ele_cookie(name: str) -> bool:
    """这个名字是不是阿里系（饿了么 / 淘宝闪购）的？"""
    n = (name or "").strip()
    if n in ELE_COOKIE_NAMES:
        return True
    low = n.lower()
    return any(s in low for s in ELE_SUBSTRINGS)


def _cookies_from(store, cred_key: str, key: str = "meituan") -> list[tuple[str, str]]:
    raw = store.get(cred_key)
    if not raw:
        raise NotConfigured(f"未配置美团凭据，请先执行："
                            f"python bot.py set-{key.replace('_', '-')}")
    out = []
    for item in raw.split(";"):
        item = item.strip()
        if "=" in item:
            k, _, v = item.partition("=")
            k = k.strip()
            if _is_ele_cookie(k):
                continue        # 阿里系的大项，绝不能注入美团域（见上方注释）
            out.append((k, v.strip()))
    return out


def fetch_balance(cfg: dict, store, key: str = "meituan",
                  cred_key: str | None = None) -> BalanceResult:
    cred_key = cred_key or CRED_KEY
    mcfg = cfg.get("meituan", {})
    gateway = mcfg.get("gateway", "https://ka.waimai.meituan.com").rstrip("/")
    api = mcfg.get("api_balance", "/account/r/queryAcctBalance")
    home = mcfg.get("home_url", gateway + "/new#/newhome")
    chrome_exe = resolve_browser_for(cfg, key, mcfg)
    port = int(mcfg.get("cdp_port", 9226))
    ua = mcfg.get("user_agent")

    pairs = _cookies_from(store, cred_key, key)

    notes, api_error = [], None
    prov: list[str] = []
    with Chrome(chrome_exe, user_agent=ua, port=port) as br:
        sid = br.new_page("about:blank")
        injected = br.set_cookies(pairs, gateway + "/", sid)
        if injected == 0:
            raise CookieExpired("Cookie 注入失败，请重新执行 set-meituan 注入")

        # 必须先真的打开站点页面，H5guard 才会初始化
        br.goto(home, sid, wait=2.5)

        # 先判登录态，再等页面。
        # 为什么顺序重要：凭据过期时首页会停在登录页 —— H5guard 等不到（白等
        # 20s）、「余额」也永远不会出现（再白等 45s）。而采集器给整条命令只留
        # 180s（dsh-app/wecom-fastlane/commands.json → timeoutMs），一次白等就
        # 吞掉三分之一，叠加 retry 直接超时 → 连快照都写不出来 → 群里报「数据
        # 陈旧」。过期在这里 10s 内就能定性，把预算留给真正能取数的账号。
        # 注：/acct/info 不被签名网关拦，此时还没等到 H5guard 也能问出结论。
        verdict, detail = _login_state(br, sid, gateway)
        if verdict == "expired":
            # 复核一次：单次偶发误判会让人白登录一趟（09-18 的教训）
            time.sleep(3)
            verdict2, detail2 = _login_state(br, sid, gateway)
            if verdict2 == "expired":
                raise CookieExpired(f"{_expired_hint(key)}（登录态自查：{detail2}）")
            verdict, detail = verdict2, detail2

        br.wait_for("typeof window.H5guard !== 'undefined'", sid, timeout=20)

        # 等页面自己把余额渲染出来：这同时也证明签名链路已经通了
        ready = br.wait_for(_JS_READY, sid, timeout=45)
        if not ready:
            notes.append("等待页面渲染超时")

        # 路径 1：页面内 fetch（签名由 H5guard 自动附加）
        balance, raw = None, None
        try:
            res = br.js(_JS_FETCH % json.dumps(gateway + api), sid,
                        await_promise=True, timeout=45)
            obj = json.loads(res or "{}")
            raw = obj
            if obj.get("status") == 200:
                payload = json.loads(obj.get("body") or "{}")
                val, how = _extract_balance(payload)
                if val is not None:
                    balance = val
                    prov.append(how)
                else:
                    api_error = (f"接口 200 但没解析出余额，"
                                 f"code={payload.get('code')} msg={payload.get('msg')} "
                                 f"结构={json.dumps(payload)[:200]}")
            elif obj.get("status") == 403:
                api_error = "接口 403（签名未生效）"
            else:
                api_error = (f"接口 status={obj.get('status')} "
                             f"{str(obj.get('body'))[:160]}")
        except Exception as e:                            # noqa: BLE001
            api_error = f"{type(e).__name__}: {e}"

        # 路径 2：DOM 兜底 —— 页面渲染出来的数字
        dom_amount = None
        if balance is None:
            try:
                text = br.js(_JS_BODY_TEXT, sid) or ""
                dom_amount, lab = extract.money_near_label(text)
                if dom_amount is not None:
                    balance = dom_amount
                    prov.append(f"页面文案「{lab}」")
                    # 降级必须留痕：否则接口坏了永远不知道，只看到数字在动
                    notes.append(f"改由页面文案取值（接口未用上：{api_error or '未知原因'}）")
            except Exception as e:                        # noqa: BLE001
                notes.append(f"DOM 兜底失败：{type(e).__name__}")

        if balance is None:
            # 先查登录态，再决定这是「要重新登录」还是「可以重试」。
            # 原来的写法是「报错里没有 403 → 登录已失效」，而 api_error 可能
            # 只是 ConnectionResetError / 页面没就绪，于是天天误报。
            verdict, detail = _login_state(br, sid, gateway)
            if verdict == "expired":
                raise CookieExpired(f"{_expired_hint(key)}（登录态自查：{detail}）")
            # logged_in / unknown：凭据本身没问题，是签名或页面就绪的问题。
            raise TransientError(
                f"页面未就绪或连接被重置，可重试（登录态自查={verdict}：{detail}；"
                f"接口：{api_error}；页面就绪={ready}）")

        # ---- 取完数回读一次 cookie（2026-09-21 加，对应 ele.py 的「token 续期后写回」）----
        # 为什么要：美团接口在响应里也可能刷新会话（Set-Cookie），而本地凭据还是旧的 ——
        # 旧的用久了会被服务端判定失效，就得人工重新捕获一次。
        # 为什么放在这里：只有**取数成功**才会走到（上面 balance is None 的分支已经 raise），
        # 所以回读到的必然是「当前有效」的那份，不会把坏的 cookie 写回凭据。
        # 为什么从 cookie 罐读而不是读响应头：走的是「页面内 fetch」，JS 拿不到 Set-Cookie。
        try:
            fresh = br.cookies_for([gateway + "/"], sid)
            if fresh:
                merged = _merge_cookie_refresh(pairs, fresh)
                if merged and merged != (store.get(cred_key) or ""):
                    store.set(cred_key, merged)
                    notes.append("已回写刷新后的 cookie")
                    prov.append(f"回写 {len(fresh)} 项")
        except Exception as e:                            # noqa: BLE001
            notes.append(f"回读 cookie 失败（不影响取数）：{type(e).__name__}")

    return BalanceResult(key="meituan", display_name="美团", balance=float(balance),
                         raw=raw,
                         note="；".join(notes) or None,
                         provenance="；".join(prov) or None)
