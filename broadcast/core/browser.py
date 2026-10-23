"""Chrome 驱动（CDP），用于「借页面之手」访问被风控签名保护的接口。

为什么需要它：
- 美团余额接口 /account/r/queryAcctBalance 被 openresty 403 硬拦，
  签名（mtgsig）由页面内的 H5guard SDK 生成并与请求体强绑定，逆向不划算。
- 正确做法是起一个 Chrome，注入用户 Cookie，打开目标站点页面，
  让页面自己的 SDK 去签名；我们只负责读结果。

两种运行模式：
- headless=True ：日常定时巡检用，无窗口。
- headless=False：人工登录用（可见窗口，扫码），同时可挂脚本注入做接口嗅探。

关键工程细节（都是踩过的坑）：
1. 本机若有全局代理，必须对 127.0.0.1 禁用，否则 http://127.0.0.1:PORT/json
   会被代理劫持返回 502，极易误判成「Chrome 没起来」。
2. Cookie 用 Network.setCookie 逐个注入即可免登录，不需要人工在无头浏览器里登录。
3. Runtime.evaluate 调异步函数必须开 awaitPromise=True。
4. 返回体先在页内精简再回传，避免大列表把 CDP 消息撑爆。
5. 可见窗口模式下不能用 CREATE_NO_WINDOW，否则窗口可能起不来。
6. 用独立 user-data-dir 起 Chrome，不会干扰用户自己正在用的浏览器窗口。
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket  # websocket-client


class BrowserError(RuntimeError):
    pass


# 常见浏览器候选路径：Chrome 优先，Edge 兜底（内核相同，CDP 协议一致）
_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Users\Public\AppData\Local\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def resolve_browser(preferred: str | None = None) -> str:
    """定位可用的浏览器可执行文件。"""
    if preferred and Path(preferred).exists():
        return preferred
    import glob
    extra = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        extra.append(os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"))
        extra.append(os.path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"))
    for p in _CANDIDATES + extra:
        if Path(p).exists():
            return p
    raise BrowserError(
        "找不到 Chrome 或 Edge。请在 config.json 的 browser_path 里"
        "手动填上浏览器可执行文件的完整路径。")


def resolve_browser_for(cfg: dict, key: str, driver_cfg: dict | None = None) -> str:
    """按「平台级 → 全局 → 驱动级 → 自动探测」的顺序解析浏览器。

    为什么要平台级（2026-09-21 加）：不同账号可以指定不同浏览器 ——
    例如品牌B系列走 Edge、品牌A系列走 Chrome，便于隔离与观察。

    ⚠️ **登录与取数必须解析出同一个浏览器**：美团 / 淘宝闪购的接口签名由页面脚本生成，
    换浏览器就是换指纹与 UA，同一个 Cookie 在另一个浏览器上可能不被认。
    所以本函数由登录流程（core/loginflow.py）与两个取数驱动（platforms/meituan.py、
    platforms/ele.py）共用 —— 改这里三处一起变，**不要只改其中一处**。
    """
    pcfg = (cfg.get("platforms") or {}).get(key) or {}
    preferred = (pcfg.get("chrome_path")
                 or cfg.get("browser_path")
                 or (driver_cfg or {}).get("chrome_path"))
    return resolve_browser(preferred)


def _free_port(preferred: int) -> int:
    for p in [preferred, preferred + 1, preferred + 2, preferred + 3, 0]:
        try:
            with socket.socket() as s:
                s.bind(("127.0.0.1", p))
                return s.getsockname()[1]
        except OSError:
            continue
    raise BrowserError("找不到可用端口")


def _no_proxy_opener():
    """绕开系统代理——否则 127.0.0.1 会被代理劫持。"""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _probe_ws(port: int, timeout: float = 2.0) -> str | None:
    """调试端口就绪则返回 webSocketDebuggerUrl，否则 None。"""
    try:
        with _no_proxy_opener().open(
                f"http://127.0.0.1:{port}/json/version", timeout=timeout) as r:
            return json.loads(r.read().decode())["webSocketDebuggerUrl"]
    except Exception:
        return None


# 无头启动的候选组合，按「正常环境里的期望成功率」排序。
#
# 为什么需要多个：实测在**计划任务**启动的那个会话里，--headless=new 会
# 建出 4 个 profile 条目后就停住、调试端口永远不开（手跑同参数必成功）。
# 与其赌某一种参数组合，不如先把最可能的那种单独试一次（正常环境 0.5 秒
# 就绪，零额外开销），它失败时再把其余的**并发**跑一遍，谁先开端口用谁。
# 实测（2026-09-14）：
#   计划任务会话里，下列组合**全部**失败，症状完全一致——启动器 rc=0 退出、
#   profile 只建出 4~6 个条目、调试端口永不开：
#     headless=new / headless=old / +--no-sandbox / +--disable-gpu
#   说明既不是 headless 模式，也不是 sandbox 或 GPU。真正的原因在权限：
#   任务以「内置 Administrator」身份运行（该账户没有 UAC 分割，进程天然是
#   提升的），Chrome 启动后发现自身权限过高，会去拉起一个非提升的副本来
#   接替自己，然后原进程 exit(0)——而计划任务这种没有 explorer 的上下文里
#   这一步落空，端口就永远没人监听（同一台机器上用户自己那个 Chrome 的
#   命令行里也带着 --do-not-de-elevate，是同一个毛病的印记）。
#   加上 --do-not-de-elevate 后，任务会话里 0.96 秒就绪。
# 所以主路径就用它；其余三个只作兜底（例如将来换到非提升环境跑）。
_HEADLESS_VARIANTS: list[tuple[str, list[str]]] = [
    ("headless-new-no-de-elevate", ["--headless=new", "--do-not-de-elevate"]),
    ("headless-new", ["--headless=new"]),
    ("headless-old-no-de-elevate", ["--headless=old", "--do-not-de-elevate"]),
    ("headless-new-nosandbox",
     ["--headless=new", "--no-sandbox", "--disable-gpu", "--do-not-de-elevate"]),
]


def _kill_by_cmdline(marker: str) -> int:
    """按命令行特征杀掉残留浏览器进程，返回杀掉的个数。

    必须这么做，原因见 start() 里的说明：Windows 上 chrome.exe 启动后会
    重新拉起一个子进程，我们持有的启动器进程早已退出，
    terminate() 对它完全无效，浏览器会作为孤儿进程一直留在后台。
    这里按「user-data-dir 里有我们独有的标记」精确匹配，不会误伤
    用户自己正在用的浏览器（它的命令行里没有这个标记）。
    """
    if os.name != "nt":
        return 0
    safe = marker.replace("'", "''")
    ps = (
        "Get-CimInstance Win32_Process -Filter "
        "\"Name='chrome.exe' or Name='msedge.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*{safe}*' }} | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force "
        "-ErrorAction SilentlyContinue; 1 } | Measure-Object | "
        "Select-Object -ExpandProperty Count"
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return int((r.stdout or "0").strip() or 0)
    except Exception:
        return 0


class Chrome:
    def __init__(self, exe: str, user_agent: str | None = None,
                 port: int = 9226, headless: bool = True,
                 profile_dir: str | None = None):
        self.exe = exe
        self.user_agent = user_agent
        self._pref_port = port            # 重试时还要用它重新选端口
        self.port = _free_port(port)
        self.headless = headless
        self.profile_dir = profile_dir or tempfile.mkdtemp(prefix="wb-bal-")
        # 显式传入 profile_dir 时视为「用户的持久化目录」，退出时不删
        self._owns_profile = profile_dir is None
        self.proc: subprocess.Popen | None = None
        self.ws: websocket.WebSocket | None = None
        self._id = 0
        self.events: list[dict] = []          # 未匹配的 CDP 事件，供嗅探使用

    # ---------------- 生命周期 ----------------
    def start(self) -> "Chrome":
        if not Path(self.exe).exists():
            raise BrowserError(f"找不到浏览器：{self.exe}")

        # 可见窗口模式（人工登录）只有一种打法，且不能设 CREATE_NO_WINDOW。
        if not self.headless:
            self._start_once(["--new-window", "--window-size=1440,960",
                              "--window-position=40,20"], "visible")
            return self

        first, rest = _HEADLESS_VARIANTS[0], _HEADLESS_VARIANTS[1:]

        # 第 1 轮：正常环境下这一种 0.5 秒就能开出端口，先单独跑，省资源。
        err = self._attempt(first[0], first[1])
        if err is None:
            return self

        # 第 2 轮：换 profile/端口解决不了的时候（典型：计划任务会话），
        # 把剩下的变体并发跑一遍。当日播报缺一整个平台，代价远大于多花 30 秒；
        # 而且把一个变体的成败写进 chrome_boot.log，下次排查不用再猜。
        self._boot_note(f"[RETRY] {first[0]} 失败：{err}")
        self._boot_note(f"[RETRY] 并发尝试其余 {len(rest)} 个变体")
        return self._start_parallel(rest)

    def _attempt(self, label: str, flags: list[str]) -> str | None:
        """单独试一个变体；成功返回 None，失败返回原因字符串。"""
        try:
            self._start_once(flags, label)
            return None
        except BrowserError as e:
            self._discard_attempt()
            return str(e)

    def _discard_attempt(self) -> None:
        """一次启动尝试失败后的收尾：停进程、丢掉这个 profile、换端口。"""
        self._shutdown_own_process()
        if self._owns_profile:
            shutil.rmtree(self.profile_dir, ignore_errors=True)
        time.sleep(0.8)
        self.profile_dir = tempfile.mkdtemp(prefix="wb-bal-")
        self._owns_profile = True
        self.port = _free_port(self._pref_port)

    def _shutdown_own_process(self) -> None:
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
        if self._logfh:
            try:
                self._logfh.close()
            except Exception:
                pass
            self._logfh = None
        _kill_by_cmdline(self.profile_dir)

    def _start_parallel(self, variants: list[tuple[str, list[str]]]) -> "Chrome":
        """并发启动多个变体，第一个开出调试端口的胜出，其余全部清掉。"""
        cands = []
        for i, (label, flags) in enumerate(variants):
            cands.append({
                "label": label, "flags": flags,
                "port": _free_port(self._pref_port + 3 * (i + 1)),
                "prof": tempfile.mkdtemp(prefix="wb-bal-"),
                "proc": None, "logfh": None, "ws_url": None,
                "t0": time.time(), "ready_s": None,
            })

        winner = None
        try:
            for c in cands:
                c["proc"], c["logfh"] = self._spawn(c["port"], c["prof"], c["flags"], c["label"])
            deadline = time.time() + 30
            while winner is None and time.time() < deadline:
                for c in cands:
                    if c["ws_url"]:
                        continue
                    ws = _probe_ws(c["port"], timeout=1.5)
                    if ws:
                        c["ws_url"] = ws
                        c["ready_s"] = round(time.time() - c["t0"], 2)
                        winner = c
                        break
                if winner is None:
                    time.sleep(0.4)
        finally:
            for c in cands:
                if c["ws_url"]:
                    self._boot_note(
                        f"[OK] {c['label']} ready in {c['ready_s']}s (port={c['port']})")
                    continue
                # 胜出者一出现我们就退出等待循环了，其余候选可能只是「慢」，
                # 不是「坏」。再探一次端口，别把它们误报成失败——排查时
                # 「3 个变体都失败」和「1 个赢了、另外 2 个也起来了但慢」
                # 是两条完全不同的结论。
                if winner is not None and _probe_ws(c["port"], timeout=1.0):
                    self._boot_note(
                        f"[OK-late] {c['label']} 也能起来（port={c['port']}），"
                        f"已被 {winner['label']} 抢先")
                else:
                    rc = c["proc"].poll() if c["proc"] else None
                    pd = Path(c["prof"])
                    n = len(list(pd.glob("*"))) if pd.exists() else -1
                    self._boot_note(
                        f"[FAIL] {c['label']} launcher_rc={rc} profile_entries={n}")
                    self._context_note(c["prof"])
            for c in cands:
                if c is not winner:
                    self._teardown_candidate(c)

        if winner is None:
            raise BrowserError(
                f"浏览器启动失败：{len(variants) + 1} 种 headless 组合都开不出调试端口"
                "（127.0.0.1）。若本机有全局代理，请确认已对 127.0.0.1 放行；"
                "详见 logs/chrome_boot.log。")

        self.port = winner["port"]
        self.profile_dir = winner["prof"]
        self._owns_profile = True
        self.proc = winner["proc"]
        self._logfh = winner["logfh"]
        self.ws = websocket.create_connection(
            winner["ws_url"], timeout=30, http_no_proxy=["127.0.0.1", "localhost"])
        try:
            self.send("Browser.setDownloadBehavior", {"behavior": "default"})
        except Exception:
            pass
        return self

    def _teardown_candidate(self, c: dict) -> None:
        if c["proc"]:
            try:
                c["proc"].terminate()
                c["proc"].wait(timeout=5)
            except Exception:
                try:
                    c["proc"].kill()
                except Exception:
                    pass
        if c["logfh"]:
            try:
                c["logfh"].close()
            except Exception:
                pass
        _kill_by_cmdline(c["prof"])
        shutil.rmtree(c["prof"], ignore_errors=True)

    def _build_args(self, port: int, prof: str, flags: list[str]) -> list[str]:
        args = [
            self.exe,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={prof}",
            "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--disable-popup-blocking",
            "--disable-background-networking",
            # Chrome 111+ 会对 CDP 的 WebSocket 握手做 Origin 校验，
            # 不带这个开关会直接 403（Handshake status 403 Forbidden），
            # 表现是「Chrome 起来了但连不上」。
            "--remote-allow-origins=*",
            # 规避「受自动化控制」的特征检测，避免风控直接拦掉页面
            "--disable-blink-features=AutomationControlled",
            "--disable-features=Translate,OptimizationHints,AutomationControlled",
        ] + list(flags)
        if self.user_agent:
            args.append(f"--user-agent={self.user_agent}")
        args.append("about:blank")
        return args

    def _boot_log_path(self) -> Path:
        return Path(__file__).resolve().parent.parent / "logs" / "chrome_boot.log"

    def _boot_note(self, text: str) -> None:
        """往 chrome_boot.log 追加一行结论——启动变体的成败判据都在这里。"""
        try:
            p = self._boot_log_path()
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "ab") as f:
                f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {text}\n".encode("utf-8"))
        except Exception:
            pass

    def _context_note(self, prof: str) -> None:
        """失败时补一行环境证据：会话名 + 匹配该 profile 的浏览器进程。

        「计划任务会话」与「交互会话」的差别肉眼看不见，只有这一行能把
        「浏览器压根没起来」和「起来了但换了会话/身份」区分开。
        """
        parts = [f"SESSIONNAME={os.environ.get('SESSIONNAME')!r}"]
        try:
            ps = ("Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
                  f"Where-Object {{ $_.CommandLine -like '*{prof}*' }} | "
                  "ForEach-Object { \"$($_.ProcessId):s$($_.SessionId):p$($_.ParentProcessId)\" }")
            r = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True, text=True, timeout=30,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            hits = (r.stdout or "").strip().replace("\r", "").replace("\n", ",")
            parts.append("matching_procs=" + (hits or "none"))
        except Exception as e:
            parts.append(f"matching_procs=err({e.__class__.__name__})")
        self._boot_note("[ENV] " + " ".join(parts))

    def _spawn(self, port: int, prof: str, flags: list[str], label: str):
        """起一个候选浏览器进程，返回 (Popen, 日志句柄)。

        浏览器自己的输出必须落盘：启动失败时它往往只在 stderr 里留一句话，
        用 DEVNULL 丢掉的话排查只能靠猜。
        """
        args = self._build_args(port, prof, flags)
        logfh = None
        try:
            p = self._boot_log_path()
            p.parent.mkdir(parents=True, exist_ok=True)
            logfh = open(p, "ab")
            logfh.write(("\n" + "=" * 70 + f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}]"
                         f" variant={label} port={port} headless={self.headless}\n"
                         + " ".join(args) + "\n").encode("utf-8"))
            logfh.flush()
        except Exception:
            logfh = None

        creation = 0
        # 可见窗口模式不能设 CREATE_NO_WINDOW
        if os.name == "nt" and self.headless:
            creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)

        proc = subprocess.Popen(
            args,
            stdout=logfh or subprocess.DEVNULL,
            stderr=logfh or subprocess.DEVNULL,
            creationflags=creation)
        return proc, logfh

    def _start_once(self, flags: list[str], label: str) -> "Chrome":
        self.proc, self._logfh = self._spawn(self.port, self.profile_dir, flags, label)

        # ★ 关键：Windows 上 chrome.exe 启动后会重新拉起一个子进程，
        #   我们持有的这个「启动器」通常几毫秒内就以 exit=0 退出，
        #   而浏览器其实活得好好的（实测 Chrome 151 就是这行为）。
        #   所以这里绝不能拿 proc.poll() 当失败判据，只认「调试端口就绪」。
        #   25 秒足够：正常环境 0.5 秒就绪；失败时浏览器往往几秒内就已退出，
        #   余下的时间只是在等一个永远不会出现的端口。
        deadline = time.time() + 25
        ws_url = None
        while time.time() < deadline:
            ws_url = _probe_ws(self.port)
            if ws_url:
                break
            time.sleep(0.4)
        if not ws_url:
            # 失败时浏览器常常一个字都不写。把「启动器退出码」和「profile 目录
            # 被写过几个条目」一起记下来：两数合起来能区分「压根没起来」和
            # 「起来了但早期就停住」（后者 launcher_rc=0、条目数停在 4 左右，
            # 见 _HEADLESS_VARIANTS 的说明），否则下次再遇到只能靠猜。
            rc = self.proc.poll() if self.proc else None
            pd = Path(self.profile_dir)
            n_entries = len(list(pd.glob("*"))) if pd.exists() else -1
            self._boot_note(f"[FAIL] {label} port={self.port} launcher_rc={rc} "
                            f"profile_entries={n_entries}")
            self._context_note(self.profile_dir)
            self.stop()
            raise BrowserError(
                f"浏览器调试端口未就绪（127.0.0.1:{self.port}，变体 {label}）")

        self.ws = websocket.create_connection(
            ws_url, timeout=30, http_no_proxy=["127.0.0.1", "localhost"])
        # 浏览器级放行，避免 403 时静默拦住请求
        try:
            self.send("Browser.setDownloadBehavior", {"behavior": "default"})
        except Exception:
            pass
        return self

    def stop(self) -> None:
        # 1) 先让浏览器通过 CDP 自己优雅退出（我们是浏览器级连接，可直接下令）
        if self.ws:
            try:
                self.ws.send(json.dumps({"id": 999999, "method": "Browser.close"}))
                time.sleep(1.0)
            except Exception:
                pass
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        self.ws = None

        # 2) 启动器进程（通常早已退出，terminate 只是兜一层）
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.proc = None

        # 3) 兜底：按 user-data-dir 特征清掉残留子进程。
        #    不做这一步的话，每次巡检都会在后台攒下一堆没人管的浏览器进程。
        if self._port_alive(1.2):
            _kill_by_cmdline(self.profile_dir)
            time.sleep(0.4)
            if self._port_alive(1.0):
                _kill_by_cmdline(self.profile_dir)

        if self._owns_profile:
            shutil.rmtree(self.profile_dir, ignore_errors=True)

    def _port_alive(self, timeout: float = 1.5) -> bool:
        """以「调试端口是否还在应答」判断浏览器是否存活。

        不能用 proc.poll()：启动器进程本就秒退，那样判断会一直误报「已关闭」。
        """
        try:
            with _no_proxy_opener().open(
                    f"http://127.0.0.1:{self.port}/json/version", timeout=timeout) as r:
                json.loads(r.read().decode())
            return True
        except Exception:
            return False

    def alive(self) -> bool:
        return self._port_alive()

    def __enter__(self):
        return self.start()

    def __exit__(self, *a):
        self.stop()

    # ---------------- CDP 原语 ----------------
    def send(self, method: str, params: dict | None = None,
             session_id: str | None = None, timeout: float = 40):
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        self.ws.send(json.dumps(msg))
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self.ws.recv()
            if not raw:
                continue
            obj = json.loads(raw)
            if obj.get("id") != self._id:
                # 事件消息：留档，供网络嗅探使用
                if obj.get("method"):
                    self.events.append(obj)
                    if len(self.events) > 800:
                        del self.events[:200]
                continue
            if "error" in obj:
                raise BrowserError(f"{method} 失败：{obj['error']}")
            return obj.get("result", {})
        raise BrowserError(f"{method} 超时")

    def drain(self, seconds: float = 3.0) -> int:
        """把 WebSocket 里积压的事件读进 self.events（不发送任何命令）。

        为什么需要它：CDP 事件只有在我们调用 send() 顺带读 socket 时才被消费。
        若在导航后直接 sleep 再去看 self.events，会漏掉大量事件（实测只看到 1 条
        请求，实际有几十条），导致抓包结论完全错误。
        """
        n = 0
        end = time.time() + seconds
        self.ws.settimeout(0.4)
        try:
            while time.time() < end:
                try:
                    raw = self.ws.recv()
                except Exception:
                    continue
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except Exception:
                    continue
                if obj.get("method"):
                    self.events.append(obj)
                    n += 1
                    if len(self.events) > 3000:
                        del self.events[:1000]
        finally:
            self.ws.settimeout(None)
        return n

    def events_of(self, method: str) -> list[dict]:
        return [e for e in self.events if e.get("method") == method]

    # ---------------- 页面操作 ----------------
    def new_page(self, url: str = "about:blank") -> str:
        t = self.send("Target.createTarget", {"url": url})
        target_id = t["targetId"]
        s = self.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        sid = s["sessionId"]
        self.send("Page.enable", session_id=sid)
        self.send("Runtime.enable", session_id=sid)
        self.send("Network.enable", session_id=sid)
        return sid

    def inject_on_new_document(self, script: str, sid: str) -> None:
        """在任何页面脚本执行之前注入（用于挂钩 fetch/XHR、抹掉自动化特征）。"""
        self.send("Page.addScriptToEvaluateOnNewDocument",
                  {"source": script}, session_id=sid)

    def set_cookies(self, cookie_pairs: list[tuple[str, str]], domain_url: str,
                    sid: str, domain: str | None = None) -> int:
        """写入 Cookie。

        domain_url: 用于推导 host-only Cookie 的地址。
        domain:     若给定（如 ".ele.me"），写成域级 Cookie，子域都能收到。
        """
        ok = 0
        for name, value in cookie_pairs:
            params = {"name": name, "value": value}
            if domain:
                params["domain"] = domain
                params["path"] = "/"
            else:
                params["url"] = domain_url
            try:
                r = self.send("Network.setCookie", params, session_id=sid)
                if r is False or (isinstance(r, dict) and r.get("success") is False):
                    continue
                ok += 1
            except Exception:
                continue
        return ok

    def cookies_for(self, urls: list[str], sid: str) -> list[dict]:
        """查询浏览器 Cookie 罐里对给定 URL 生效的 Cookie（不依赖页面 JS）。"""
        r = self.send("Network.getCookies", {"urls": urls}, session_id=sid)
        return r.get("cookies", []) or []

    def all_cookies(self, sid: str) -> list[dict]:
        r = self.send("Network.getAllCookies", session_id=sid)
        return r.get("cookies", []) or []

    def frame_texts(self, sid: str, limit: int = 20000) -> str:
        """读「所有 frame」的正文并拼接，跨域 iframe 也能读。

        为什么需要：淘宝闪购的壳页面（nr.ele.me）把内容区（含余额）嵌在
        跨域 iframe（bs-ka-app chain.html）里，主文档 innerText 只有几百字的
        菜单 —— 单文档读取永远等不到「余额」二字，登录检测就会一直空转
        （2026-09-17 实锤：正文仅 519 字，余额在 iframe 里）。
        CDP 的 DOM 操作不受同源策略约束：对每个 frame createIsolatedWorld
        建执行上下文即可读它的 DOM。只扫 ele.me 系 frame，跳过 CDN/IM 等无关项。
        """
        texts: list[str] = []
        try:
            tree = self.send("Page.getFrameTree", session_id=sid, timeout=10)
            ids: list[tuple[str, str]] = []

            def _walk(node: dict) -> None:
                fr = node.get("frame") or {}
                ids.append((fr.get("id") or "", fr.get("url") or ""))
                for child in node.get("childFrames") or []:
                    _walk(child)

            _walk(tree.get("frameTree") or {})
            for fid, furl in ids:
                if not fid:
                    continue
                if furl and "ele.me" not in furl:
                    continue
                try:
                    w = self.send("Page.createIsolatedWorld",
                                  {"frameId": fid}, session_id=sid, timeout=10)
                    ctx = (w or {}).get("executionContextId")
                    if ctx is None:
                        continue
                    # innerText 依赖布局，偶发整帧返回空（SPA 重渲染窗口期实测）；
                    # textContent 不依赖布局但无换行 —— 只作回退，检测「有无余额 +
                    # 附近金额」两个用途都够用。
                    expr = ("(function(){if(!document.body)return '';"
                            "var t=document.body.innerText||'';"
                            "if(t.length)return t.slice(0,%d);"
                            "return (document.body.textContent||'').slice(0,%d);})()"
                            % (limit, limit))
                    r = self.send("Runtime.evaluate",
                                  {"expression": expr, "contextId": ctx,
                                   "returnByValue": True},
                                  session_id=sid, timeout=15)
                    t = ((r.get("result") or {}).get("result") or {}).get("value") or ""
                    if t:
                        texts.append(t)
                except Exception:
                    continue
        except Exception:
            return ""
        return "\n".join(texts)


    def js(self, expr: str, sid: str, await_promise: bool = False, timeout: float = 40):
        r = self.send("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True,
                       "awaitPromise": await_promise},
                      session_id=sid, timeout=timeout)
        if r.get("exceptionDetails"):
            raise BrowserError(f"页面 JS 异常：{r['exceptionDetails'].get('text')}")
        return r.get("result", {}).get("value")

    def goto(self, url: str, sid: str, wait: float = 2.0, timeout: float = 45) -> None:
        self.send("Page.navigate", {"url": url}, session_id=sid, timeout=timeout)
        time.sleep(wait)

    def body_text(self, sid: str, limit: int = 30000) -> str:
        try:
            return self.js(f"document.body ? document.body.innerText.slice(0,{limit}) : ''",
                           sid) or ""
        except Exception:
            return ""

    def wait_for(self, expr: str, sid: str, timeout: float = 30,
                 interval: float = 0.6) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.js(expr, sid):
                    return True
            except Exception:
                pass
            time.sleep(interval)
        return False
