"""交互式登录捕获：开一个可见浏览器，人工登录一次，脚本自动抓齐凭据与接口。

为什么走这条路（而不是让用户复制 cURL）：
- 这两个后台都是登录态 SPA，接口还带风控签名；人工去 DevTools 里找准「哪条请求
  才是余额接口」对非技术用户非常不友好，实测也确实找不着。
- 反过来，让脚本自己开一个浏览器，用户只需要「扫码 → 等页面出现余额」，
  剩下的（Cookie、localStorage 令牌、接口名、参数字段、金额单位）全部由脚本捕获。

顺带解决两个隐藏的坑：
1. 有些站点把登录态放 localStorage 而不是 Cookie，只导 Cookie 会「看起来已登录、
   实际未登录」，所以 localStorage/sessionStorage 一并抓。
2. 接口金额可能是「分」而页面显示「元」，差 100 倍。这里用「页面上显示的数字」
   做基准去反推接口单位，自动标定 unit_divisor，避免把 123456 分当成 123456 元
   而漏报（这类错误会让预警在最该响的时候哑掉）。
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from core import extract
from core.browser import Chrome, resolve_browser, resolve_browser_for

# 记录页面上所有「可能是余额接口」的请求，供事后分析
SNIFF_JS = r"""
(function () {
  if (window.__wb_log) { return; }
  var LOG = [];
  window.__wb_log = LOG;
  var HINT = /(balance|fund|acct|account|wallet|promotion|recharge|credit|deposit|mtop|asset)/i;

  function snap(o) {
    try { LOG.push(o); if (LOG.length > 150) { LOG.shift(); } } catch (e) {}
  }
  function record(kind, url, method, status, body, reqBody) {
    try {
      url = String(url || '');
      if (url.indexOf('data:') === 0 || url.indexOf('blob:') === 0) { return; }
      var txt = '';
      try { txt = String(body == null ? '' : body); } catch (e) { txt = ''; }
      var interesting = HINT.test(url) ||
        /余额|balance|acctBalance|availableBalance|fund/i.test(txt);
      if (!interesting) { return; }
      snap({ kind: kind, url: url, method: method || 'GET', status: status,
             req: String(reqBody || '').slice(0, 3000),
             body: txt.slice(0, 20000), t: Date.now() });
    } catch (e) {}
  }

  var of = window.fetch;
  if (of) {
    window.fetch = function () {
      var args = arguments, input = args[0], opt = args[1] || {};
      var url = (typeof input === 'string') ? input : ((input && input.url) || '');
      return of.apply(this, args).then(function (r) {
        try {
          var m = opt.method || (input && input.method) || 'GET';
          r.clone().text().then(
            function (t) { record('fetch', url, m, r.status, t, opt.body); },
            function () { record('fetch', url, m, r.status, '', opt.body); });
        } catch (e) {}
        return r;
      });
    };
  }

  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__wb = { m: m, u: u };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    var self = this;
    this.addEventListener('load', function () {
      try {
        var wb = self.__wb || {};
        record('xhr', wb.u || '', wb.m || 'GET', self.status, self.responseText, b);
      } catch (e) {}
    });
    return XS.apply(this, arguments);
  };
})();
"""

# 抹掉最明显的自动化特征，降低被风控挡在门外的概率
ANTI_AUTO_JS = r"""
try { Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } }); } catch (e) {}
try { Object.defineProperty(navigator, 'languages', { get: function () { return ['zh-CN', 'zh'] ; } }); } catch (e) {}
"""

# 把「登出」请求桩掉，让页面不要把自己踢下线。
#
# 为什么需要：淘宝闪购的页面在引导阶段会调 mtop.alsc.user.session.ele.check，
# 这个接口在部分账号（实测：供应商身份的商家）下返回「需要登录」，
# 前端据此调用 nracc.ele.me/api/security/logout 并跳转到登录页。
# 结果是：只要用脚本注入的 Cookie 打开页面，就会被立刻登出，永远看不到余额。
# 桩掉登出后，页面能正常渲染，余额也就读到了。
LOGOUT_STUB_JS = r"""
(function () {
  var BAD = /security\/logout/i;
  function fake() {
    return new Response('{"code":0,"data":{}}',
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  var of = window.fetch;
  if (of) {
    window.fetch = function (input, opt) {
      var url = (typeof input === 'string') ? input : ((input && input.url) || '');
      if (BAD.test(String(url))) { return Promise.resolve(fake()); }
      return of.apply(this, arguments);
    };
  }
  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__stub = BAD.test(String(u || ''));
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__stub) {
      var self = this;
      setTimeout(function () {
        try {
          Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
          Object.defineProperty(self, 'status', { value: 200, configurable: true });
          Object.defineProperty(self, 'responseText',
            { value: '{"code":0,"data":{}}', configurable: true });
          self.dispatchEvent(new Event('load'));
          self.dispatchEvent(new Event('loadend'));
        } catch (e) {}
      }, 30);
      return;
    }
    return XS.apply(this, arguments);
  };
})();
"""

_READ_LOG_JS = "JSON.stringify(window.__wb_log || [])"
_READ_STORAGE_JS = """JSON.stringify((function(){
  var out = {ls:{}, ss:{}};
  try { for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i);
        out.ls[k]=String(localStorage.getItem(k)).slice(0,12000);} } catch(e){}
  try { for (var j=0;j<sessionStorage.length;j++){ var k2=sessionStorage.key(j);
        out.ss[k2]=String(sessionStorage.getItem(k2)).slice(0,12000);} } catch(e){}
  return out;
})())"""


# ---------------------------------------------------------------- Cookie 处理

def _host_of(url: str) -> str:
    return (urlparse(url).netloc or "").split(":")[0]


def _domain_match(cookie_domain: str, host: str) -> bool:
    d = (cookie_domain or "").lstrip(".").lower()
    h = (host or "").lower()
    if not d or not h:
        return False
    return h == d or h.endswith("." + d)


def build_cookie_header(cookies: list[dict], host: str) -> tuple[str, list[str], int]:
    """把浏览器 Cookie 里属于该站点的项拼成 Cookie 头。

    返回 (cookie_header, 被剔除非 ASCII 的键名列表, 原始项数)。
    必须按 key 去重（同名不同 path 的 Cookie 会重复出现）。
    """
    seen: dict[str, str] = {}
    total = 0
    dropped: list[str] = []
    for c in cookies:
        if not _domain_match(c.get("domain", ""), host):
            continue
        name, val = c.get("name"), c.get("value") or ""
        if not name:
            continue
        total += 1
        try:
            val.encode("ascii")
        except UnicodeEncodeError:
            if name not in dropped:
                dropped.append(name)
            continue
        # 同名时保留更长（更完整）的那个
        if name not in seen or len(val) > len(seen[name]):
            seen[name] = val
    header = "; ".join(f"{k}={v}" for k, v in seen.items())
    return header, dropped, total


# ---------------------------------------------------------------- 接口分析

def _mtop_from_url(url: str) -> dict:
    out = {}
    m = re.search(r"/h5/(mtop\.[^/]+)/", url or "")
    if m:
        out["api"] = m.group(1)
    qs = parse_qs(urlparse(url or "").query)
    if qs.get("appKey"):
        out["appkey"] = qs["appKey"][0]
    if qs.get("data"):
        out["data"] = qs["data"][0]
    if qs.get("api"):
        out.setdefault("api", qs["api"][0])
    return out


def analyze_log(entries: list[dict], host: str) -> dict:
    """从抓到的请求里挑出「余额接口」，并尝试与页面显示金额对账。"""
    candidates = []
    for e in entries:
        body = e.get("body") or ""
        url = e.get("url") or ""
        if _host_of(url) and _host_of(url) != host:
            # 跨域请求依然可能是接口（如 mtop.ele.me、ka.waimai.meituan.com 的子域）
            if not _domain_match(_host_of(url), host) and "mtop" not in url:
                continue
        score = 0
        if "余额" in body:
            score += 4
        if re.search(r"balance", body, re.I):
            score += 2
        if re.search(r"balance|fund|acct|account|wallet|asset", url, re.I):
            score += 1
        if "mtop" in url:
            score += 1

        info = {"url": url, "method": e.get("method"), "status": e.get("status"),
                "score": score, "sample": body[:1200]}
        obj = None
        try:
            obj = json.loads(body)
        except Exception:
            m = re.search(r"\{.*\}", body or "", re.S)
            if m:
                try:
                    obj = json.loads(m.group(0))
                except Exception:
                    obj = None
        if obj is not None:
            val, keyname = extract.pick_balance_field(obj)
            if val is not None:
                info["api_value"] = val
                info["api_field"] = keyname
                info["score"] += 3
            info["json"] = obj
        mt = _mtop_from_url(url)
        if mt:
            info["mtop"] = mt
        candidates.append(info)

    candidates.sort(key=lambda x: x["score"], reverse=True)
    return {"candidates": candidates[:12], "total": len(entries)}


def calibrate(api_value, dom_amount) -> tuple[int | None, str]:
    """用页面显示金额反推接口单位，返回 (除数, 说明)。"""
    if not api_value or not dom_amount:
        return None, "缺少页面金额，无法标定单位"
    try:
        api_value = float(api_value)
        dom_amount = float(dom_amount)
    except Exception:
        return None, "数值无法比较"
    if dom_amount <= 0:
        return None, "页面金额异常"
    for div, label in ((1, "元"), (100, "分"), (1000, "厘")):
        if abs(api_value / div - dom_amount) <= max(0.02 * dom_amount, 0.02):
            return div, f"接口单位是「{label}」（接口 {api_value} ÷ {div} = {dom_amount}）"
    return None, (f"接口值 {api_value} 与页面 {dom_amount} 不成整倍数关系，"
                  "需人工确认，暂不标定")


# ---------------------------------------------------------------- 主流程

def _browser_cfg(cfg: dict) -> dict:
    return cfg.get("meituan", {}) or {}


def interactive_login(key: str, cfg: dict, store, cred_key: str | None = None,
                      timeout: int = 480) -> dict:
    """开可见浏览器 → 等用户登录 → 抓凭据与接口 → 落盘。返回结果摘要。"""
    pcfg = cfg["platforms"][key]
    name = pcfg.get("display_name", key)
    # 站点级参数（home_url 等）挂在「驱动名」下，账号键可能与之不同名
    # （比如 ele_yf 用的是 ele 那套 URL），所以要回退到驱动名去取。
    driver = pcfg.get("driver") or key
    pcfg2 = cfg.get(key) or cfg.get(driver) or {}
    home = pcfg2.get("home_url")
    if not home:
        return {"ok": False, "error": f"config.json 里缺少 {key}.home_url"}

    host = _host_of(home)
    origin = f"https://{host}/"
    bcfg = _browser_cfg(cfg)
    chrome = resolve_browser_for(cfg, key, bcfg)
    profile = Path(__file__).resolve().parent.parent / ".browser-profile" / key
    profile.mkdir(parents=True, exist_ok=True)
    # 端口按驱动错开：同一次登录多个账号时，两个浏览器抢同一个调试端口
    # 会让后启动的那个静默连到前一个上，抓到的就是别人的登录态。
    port = int(bcfg.get("cdp_port", 9226)) + (20 if driver == "ele" else 0)

    print("=" * 62)
    print(f"  登录 {name}")
    print("=" * 62)
    print(f"  即将打开一个浏览器窗口（不影响你正在用的浏览器）。")
    print(f"  请在弹出的窗口里完成登录。")
    print(f"  检测到你已登录并看到「余额」后，脚本会自动继续，无需按任何键。")
    print(f"  最长等待 {timeout // 60} 分钟。")
    print("-" * 62)
    print(f"  入口：{home}")
    print("-" * 62, flush=True)

    br = Chrome(chrome, user_agent=bcfg.get("user_agent"), port=port,
                headless=False, profile_dir=str(profile)).start()
    try:
        sid = br.new_page("about:blank")
        br.inject_on_new_document(ANTI_AUTO_JS, sid)
        br.inject_on_new_document(SNIFF_JS, sid)
        if driver == "ele":
            # 淘宝闪购的「页面自登出」：引导阶段页面调 session.ele.check，本账号
            # 下返回「需要登录」，前端随即调 /api/security/logout 把自己踢下线。
            # 后果是登录捕获当场一切正常（快照都写好了），但会话已在服务端作废，
            # 几分钟后纯接口取数必报 FAIL_SYS_SESSION_EXPIRED（2026-09-17 实锤，
            # 时间线：09:26 捕获成功 → 09:40 已失效）。桩掉登出，页面就杀不掉会话。
            br.inject_on_new_document(LOGOUT_STUB_JS, sid)
        br.goto(home, sid, wait=4.0)
        try:
            br.send("Page.bringToFront", session_id=sid)
        except Exception:
            pass

        # ---- 等登录完成：以「页面上出现余额数字」为判据 ----
        # 注意要连 iframe 一起读：壳页面（nr.ele.me）的余额在跨域 iframe 里，
        # 主文档 innerText 看不到（见 Chrome.frame_texts 的注释）。
        deadline = time.time() + timeout
        dom_amount, dom_label, last_tip = None, None, 0.0
        logged_in = False
        while time.time() < deadline:
            if not br.alive():
                print(f"\n⚠️ 浏览器窗口已关闭，本次登录捕获中止。", flush=True)
                return {"ok": False, "error": "浏览器被关闭"}
            text = br.body_text(sid, 40000) + "\n" + br.frame_texts(sid, 20000)
            if "余额" in text:
                amt, lab = extract.money_near_label(text)
                if amt is not None:
                    dom_amount, dom_label, logged_in = amt, lab, True
                    break
            now = time.time()
            if now - last_tip > 20:
                left = int(deadline - now)
                print(f"  …等待登录中（剩余 {left // 60} 分 {left % 60} 秒）"
                      f"　若已登录，请把显示「余额」的页面打开并保持在最前面",
                      flush=True)
                last_tip = now
            time.sleep(2.0)

        if not logged_in:
            print("\n❌ 超时未检测到余额。请重试，并确保登录后停留在能看到余额的页面。",
                  flush=True)
            return {"ok": False, "error": "超时未检测到余额"}

        print(f"\n✅ 已检测到登录态（页面显示 ¥{dom_amount:,.2f}）。正在抓取凭据…",
              flush=True)
        time.sleep(2.5)                       # 留出时间让页面把剩余请求发完

        raw_cookies = br.all_cookies(sid)
        header, dropped, total = build_cookie_header(raw_cookies, host)

        try:
            storage = json.loads(br.js(_READ_STORAGE_JS, sid) or "{}")
        except Exception:
            storage = {"ls": {}, "ss": {}}
        try:
            log = json.loads(br.js(_READ_LOG_JS, sid) or "[]")
        except Exception:
            log = []
    finally:
        br.stop()

    if not header:
        return {"ok": False, "error": f"没抓到 {host} 的 Cookie"}

    store.set(cred_key or f"{key}_cookie", header)
    store.set(f"{key}_storage", json.dumps(storage, ensure_ascii=False))

    report = analyze_log(log, host)
    report["ok"] = True
    report["dom_amount"] = dom_amount
    report["dom_label"] = dom_label
    report["cookie_count"] = len(header.split(";"))
    report["cookie_total_raw"] = total
    report["dropped_cookies"] = dropped
    report["host"] = host

    recon_dir = Path(__file__).resolve().parent.parent / "creds"
    recon_dir.mkdir(parents=True, exist_ok=True)
    recon_file = recon_dir / f"{key}_recon.json"
    recon_file.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                          encoding="utf-8")

    # ---- 给用户看的摘要 ----
    print(f"  Cookie：{report['cookie_count']} 项"
          + (f"（跳过非 ASCII 项：{', '.join(dropped)}）" if dropped else ""))
    print(f"  登录令牌：localStorage {len(storage.get('ls', {}))} 项，"
          f"sessionStorage {len(storage.get('ss', {}))} 项")
    print(f"  抓到候选接口：{report['total']} 条请求，其中「可能相关」的 {len(report['candidates'])} 条")

    best = None
    for c in report["candidates"]:
        if c.get("api_value") is not None:
            best = c
            break
    if best is None and report["candidates"]:
        best = report["candidates"][0]

    if best:
        print("\n  最可能的余额接口：")
        print(f"    {best.get('method')} {best.get('url')[:140]}")
        if best.get("api_field"):
            print(f"    字段 {best['api_field']} = {best['api_value']}")
        if best.get("mtop"):
            print(f"    MTOP 接口：{best['mtop']}")
            if best["mtop"].get("appkey"):
                print(f"    appKey：{best['mtop']['appkey']}")
        div, why = calibrate(best.get("api_value"), dom_amount)
        if div:
            print(f"    单位标定：{why}")
            report["unit_divisor"] = div
            report["balance_field"] = best.get("api_field")
            recon_file.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
        else:
            print(f"    单位标定：{why}")

    return report
