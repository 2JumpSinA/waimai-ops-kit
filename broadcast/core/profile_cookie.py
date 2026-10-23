"""浏览器 profile 正本 cookie 读取（CDP 端口）。

定位（统一凭据模块 ②a-1）：
- 三个项目统一登录态来源：浏览器 profile（9222 Chrome=品牌A / 9223 Edge=品牌B）
  是**正本**；Windows 凭据管理器降级为**缓存**。
- 本模块只负责「从 CDP 端口把 cookie 读出来」，不含任何缓存写回逻辑
  （写回方向单向：profile → 缓存，缓存在 core/store.py 里落 keyring）。

实现要点：
- 探活：GET http://127.0.0.1:{port}/json/version。
  **必须禁用代理**：本机有全局代理 127.0.0.1:51243，若走 env 代理，
  对 127.0.0.1 的请求会被代理吞掉 —— 所以 requests 一律 trust_env=False，
  websocket 连接也不传任何 proxy 参数。
- 首选读法：连浏览器级 WS target（/json/version 的 webSocketDebuggerUrl），
  发 Network.getAllCookies —— 这是浏览器级接口，**能拿到 httpOnly cookie**
  （_m_h5_tk / UNIFACTION 系多为 httpOnly，document.cookie 拿不到）。
- 降级读法：/json 列出 target，挑一个 page，Runtime.evaluate 执行
  document.cookie。**已知局限：document.cookie 读不到 httpOnly cookie**，
  所以这只在 WS 的 Network.getAllCookies 不可用时作为兜底，命中它时
  会在返回里带不出关键票据 —— 调用方应把「关键 cookie 缺失」如实报出来。
- 失败语义：重试 3 次 × 间隔 1 秒，单次超时 2 秒；端口不通 / 超时 /
  任何异常 → 返回 None，**绝不抛异常打断主流程**。
- 快照落盘：creds/profile-snapshot-{port}.json（含 fetchedAt 与 cookie），
  临时文件 + rename 原子写入。快照只在本模块被「成功读取」时更新；
  缓存（keyring）永远不允许写进快照。
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path

import requests

RETRY_ATTEMPTS = 3
RETRY_INTERVAL_SEC = 1.0
TIMEOUT_SEC = 2.0

_CREDS_DIR = Path(__file__).resolve().parent.parent / "creds"


# ---------------------------------------------------------------- 探活

def _no_proxy_session() -> "requests.Session":
    """禁代理会话：trust_env=False 必须设在 Session 属性上（捆绑版 requests
    的 requests.get() 不接受 trust_env 关键字参数，传了会 TypeError —— 曾导致
    探活恒失败、端口恒显示 DOWN）。"""
    s = requests.Session()
    s.trust_env = False
    s.proxies = {"http": None, "https": None}
    return s


def probe_port(port: int) -> bool:
    """单次探活：/json/version 可达即认为 CDP 在。任何异常 = False。"""
    try:
        r = _no_proxy_session().get(f"http://127.0.0.1:{port}/json/version",
                                    timeout=TIMEOUT_SEC)
        return r.status_code == 200
    except Exception:                                    # noqa: BLE001
        return False


# ---------------------------------------------------------------- WS 基元

def _ws_call(ws_url: str, method: str, params: dict | None = None) -> dict | None:
    """对某个 WS target 发一条 CDP 命令并等回包。失败返回 None。"""
    try:
        from websocket import create_connection, WebSocketTimeoutException
    except Exception:                                    # noqa: BLE001
        return None
    ws = None
    try:
        # 不传 http_proxy_host / proxy 相关参数：websocket-client 默认不走
        # 环境代理，这里显式保持默认，确保 127.0.0.1 直连。
        ws = create_connection(ws_url, timeout=TIMEOUT_SEC)
        ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        deadline = time.monotonic() + TIMEOUT_SEC
        while time.monotonic() < deadline:
            try:
                msg = json.loads(ws.recv())
            except Exception:                            # noqa: BLE001
                return None
            if msg.get("id") == 1:
                return msg
        return None
    except Exception:                                    # noqa: BLE001
        return None
    finally:
        if ws is not None:
            try:
                ws.close()
            except Exception:                            # noqa: BLE001
                pass


def _entries_via_ws_browser(ws_url: str) -> list[dict] | None:
    """浏览器级 WS target 读全量 cookie（含 httpOnly）。

    优先 Storage.getCookies —— Chrome 155 已移除 Network.getAllCookies
    （返回 -32601 'wasn't found'），新版只能走 Storage 域。_ws_call 对
    「方法不存在」返回的是带 error 的消息而非 None，所以不能靠 None
    判断降级，必须逐个方法检查 error 字段。
    """
    for method in ("Storage.getCookies", "Network.getAllCookies"):
        msg = _ws_call(ws_url, method)
        if msg is None:
            continue
        if msg.get("error"):
            continue
        cookies = (msg.get("result") or {}).get("cookies")
        if isinstance(cookies, list) and cookies:
            return cookies
    return None


def _entries_via_page_document(port: int) -> list[dict] | None:
    """降级：对任一 page target 跑 document.cookie。

    ⚠️ 局限：document.cookie 读不到 httpOnly cookie。走这条路的返回里
    一定缺关键票据（_m_h5_tk 等），只能证明「端口活着」，不能当作
    完整正本 —— 调用方按关键 cookie 缺失处理。
    """
    try:
        r = _no_proxy_session().get(f"http://127.0.0.1:{port}/json",
                                    timeout=TIMEOUT_SEC)
        targets = r.json()
    except Exception:                                    # noqa: BLE001
        return None
    for t in targets:
        if t.get("type") != "page":
            continue
        ws_url = t.get("webSocketDebuggerUrl")
        if not ws_url:
            continue
        msg = _ws_call(ws_url, "Runtime.evaluate",
                       {"expression": "document.cookie", "returnByValue": True})
        if not msg or msg.get("error"):
            continue
        value = ((msg.get("result") or {}).get("result") or {}).get("value")
        if not value:
            continue
        out = []
        for item in str(value).split(";"):
            item = item.strip()
            if "=" in item:
                k, _, v = item.partition("=")
                out.append({"name": k.strip(), "value": v.strip()})
        if out:
            return out
    return None


# ---------------------------------------------------------------- 主入口

def _fetch_profile_cookie_entries(port: int) -> list[dict] | None:
    """读 profile cookie 的完整条目列表（含 domain/httpOnly 元数据）。

    供 store.py 做按域过滤用；普通调用方用 fetch_profile_cookies()。
    失败返回 None（不抛异常）。
    """
    port = int(port)
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            r = _no_proxy_session().get(f"http://127.0.0.1:{port}/json/version",
                                        timeout=TIMEOUT_SEC)
            ws_url = (r.json() or {}).get("webSocketDebuggerUrl")
            if ws_url:
                entries = _entries_via_ws_browser(ws_url)
                if entries:
                    return entries
            # 浏览器级 WS 没拿到 → 降级 document.cookie（拿不到 httpOnly，见上）
            entries = _entries_via_page_document(port)
            if entries:
                return entries
        except Exception:                                # noqa: BLE001
            pass
        if attempt < RETRY_ATTEMPTS:
            time.sleep(RETRY_INTERVAL_SEC)
    return None


# ---------------------------------------------------------------- 按域过滤

def _domain_specificity(dom: str) -> int:
    """域的具体程度：标签越多越具体。ka.waimai.meituan.com > .meituan.com。

    只用于同名 cookie 冲突时的排序，不参与「留不留」的判定。
    """
    dom = (dom or "").strip().lstrip(".").lower()
    return len([p for p in dom.split(".") if p])


def filter_entries_by_domain(entries: list[dict],
                             domains: tuple[str, ...] | None,
                             prefer_host: str | None = None) -> dict[str, str]:
    """按 cookie 的 domain 属性过滤条目，返回 {name: value}。

    ⛔ **同名冲突的取值规则（踩过坑，别改回去）**：
    同一个 cookie 名会在多个域各存一份，值可能不同 —— 美团 `token` 就是典型：
    `waimaieapp.meituan.com` 留的是旧值、`ka.waimai.meituan.com` 是新值，
    两者**长度完全相同**。原先「取最长、同长先到先得」的规则实际取到的是
    遍历顺序里先出现的旧值，导致刚登录完仍报 `code=-1000 登录信息失效`
    （2026-10-22 实测，meituan_yf 卡了一小时）。

    现在的优先级（从高到低）：
      1. `prefer_host` 命中该域（或其子域/父域）—— 调用方声明「我要打的就是这个站点」；
      2. 域标签更具体（`ka.waimai.meituan.com` 胜 `.meituan.com`）；
      3. 值更长（兜底，仅用于同具体度之间的区分）。
    长度不再是主判据。

    **必须按 domain 过滤而不是按 cookie 名**：美团/饿了么的关键项
    （token / acctId / _m_h5_tk …）名字里不含域名。
    domains=None 时不过滤（全量）。
    """
    out: dict[str, str] = {}
    best_rank: dict[str, tuple[int, int, int]] = {}

    host = (prefer_host or "").strip().lstrip(".").lower()

    for c in entries:
        name = str(c.get("name") or "")
        value = str(c.get("value") or "")
        if not name:
            continue
        dom = str(c.get("domain") or "").lower()
        if domains and not any(d in dom for d in domains):
            continue

        bare = dom.lstrip(".")
        if host and (bare == host or bare.endswith("." + host) or host.endswith("." + bare)):
            # prefer_host 命中：域越靠近 host 越优先
            host_rank = 2 if bare == host else 1
        else:
            host_rank = 0
        rank = (host_rank, _domain_specificity(dom), len(value))

        if name not in out or rank > best_rank[name]:
            out[name] = value
            best_rank[name] = rank
    return out


def fetch_profile_cookies(port: int) -> dict[str, str] | None:
    """从 CDP 端口读 cookie，返回 {name: value}；失败返回 None。

    同名 cookie 取值最长的那份（多域同名时通常是更具体的会话值）。
    """
    entries = _fetch_profile_cookie_entries(port)
    if entries is None:
        return None
    out = filter_entries_by_domain(entries, None)
    return out or None


# ---------------------------------------------------------------- 死会话判据

# 从外卖看板 `src/lib/cookie.mjs:157-177` 回灌（2026-10-22）。
# 那边为此挂过 7 天：品牌B yiyao 会话被服务端清空后，profile 里只剩 `.meituan.com`
# 父域那几份 token/acctId 副本，`required` 照样满足 → 判定「登录态健康」→
# 实际一导航就被踢到登录页。**「读得出」≠「可用」**。
#
# ⚠️ 别用「专属 cookie 数量」当判据——看板试过 `>= 5`，失效账号凑到 7 项照样漏报。
#    必须看 required 里那几个具体名字是否以**本域专属**形态存在。
#
# ⚠️ 措辞要克制：这条对**美团医药（yiyao）**是铁证，但对**闪购（nr.ele.me）**
#    常常只是「profile 里没有本域 WMSTOKEN、靠缓存兜底也照样跑」。
#    实测 2026-10-22：品牌A闪购四账号取数正常，但 profile 的 nr.ele.me 域就是没有
#    本域 WMSTOKEN。写成「一定是登录态失效」就是误报。
#    所以只陈述事实 + 给出两种可能，让调用方自己遇错时能对上号。
_DEAD_SESSION_HINT = (
    "{names} 在本域（{host}）没有专属副本，只有父域那份 —— "
    "若本次随后报非法令牌/被踢登录页，原因在此（需重新登录）；"
    "若能正常出数则可忽略"
)


def detect_dead_session(entries: list[dict], host: str,
                        required: tuple[str, ...]) -> tuple[bool, str]:
    """判断「只有父域副本、没有本域会话 cookie」这种假阳性登录态。

    返回 (is_dead, detail)。is_dead=True 时 detail 是可读的原因说明。

    这不是权限判定，只是**把「看起来能跑其实必挂」的状态提前说出来** ——
    以前这种状态要等到调用方 navigate 之后才暴露，往往已经白白重试了几轮。
    """
    if not entries or not host:
        return False, ""
    bare = host.strip().lstrip(".").lower()
    own_names = set()
    for c in entries:
        dom = str(c.get("domain") or "").strip().lstrip(".").lower()
        if dom == bare:
            own_names.add(str(c.get("name") or ""))
    missing = [r for r in required if r not in own_names]
    if not missing:
        return False, ""
    return True, _DEAD_SESSION_HINT.format(
        names=" / ".join(missing), host=bare)


# ---------------------------------------------------------------- 快照

def snapshot_path(port: int) -> Path:
    return _CREDS_DIR / f"profile-snapshot-{int(port)}.json"


def read_snapshot(port: int) -> dict | None:
    """读快照（失败返回 None）。只用于回退时在 WARN 里报快照时间。"""
    try:
        return json.loads(snapshot_path(port).read_text(encoding="utf-8"))
    except Exception:                                    # noqa: BLE001
        return None


def save_snapshot(port: int, cookies: dict[str, str]) -> Path | None:
    """原子写快照：临时文件 + rename。失败返回 None（不打断主流程）。"""
    try:
        _CREDS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"port": int(port),
                   "fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                   "cookieCount": len(cookies),
                   "cookies": cookies}
        final = snapshot_path(port)
        tmp = final.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1),
                       encoding="utf-8")
        os.replace(tmp, final)                           # 同盘 rename，原子
        return final
    except Exception:                                    # noqa: BLE001
        return None
