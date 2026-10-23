"""淘宝闪购零售商家版（推广账户）余额取数。

技术形态（已实测确认，接口名与字段均来自真实抓包）：

链路分三步，全部用纯 requests，不需要浏览器：

1) MTOP（`nrshop.ele.me`）：拿用户信息
   POST/GET /h5/mtop.ele.newretail.ebai.accountreadmtopservice.getshopuserinfo/1.0/
   -> data.data.eleSoaToken   ← 这就是后续网关要的 ksid（**每次调用都会变**，必须现取）

   签名可自算：sign = md5(token & t & appKey & data)，token = cookie['_m_h5_tk'] 的下划线前段。
   这条已用「用户实际请求里的 sign」反推验证过，完全一致。

2) MTOP：拿 chainId
   /h5/mtop.eleme.newretail.shop.admin.ebai.base.shop.getloginentity/1.0/
   -> data.data.entity.chainId（供应商 entityType=20）

3) ALSC 网关（`agw.ele.me`）：拿余额
   POST /gw/h5api/alsc-ad-account.IGwBalanceService.findBalanceInfo?source=NR_EBAI&h=<host>
   Header: ksid=<eleSoaToken>, current-shop-id=<chainId>
   -> result.detail.balance  ← **单位是「分」**，要 /100
      result.totalYuan       ← 元，可直接用（与上者互为校验）

   页面「账户总余额」= 连锁店余额（findBalanceInfo） + 分店余额（findLeafShopBalanceInfoAsync）

几个坑（都踩过，注释留存）：
- `ksid` 不是 cookie 里的 `o2o_ad_ksid`，而是 eleSoaToken，两者值不同。
- `loginId` / `current-shop-id` 必须是数字，传 token 会 500 NumberFormatException。
- 余额是「分」，不除 100 会让预警形同虚设（49043 当成 49043 元）。
- 若 Cookie 只注入到 nr.ele.me，接口域名 nrshop.ele.me 拿不到登录态，
  MTOP 会返回 FAIL_SYS_SESSION_EXPIRED —— 纯 requests 路径不受影响（Cookie 是整串发的），
  但浏览器兜底路径必须按域级（.ele.me）注入。
- 页面引导阶段会调 mtop.alsc.user.session.ele.check，该接口在本账号下返回「需要登录」，
  应用据此调用 nracc.ele.me/api/security/logout 并跳登录页。浏览器兜底时需把登出请求桩掉。
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from urllib.parse import urlencode

import requests

from core import extract
from core.browser import Chrome, resolve_browser, resolve_browser_for
from core.loginflow import ANTI_AUTO_JS, LOGOUT_STUB_JS
from core.netutil import extract_cookie_header
from platforms.base import BalanceResult, CookieExpired, NotConfigured

CRED_KEY = "ele_cookie"

# 本模块返回的余额已是「元」（detail.balance 的分已在内部 ÷100）。
# 声明出去，防止 bot.fetch_one 再按 unit_divisor 除一次。
RETURNS_YUAN = True
CREDS_DIR = Path(__file__).resolve().parent.parent / "creds"

DEFAULT_MTOP_HOST = "https://nrshop.ele.me"
DEFAULT_AGW_HOST = "https://agw.ele.me/gw/h5api"
DEFAULT_AGW_APP_HOST = "doujin-isv-manage.faas.ele.me"
APPKEY = "12574478"

API_USERINFO = "mtop.ele.newretail.ebai.accountreadmtopservice.getshopuserinfo"
API_LOGINENTITY = "mtop.eleme.newretail.shop.admin.ebai.base.shop.getloginentity"
API_BALANCE = "alsc-ad-account.IGwBalanceService.findBalanceInfo"
API_LEAF_BALANCE = "alsc-ad-account.IGwBalanceService.findLeafShopBalanceInfoAsync"

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")


# ---------------------------------------------------------------- 账户快照

def account_file(key: str) -> Path:
    """每个账号一份快照。

    早先写死成 ele_account.json，多账号之后会互相覆盖 —— 排查「这个余额
    到底是谁的」时，看到的就成了另一个账号的名字，比没有快照更误导。
    """
    return CREDS_DIR / f"{key}_account.json"


def save_account(info: dict, key: str = "ele") -> None:
    """把最近一次解析出的账号信息落盘，便于 status 里排查。"""
    try:
        p = account_file(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(info, ensure_ascii=False, indent=2),
                     encoding="utf-8")
    except Exception:
        pass


def load_account(key: str = "ele") -> dict:
    p = account_file(key)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


# ---------------------------------------------------------------- 凭据注入

def save_credential(store, text: str, cfg: dict,
                    cred_key: str | None = None, key: str = "ele") -> tuple[bool, str]:
    cred_key = cred_key or CRED_KEY
    header, dropped, req = extract_cookie_header(text)
    if not header:
        return False, ("没能从粘贴的内容里找到 Cookie。请确认复制的是"
                       "「已登录状态」下的请求（右键 → 复制 → 以 cURL 格式复制）。")
    store.set(cred_key, header)

    ck = _cookie_dict(header)
    msg = f"已保存淘宝闪购凭据：{len(header.split(';'))} 个 Cookie 项"
    missing = [k for k in ("_m_h5_tk", "OUTER_AUTH_LOGIN", "WMUSS", "WMSTOKEN")
               if not ck.get(k)]
    if missing:
        msg += f"；⚠️ 缺少关键项 {', '.join(missing)}（很可能不是已登录状态的请求）"
    else:
        msg += "；关键项齐全（_m_h5_tk / OUTER_AUTH_LOGIN / WMUSS / WMSTOKEN）"
    if dropped:
        msg += f"；已剔除非 ASCII 项：{', '.join(dropped)}"
    return True, msg


# ---------------------------------------------------------------- MTOP

def _cookie_dict(raw: str) -> dict:
    d = {}
    for item in (raw or "").split(";"):
        item = item.strip()
        if "=" in item:
            k, _, v = item.partition("=")
            d[k.strip()] = v.strip()
    return d


# ---- 阿里系 cookie 白名单（按域过滤用的）------------------------------
#
# ⛔ 为什么必须有它：`profile_cookie.fetch_profile_cookies(port)` 返回的是
#    **整个浏览器 profile 所有域**的 cookie（实测 9223 上 8529 字节 / 30+ 项），
#    其中混着大量**美团**的东西（`.MSA.Auth` 411B、`_U` 236B、`SRCHUID`、
#    `WLS`、`atpsida`…）。整串原样发给 `nrshop.ele.me`，网关直接回
#    `HTTP 431 header field too large`（报文里那个 "864" 是它自己的报错格式，
#    不是真实上限，别被带偏）。
#
# ✔ 实测：只发下面这些（954 字节 / 12 项）→ MTOP 返回 SUCCESS::调用成功。
#
# 注意 `tfstk` 单项就占 481B，是体积大头，但它是阿里风控埋点、MTOP 可能校验，
# **不要为了瘦身删它** —— 954B 完全在合理范围内，删它是另一种坑。
#
# ⭐ 单一事实源：`share/ele-cookie-names.json`（sha256 AC45984D…0931，与
#    WorkBuddy\share\ 同一份）。本 frozenset 只是 **fail-safe 内置副本**——
#    JSON 读不到时兜底。改名单请改 JSON 并同步两处，不要只改这里。
_ELE_NAMES_FALLBACK = frozenset({
    "_m_h5_tk", "_m_h5_tk_enc", "WMSTOKEN", "WMUSS", "cna", "tfstk", "isg",
    "xlly_s", "arms_uid", "nr_alpha_grey", "__ebg_utdid", "mtop_partitioned_detect",
    "__wpkreporterwid_", "OUTER_AUTH_LOGIN", "cookie2", "_l_g_", "sgcookie",
    "munb", "x5sec", "uc1", "uc3", "uc4", "biz_token",
})


def _load_names() -> frozenset:
    """从 share/ele-cookie-names.json 读白名单；读不到回退内置副本。"""
    import json as _json
    from pathlib import Path as _P
    try:
        j = _json.loads((_P(__file__).resolve().parent.parent
                         / "share" / "ele-cookie-names.json").read_text("utf-8"))
        return frozenset(j["names"])
    except Exception:
        return _ELE_NAMES_FALLBACK


ELE_COOKIE_NAMES: frozenset[str] = _load_names()


def _filter_ele_cookies(raw: str) -> str:
    """把整串 cookie 过滤成「只含阿里系已知名字」的一串。

    - 名字不在白名单里 → 丢弃（美团域的东西全在这里被剔掉）
    - 白名单名字但值含非 ASCII → **也丢弃**：Node 那边会为这个抛
      `Invalid character in header content`，Python requests 则会把它按
      latin-1 编码发出去、变成乱码，同样报非法请求。
    - 一个都没剩 → 原样返回（宁可让上层报真实错误，也不要把问题藏起来）
    """
    kept: list[str] = []
    for item in (raw or "").split(";"):
        item = item.strip()
        if "=" not in item:
            continue
        k, _, v = item.partition("=")
        k = k.strip()
        if k not in ELE_COOKIE_NAMES:
            continue
        try:
            v.encode("ascii")
        except UnicodeEncodeError:
            continue
        kept.append(f"{k}={v.strip()}")
    return "; ".join(kept) if kept else raw


def _sign(token: str, t: str, appkey: str, data: str) -> str:
    return hashlib.md5(f"{token}&{t}&{appkey}&{data}".encode("utf-8")).hexdigest()


def mtop_call(api: str, appkey: str, data: str, cookie_raw: str,
              host: str = DEFAULT_MTOP_HOST, attempts: int = 3) -> tuple[dict, str]:
    """调 MTOP。token 失效时自动续期并重试。返回 (响应 JSON, 最新 cookie)。"""
    last_ret = ""
    for _ in range(attempts):
        ck = _cookie_dict(cookie_raw)
        tk = ck.get("_m_h5_tk", "")
        if not tk:
            # ②a-1 自举：profile 正本里没有 _m_h5_tk（它是 MTOP 首次请求时
            # 服务端 Set-Cookie 下发的运行时票据，浏览器里 browse 出来时通常
            # 不存在）。MTOP 的标准自举就是「不带 token 先发一次」：服务端
            # 返回 FAIL_SYS_TOKEN_EMPTY 并在 Set-Cookie 下发新令牌对，走下面
            # 第 196 行的既有重试逻辑完成自愈。直接 raise 会让正本路径永远
            # 起不来 —— 缓存时代 token 总在（30 分钟有效、每天一跑前次留的），
            # profile 时代这是首跑必经之路。
            token = ""
        else:
            token = tk.split("_")[0]
        t = str(int(time.time() * 1000))
        params = {
            "jsv": "2.7.2", "appKey": appkey, "t": t,
            "sign": _sign(token, t, appkey, data),
            "api": api, "v": "1.0", "type": "originaljson",
            "dataType": "json", "data": data,
        }
        url = f"{host}/h5/{api}/1.0/?" + urlencode(params)
        r = requests.get(url, headers={
            # ⛔ 必须过滤：cookie_raw 可能来自整个 profile（混着美团域的
            # `.MSA.Auth`/`_U` 等），整串发出去会被网关回 431。
            # 见 `_filter_ele_cookies` 的注释与实测数据。
            "Cookie": _filter_ele_cookies(cookie_raw),
            "User-Agent": _UA,
            "Referer": f"{host}/",
        }, timeout=25)
        try:
            obj = r.json()
        except Exception:
            raise CookieExpired(
                f"MTOP 返回非 JSON（HTTP {r.status_code}）：{r.text[:150]}")

        ret = (obj.get("ret") or [""])[0]
        last_ret = ret
        # MTOP 的令牌是「一对」：_m_h5_tk（参与签名）+ _m_h5_tk_enc（配对校验）。
        # 服务端轮换时两个一起下发，客户端也必须一起更新。
        # 只换前者会让两者失配 —— 服务端回 FAIL_SYS_TOKEN_ILLEGAL（非法令牌），
        # 而且重试永远好不了（因为每次都在用一个错配的令牌对）。
        # 这个坑很隐蔽：令牌有效期约 30 分钟，而播报每天只跑一次，
        # 所以实际上「每一次运行」都会走到轮换这条路 —— 修不好就等于天天失败。
        sc = r.headers.get("Set-Cookie", "")
        new_tk = _sck(sc, "_m_h5_tk")
        new_enc = _sck(sc, "_m_h5_tk_enc")

        def _sync_token(raw: str) -> str:
            if new_tk and new_tk != _cookie_dict(raw).get("_m_h5_tk"):
                raw = _replace_cookie(raw, "_m_h5_tk", new_tk)
            if new_enc:
                raw = _replace_cookie(raw, "_m_h5_tk_enc", new_enc)
            return raw

        if ret.startswith("SUCCESS"):
            return obj, _sync_token(cookie_raw)

        if (new_tk or new_enc) and ("TOKEN" in ret or "ILLEGAL_ACCESS" in ret):
            cookie_raw = _sync_token(cookie_raw)
            time.sleep(0.6)
            continue
        break

    up = last_ret.upper()
    if "SESSION_EXPIRED" in up or "TOKEN" in up or "ILLEGAL" in up or "SESSION" in up:
        raise CookieExpired(f"MTOP 登录态失效：{last_ret}")
    raise RuntimeError(f"MTOP 调用失败：{last_ret}")


def _sck(set_cookie: str, name: str) -> str:
    for part in (set_cookie or "").split(","):
        part = part.strip()
        if part.startswith(name + "="):
            return part.split(";")[0].split("=", 1)[1]
    return ""


def _replace_cookie(raw: str, name: str, value: str) -> str:
    parts = [p.strip() for p in raw.split(";") if p.strip()]
    out = [p for p in parts if not p.startswith(name + "=")]
    out.append(f"{name}={value}")
    return "; ".join(out)


# ---------------------------------------------------------------- ALSC 网关

def agw_call(apikey: str, params: list, ksid: str, chain_id, cookie: str,
             host: str, app_host: str, source: str) -> dict:
    url = f"{host}/{apikey}?source={source}&h={app_host}"
    r = requests.post(url, json={"params": params}, timeout=25, headers={
        # ⛔ 与 mtop_call 同理：整串 cookie 可能混着美团域的大项，会把
        # header 撑破 → `400 Request header or cookie too large`。
        # 见 `_filter_ele_cookies` 的注释与实测数据。
        "Cookie": _filter_ele_cookies(cookie),
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://{app_host}/",
        "Origin": f"https://{app_host}",
        "ksid": ksid,
        "current-shop-id": str(chain_id or ""),
        "User-Agent": _UA,
    })
    try:
        return r.json()
    except Exception:
        raise RuntimeError(f"网关返回非 JSON（HTTP {r.status_code}）：{r.text[:200]}")


# ---------------------------------------------------------------- 取数

def fetch_balance(cfg: dict, store, key: str = "ele",
                  cred_key: str | None = None) -> BalanceResult:
    # key     = config.platforms 里的账号键（决定快照文件名与提示语）
    # cred_key= 该账号的凭据键名。两个品牌各有各的登录态，不能共用。
    cred_key = cred_key or CRED_KEY
    cookie = store.get(cred_key)
    if not cookie:
        raise NotConfigured(f"未配置淘宝闪购凭据，请先执行："
                            f"python bot.py set-{key.replace('_', '-')}")

    ecfg = cfg.get("ele", {}) or {}
    pcfg = (cfg.get("platforms") or {}).get(key, {}) or {}
    mtop_host = ecfg.get("mtop_host") or DEFAULT_MTOP_HOST
    agw_host = ecfg.get("agw_host") or DEFAULT_AGW_HOST
    app_host = ecfg.get("agw_app_host") or DEFAULT_AGW_APP_HOST
    source = ecfg.get("agw_source") or "NR_EBAI"
    appkey = str(ecfg.get("mtop_appkey") or APPKEY)

    notes: list[str] = []       # 进推送文案：用户看了有用的话
    prov: list[str] = []        # 只在 verbose/日志出现：这个数字的来源

    # ---- 路径 1：纯接口 ----
    try:
        # 1) 用户信息 -> ksid
        obj, cookie = mtop_call(API_USERINFO, appkey, "{}", cookie, mtop_host)
        if cookie != store.get(cred_key):
            store.set(cred_key, cookie)                   # token 续期后写回
        info = (obj.get("data") or {}).get("data") or {}
        ksid = info.get("eleSoaToken") or ""
        if not ksid:
            raise RuntimeError(f"用户信息里没有 eleSoaToken：{json.dumps(obj)[:300]}")

        # 2) chainId
        obj2, cookie = mtop_call(API_LOGINENTITY, appkey, "{}", cookie, mtop_host)
        ent = ((obj2.get("data") or {}).get("data") or {})
        entity = ent.get("entity") or {}
        chain_id = entity.get("chainId")
        if not chain_id:
            # 非供应商上下文（entityType=30 中间商/总部）时没有 chainId。
            # 这种情况会随时间漂移：同一份 Cookie 用几小时后，服务端把会话退化成
            # 总部上下文，AGW 网关随即报「登录商户ID为空」（2026-10-19 实测：
            # 09:26 正常 → 13:37 最后一次成功 → 13:47 起全挂）。
            # 所以优先用配置里写死的供应商链 ID —— 只要会话本身没过期就能继续取数。
            configured = pcfg.get("supplier_chain_id")
            if configured:
                chain_id = configured
                prov.append(f"会话上下文漂移（entityType={ent.get('entityType')}），"
                            f"按配置 supplier_chain_id={configured} 取数")
            else:
                chain_id = info.get("merchantId") or info.get("eleId")
                prov.append("未取到 chainId，改用 merchantId")
        if not chain_id:
            raise RuntimeError("既没有 chainId 也没有 merchantId，无法定位账户")

        # ★ AGW 只认请求体里的 currentShopId（header current-shop-id 不够）：
        # 上下文漂移时，带上它就能强制按供应商链取余额，实测由 fail 变 success。
        # 非数字（极少见）就退回空参数，避免 500 NumberFormatException。
        try:
            shop_int = int(chain_id)
        except (TypeError, ValueError):
            shop_int = None
        bal_params = [{"currentShopId": shop_int}] if shop_int else [{}]

        save_account({
            "merchantName": info.get("merchantName"),
            "loginUserName": info.get("loginUserName"),
            "merchantId": info.get("merchantId"),
            "role": (info.get("role") or {}).get("name"),
            "entityType": ent.get("entityType"),
            "chainId": chain_id,
            "checkedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        }, key=key)

        # 3) 余额
        j = agw_call(API_BALANCE, bal_params, ksid, chain_id, cookie,
                     agw_host, app_host, source)
        # 兼容：若该账号/版本不认 currentShopId 参数，退回空参数再试一次
        if (not j.get("success")) and bal_params != [{}] \
                and "商户ID为空" in str(j.get("errorMsg") or ""):
            j = agw_call(API_BALANCE, [{}], ksid, chain_id, cookie,
                         agw_host, app_host, source)
            prov.append("currentShopId 不被接受，已回退空参数")
        if not j.get("success"):
            emsg = j.get("errorMsg") or j.get("errorCode") or "未知错误"
            if "登录" in str(emsg) or "权限" in str(emsg):
                raise CookieExpired(f"网关拒绝（{emsg}），登录态可能已失效")
            raise RuntimeError(f"余额接口失败：{emsg}")
        res = j.get("result") or {}
        detail = res.get("detail") or {}

        chain_yuan = None
        # 优先用 totalYuan（已是元，字符串）；否则用 detail.balance（分）
        ty = res.get("totalYuan")
        if ty not in (None, ""):
            try:
                chain_yuan = float(ty)
                prov.append("连锁店余额取 totalYuan（元）")
            except Exception:
                chain_yuan = None
        if chain_yuan is None and detail.get("balance") is not None:
            chain_yuan = float(detail["balance"]) / 100.0     # ★ 分 -> 元
            prov.append("连锁店余额取 detail.balance÷100（接口单位是分）")
        if chain_yuan is None:
            raise RuntimeError(f"余额字段缺失：{json.dumps(res, ensure_ascii=False)[:300]}")

        # 交叉校验：totalYuan 与 detail.balance/100 应一致
        if ty not in (None, "") and detail.get("balance") is not None:
            if abs(float(ty) - float(detail["balance"]) / 100.0) > 0.02:
                notes.append(f"⚠️ 两种口径不一致（totalYuan={ty}，"
                             f"balance/100={float(detail['balance'])/100:.2f}）")

        # 4) 分店余额（失败不致命，但要说明）
        leaf_yuan = 0.0
        try:
            j2 = agw_call(API_LEAF_BALANCE, bal_params, ksid, chain_id, cookie,
                          agw_host, app_host, source)
            inner = ((j2.get("result") or {}).get("result") or {})
            lv = inner.get("totalYuan")
            if lv not in (None, ""):
                leaf_yuan = float(lv)
                notes.append(f"分店余额 ¥{leaf_yuan:,.2f}")
            elif (j2.get("result") or {}).get("doing"):
                notes.append("分店余额仍在计算中，本次按 0 计")
        except Exception as e:                            # noqa: BLE001
            notes.append(f"分店余额取数失败（{type(e).__name__}），按 0 计")

        total = chain_yuan + leaf_yuan
        return BalanceResult(key="ele", display_name="淘宝闪购", balance=total,
                             raw=res,
                             note="；".join(notes) or None,
                             provenance="；".join(prov) or None)

    except CookieExpired:
        raise
    except Exception as e:                                # noqa: BLE001
        api_error = f"{type(e).__name__}: {e}"

    # ---- 路径 2：无头浏览器兜底（读页面渲染出的「账户总余额」）----
    notes.append(f"接口路径失败，改用页面兜底（{api_error[:120]}）")
    chrome_exe = resolve_browser_for(cfg, key, cfg.get("meituan"))
    with Chrome(chrome_exe, user_agent=(cfg.get("meituan") or {}).get("user_agent"),
                port=int((cfg.get("meituan") or {}).get("cdp_port", 9226)) + 5) as br:
        sid = br.new_page("about:blank")
        br.inject_on_new_document(ANTI_AUTO_JS, sid)
        br.inject_on_new_document(LOGOUT_STUB_JS, sid)
        # ★ 必须按域级注入：接口在 nrshop.ele.me / agw.ele.me，只注 nr.ele.me 会掉登录态
        br.set_cookies(list(_cookie_dict(cookie).items()), "https://nr.ele.me/",
                       sid, domain=".ele.me")
        br.goto(ecfg.get("home_url") or "https://bs-ka-app.faas.ele.me/chain.html",
                sid, wait=5.0)
        got = br.wait_for("document.body && document.body.innerText.indexOf('余额') >= 0",
                          sid, timeout=90)
        text = br.body_text(sid, 40000)
        val, lab = extract.money_near_label(text) if got else (None, None)
        if val is None:
            raise CookieExpired(
                "页面未渲染出余额。可能登录已失效。"
                f"页面文本片段：{text[:200]!r}")
        prov.append(f"页面文案「{lab}」")
        return BalanceResult(key="ele", display_name="淘宝闪购", balance=float(val),
                             note="；".join(notes),
                             provenance="；".join(prov) or None)
