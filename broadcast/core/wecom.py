"""企业微信推送：机器人私聊（wecom-cli）/ 群机器人 Webhook / stdout。

三种模式：
- wecomcli：用官方 wecom-cli 以智能机器人身份私聊授权人。**推荐**，不需要建群机器人。
- webhook ：POST 到企业微信群机器人，脚本自带推送能力。
- stdout  ：只输出文案，交给调用方投递。

企微 markdown 单条上限：群机器人 4096 字节、机器人私聊 20480 字节
（中文 1 字≈3 字节）。超限会静默失败，因此这里按字节预算分包并逐条校验。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

MAX_BYTES_DEFAULT = 3500        # 群机器人留余量
MAX_BYTES_AIBOT = 18000         # 机器人私聊上限 20480，留余量

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def byte_len(s: str) -> int:
    return len(s.encode("utf-8"))


def pack_messages(head_lines: list[str], body_lines: list[str],
                  max_bytes: int = MAX_BYTES_DEFAULT) -> list[str]:
    """按 UTF-8 字节预算分包；每包都带 head，续包标题加（续）。"""
    head = list(head_lines)
    msgs: list[str] = []
    cur: list[str] = []
    cur_b = byte_len("\n".join(head) + "\n")
    for ln in body_lines:
        lb = byte_len(ln + "\n")
        if cur and cur_b + lb > max_bytes:
            msgs.append("\n".join(head + cur))
            head = [head[0] + "（续）"] + [h for h in head[1:] if h.startswith("**项目**")]
            cur, cur_b = [], byte_len("\n".join(head) + "\n")
        cur.append(ln)
        cur_b += lb
    if cur or not msgs:
        msgs.append("\n".join(head + cur))
    return msgs


# ------------------------------------------------------------------ wecom-cli

# wecom-cli 的平台二进制。npm 包里的 bin/wecom.js 只是个转发器：
# 它 resolve 到 @wecom/cli-win32-x64 然后 execFileSync 这个 exe。
# 所以直接调 exe 就能完全绕开 Node 运行时——省掉 83MB 的 node.exe，
# 也少一层进程（计划任务环境下 PATH 里通常没有 node，这层越薄越稳）。
_CLI_EXE_NAME = "wecom-cli.exe"
_CLI_EXE_REL = (Path("node_modules") / "@wecom" / "cli" / "node_modules"
                / "@wecom" / "cli-win32-x64" / "bin" / _CLI_EXE_NAME)


def _find_cli_exe() -> str | None:
    cands: list[str] = []
    # 0) 显式指定：部署在非常规位置时最省事，也是唯一不依赖本文件假设的方式
    env_exe = (os.environ.get("WECOM_CLI_EXE") or "").strip()
    if env_exe:
        cands.append(env_exe)
    # 1) 随部署包一起打包的（首选：与项目同生命周期，不受 PATH / 工作区影响）
    cands.append(str(PROJECT_ROOT / "runtime" / "bin" / _CLI_EXE_NAME))
    # 2) 本地 npm 安装位置：项目内 / 项目上一层 / 用户级
    for r in (PROJECT_ROOT / ".tools" / "npm-global",
              PROJECT_ROOT.parent / ".tools" / "npm-global",
              Path(os.path.expandvars(r"%APPDATA%\npm")),
              Path(os.path.expandvars(r"%LOCALAPPDATA%\npm"))):
        cands.append(str(r / _CLI_EXE_REL))
    # 3) PATH（全局安装过 wecom-cli 时）
    w = shutil.which("wecom-cli")
    if w:
        cands.append(w)
    for c in cands:
        if c and Path(c).exists():
            return c
    return None


def _find_node() -> str | None:
    """定位 node.exe（仅用于回退到 node + JS 入口的老路径）。

    不能只靠 PATH：计划任务环境里 PATH 常常不含 node。
    优先用托管运行时的实际安装位置（glob 版本目录，不写死版本号）。
    装在别处时用环境变量 WECOM_NODE_SEARCH_DIRS 补，多个目录用 os.pathsep 分隔。
    """
    cands: list[str] = []
    w = shutil.which("node")
    if w:
        cands.append(w)
    extra_dirs = [s.strip() for s in (os.environ.get("WECOM_NODE_SEARCH_DIRS") or "").split(os.pathsep)
                  if s.strip()]
    for root in (*extra_dirs,
                 os.path.expandvars(r"%LOCALAPPDATA%\binaries\node\versions"),
                 os.path.expandvars(r"%USERPROFILE%\.workbuddy\binaries\node\versions")):
        p = Path(root)
        if p.is_dir():
            cands += [str(x) for x in sorted(p.glob("*/node.exe"), reverse=True)]
    cands.append(r"C:\Program Files\nodejs\node.exe")
    for c in cands:
        if c and Path(c).exists():
            return c
    return None


def _find_cli_entry() -> str | None:
    """定位 wecom-cli 的 JS 入口（回退路径用）。

    用 node + 入口 JS 而不是 wecom-cli.cmd：CreateProcess 不能直接执行 .cmd，
    而经 cmd.exe 中转又会把 --json 里的双引号吃掉。
    """
    rel = Path("node_modules") / "@wecom" / "cli" / "bin" / "wecom.js"
    roots = [
        PROJECT_ROOT / ".tools" / "npm-global",
        PROJECT_ROOT.parent / ".tools" / "npm-global",   # 工具装在项目上一层时
        Path(os.path.expandvars(r"%APPDATA%\npm")),
        Path(os.path.expandvars(r"%LOCALAPPDATA%\npm")),
    ]
    for r in roots:
        p = r / rel
        if p.exists():
            return str(p)
    return None


def _cli_argv(cfg: dict) -> list[str]:
    """返回启动 wecom-cli 的命令行。

    首选直接跑打包的 wecom-cli.exe（不需要 Node）；
    只有当 exe 找不到时才回退到「node + 入口 JS」的老方式。
    """
    wc = cfg.get("wecomcli") or {}
    exe = (wc.get("exe") or "").strip() or _find_cli_exe()
    if exe and Path(exe).exists():
        return [exe]
    entry = (wc.get("entry") or "").strip() or _find_cli_entry()
    if entry and Path(entry).exists():
        node = (wc.get("node") or "").strip() or _find_node()
        if not node:
            raise RuntimeError("找到了 wecom-cli 的 JS 入口，但找不到 node.exe；"
                               "请在 config.json 的 wecomcli.node 里指定路径，"
                               "或改用打包的 wecom-cli.exe")
        return [node, entry]
    raise RuntimeError("找不到 wecom-cli。请双击 deploy.bat 部署，"
                       "或在 config.json 的 wecomcli.exe 里指定可执行文件路径")


def _copy_exe_into_package(src: Path) -> tuple[bool, str]:
    dst = PROJECT_ROOT / "runtime" / "bin" / _CLI_EXE_NAME
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    except Exception as e:                              # noqa: BLE001
        return False, f"复制失败：{type(e).__name__}: {e}"
    if not dst.exists():
        return False, f"复制后仍不存在：{dst}"
    return True, f"已收入部署包：{dst}"


def harvest_cli_exe(src: str | None = None) -> tuple[bool, str]:
    """把 wecom-cli.exe 收进部署包（runtime\\bin\\）。

    这是让部署包「自带推送能力」的关键一步：收进来之后就不再依赖
    npm / Node / 原安装目录，整个包可以随便拷到别的路径甚至别的机器上用。
    纯文件复制，不需要联网。

    src 给定时直接用它（比如刚 npm 装完的产物）；否则按已知位置依次找。
    """
    dst = PROJECT_ROOT / "runtime" / "bin" / _CLI_EXE_NAME
    if dst.exists():
        return True, f"已存在：{dst}"

    if src:
        p = Path(src)
        if not p.exists():
            return False, f"指定的源文件不存在：{p}"
        return _copy_exe_into_package(p)

    roots = [
        PROJECT_ROOT / ".tools" / "npm-global",
        PROJECT_ROOT.parent / ".tools" / "npm-global",
        PROJECT_ROOT / "runtime" / "npm",
        Path(os.path.expandvars(r"%APPDATA%\npm")),
        Path(os.path.expandvars(r"%LOCALAPPDATA%\npm")),
    ]
    found = None
    for r in roots:
        p = r / _CLI_EXE_REL
        if p.exists():
            found = p
            break
    if found is None:
        w = shutil.which("wecom-cli")
        if w:
            found = Path(w)
    if found is None:
        return False, ("本机没有找到 wecom-cli.exe。请先在有 Node 的机器上"
                       "执行 bot.py install-cli，或手动把 wecom-cli.exe "
                       "放到 runtime\\bin\\ 下")
    return _copy_exe_into_package(found)


def _run_cli(argv: list[str], args: list[str], timeout: int = 90):
    p = subprocess.run([*argv, *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return p.returncode, (p.stdout or ""), (p.stderr or "")


# whoami 只返回一段自然语言上下文，需要从中取出「授权真人用户身份」的 ID。
# 注意：这段上下文含机器标识，只能内部使用，禁止外露给用户。
_RE_USERID = re.compile(r"授权真人用户身份：[\s\S]{0,300}?ID：([A-Za-z0-9_\-]{8,})")


def resolve_target(cfg: dict, argv: list[str]) -> str:
    """确定私聊对象（单聊用接收成员的 userid）。"""
    wc = cfg.get("wecomcli") or {}
    if (wc.get("chat_id") or "").strip():
        return wc["chat_id"].strip()
    code, out, err = _run_cli(argv, ["identity", "whoami"])
    m = _RE_USERID.search(out or "")
    if not m:
        raise RuntimeError(
            "无法从 identity whoami 解析出授权人身份，"
            f"返回：{(out or err or '')[:200]}")
    return m.group(1)


def send_aibot(cfg: dict, markdown: str, timeout: int = 90) -> tuple[bool, str]:
    """以智能机器人身份私聊授权人。"""
    argv = _cli_argv(cfg)
    target = resolve_target(cfg, argv)
    payload = json.dumps({"chat_id": target, "msg_type": "markdown",
                          "markdown": {"content": markdown}},
                         ensure_ascii=False)
    code, out, err = _run_cli(argv, ["message", "aibot", "send", "--json", payload],
                              timeout=timeout)
    if code != 0:
        return False, f"wecom-cli 退出码 {code}：{(err or out).strip()[:300]}"
    try:
        obj = json.loads(out)
    except Exception:
        obj = None
    if isinstance(obj, dict):
        ec = obj.get("errcode")
        if ec not in (None, 0):
            return False, f"errcode={ec} errmsg={obj.get('errmsg')}"
    return True, "ok"


# ------------------------------------------------------------------ webhook

def resolve_webhook(value: str) -> str:
    """把配置里的 webhook 值解析成真正的地址。

    两种写法都支持：

        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"  —— 直接写地址（老写法，仍兼容）
        "hooks:<名字>"                                              —— 引用统一的 key 存放处

    为什么引入引用写法：key 收拢到一处之后，轮换不用再逐个脚本/配置去改（架构改进备忘 §2 的 P2）。
    为什么保留老写法：换机器或别人接手时，直接写完整地址也能跑，不强制依赖那个目录。
    """
    v = (value or "").strip()
    if not v.lower().startswith("hooks:"):
        return v
    name = v.split(":", 1)[1].strip()
    # 默认与仓库同级：<kit>/wecom-hooks/。放别处用环境变量 WECOM_HOOKS_DIR 覆盖。
    hooks_dir = os.environ.get("WECOM_HOOKS_DIR") or str(PROJECT_ROOT.parent / "wecom-hooks")
    if hooks_dir not in sys.path:
        sys.path.insert(0, hooks_dir)
    try:
        from webhook_key import webhook_url
    except ImportError as e:
        raise RuntimeError(
            f"配置里用了 hooks:{name} 引用，但读不到读取模块（{hooks_dir}\\webhook_key.py）：{e}"
        ) from None
    return webhook_url(name)


def send_webhook(webhook: str, markdown: str, timeout: int = 15) -> tuple[bool, str]:
    payload = json.dumps({"msgtype": "markdown",
                          "markdown": {"content": markdown}}).encode("utf-8")
    req = urllib.request.Request(
        webhook, data=payload,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "ignore")
        obj = json.loads(body)
        if obj.get("errcode") == 0:
            return True, "ok"
        return False, f"errcode={obj.get('errcode')} errmsg={obj.get('errmsg')}"
    except Exception as e:                              # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


# ------------------------------------------------------------------ 统一入口

CHANNEL_NAMES = {"webhook": "企微群机器人", "wecomcli": "机器人私聊",
                 "stdout": "标准输出"}


def parse_chain(mode: str | None) -> list[str]:
    """把 push_mode 解析成「通道链」。

    支持逗号分隔多个通道，按顺序尝试、**第一个成功即停止**（故障转移）：

        "webhook"           → 只发企微群
        "wecomcli"          → 只发机器人私聊
        "webhook,wecomcli"  → 优先发群；群通道挂了自动改走私聊（当前默认）

    这样做的原因：播报是无人值守的，单一通道的静默失效（授权过期、
    机器人被移出群、密钥被重置）在用户侧看起来和「余额正常」一模一样。
    兼容全角逗号、顿号与空格，方便手改配置时不踩标点的坑。
    """
    text = (mode or "stdout").lower()
    for ch in ("，", "、", ";", "；", " ", "\t", "\r", "\n"):
        text = text.replace(ch, ",")
    chain = [x for x in text.split(",") if x]
    return chain or ["stdout"]


def _deliver_one(cfg: dict, mode: str, markdown: str) -> tuple[bool, str]:
    """走单个通道投递。未知通道返回失败，交由上层决定是否继续降级。"""
    if mode == "webhook":
        wh = ((cfg.get("wecom") or {}).get("webhook") or "").strip()
        if not wh:
            return False, "未配置 wecom.webhook"
        try:
            wh = resolve_webhook(wh)
        except Exception as e:                          # noqa: BLE001
            return False, f"webhook 配置解析失败：{e}"
        return send_webhook(wh, markdown)
    if mode == "wecomcli":
        return send_aibot(cfg, markdown)
    if mode == "stdout":
        print("=== BALANCE_ALERT_MESSAGE_BEGIN ===")
        print(markdown)
        print("=== BALANCE_ALERT_MESSAGE_END ===")
        return True, "已输出到 stdout，等待调用方投递"
    return False, f"未知通道「{mode}」"


def deliver(cfg: dict, markdown: str, dry: bool = False) -> tuple[bool, str]:
    """按配置的通道链投递。dry=True 时只打印不发送。

    任何异常都收敛成 (False, 原因) 返回，不向上抛：
    调用方（尤其是无人值守的定时任务）需要的是日志里一行可读的原因，
    而不是一个堆栈 —— 堆栈会让「推送失败」这件事在日志里难以被发现。

    全部通道都失败时，返回值里带上每一环的失败原因。
    这不是为了好看：降级路径上的失败最容易被忽略，
    必须留痕，否则「悄悄少发了一条」永远没人发现。
    """
    if dry:
        return True, "dry-run（未发送）"

    chain = parse_chain(cfg.get("push_mode"))
    failures: list[str] = []
    for mode in chain:
        try:
            ok, info = _deliver_one(cfg, mode, markdown)
        except Exception as e:                          # noqa: BLE001
            ok, info = False, f"{type(e).__name__}: {e}"
        if ok:
            if failures:
                return True, f"{mode} 成功（已降级，前序失败：{'；'.join(failures)}）"
            return True, info
        failures.append(f"{mode}：{info}")

    return False, ("所有推送通道均失败 → " + "；".join(failures)) if failures \
        else "没有可用的推送通道"


def _probe_one(cfg: dict, mode: str) -> str:
    if mode == "stdout":
        return "可用（由调用方投递）"
    if mode == "webhook":
        raw = ((cfg.get("wecom") or {}).get("webhook") or "").strip()
        if not raw:
            return "未配置（wecom.webhook 为空）"
        try:
            wh = resolve_webhook(raw)
        except Exception as e:                          # noqa: BLE001
            return f"配置解析失败：{e}"
        if "qyapi.weixin.qq.com" not in wh:
            return "地址可疑：不含 qyapi.weixin.qq.com，请核对是否群机器人 webhook"
        src = "（hooks 引用）" if raw.lower().startswith("hooks:") else ""
        return f"已配置{src}（key 尾号 …{wh[-8:]}）"
    if mode == "wecomcli":
        try:
            argv = _cli_argv(cfg)
        except Exception as e:                          # noqa: BLE001
            return f"不可用：{e}"
        code, out, _ = _run_cli(argv, ["auth", "show", "--status"], timeout=30)
        status = (out or "").strip().splitlines()[-1] if out.strip() else "未知"
        if code != 0 or "authorized" not in out:
            return f"未授权（{status}），需重新授权"
        try:
            resolve_target(cfg, argv)
        except Exception as e:                          # noqa: BLE001
            return f"已授权但解析私聊对象失败：{e}"
        return "已授权，私聊对象就绪"
    return f"未知通道「{mode}」"


def probe(cfg: dict) -> str:
    """自检：按通道链顺序报告每个通道的可用性（不发送）。"""
    chain = parse_chain(cfg.get("push_mode"))
    parts = [f"{CHANNEL_NAMES.get(m, m)} {_probe_one(cfg, m)}" for m in chain]
    return " → ".join(parts)
