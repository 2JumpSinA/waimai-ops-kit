"""推广账户余额预警播报。

用法：
  python bot.py                 # 检查并（在需要时）告警，最安全的默认行为
  python bot.py check           # 同上；--verbose 打印全部平台余额，无论是否告警
  python bot.py login           # 【首次必做】开浏览器人工登录，自动抓齐凭据
  python bot.py login --platform meituan   # 只登录某一个平台
  python bot.py set-ele         # 备用：手动粘贴 cURL / Cookie 注入凭据
  python bot.py set-meituan     # 备用：同上
  python bot.py status          # 查看凭据与配置状态
  python bot.py test-send       # 发一条测试消息，验证推送通道
  python bot.py selftest        # 注入故障，验证故障隔离与播报规则

设计要点：
- 多数据源故障隔离：任一平台取数失败都不影响另一平台的播报。
- 两种播报模式（config.always_broadcast）：
    每日播报 —— 每天都推一次，并列展示全部平台，低于预警线的用警示色强调并置顶；
    静默模式 —— 只有低于预警线或取数失败才推送，余额正常时完全不打扰。
- 取数失败必须报出来：静默失败会让人误以为「余额正常」，代价是广告停投。
- 金额单位在平台模块内部归一为元（RETURNS_YUAN），主流程不再做二次换算，
  避免「接口已经是分、外面又除一次」把 490.43 变成 4.90 制造假告警。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from core import loginflow                                # noqa: E402
from core import metrics as mini_metrics                  # noqa: E402
from core import wecom                                   # noqa: E402
from core.logutil import Logger                          # noqa: E402
from core.netutil import assert_no_pii                   # noqa: E402
from core.store import CredStore                         # noqa: E402
from platforms import ele as ele_mod                     # noqa: E402
from platforms import meituan as mt_mod                  # noqa: E402
from platforms.base import BalanceResult, NotConfigured, TransientError     # noqa: E402

# 配置路径可用环境变量覆盖（多环境切换、或配置放在仓库外时用）；默认与本文件同目录。
CONFIG_PATH = Path(os.environ.get("BALANCE_ALERT_CONFIG") or (ROOT / "config.json"))
EXAMPLE_CONFIG = ROOT / "config.example.json"
LOG_DIR = ROOT / "logs"


def load_config() -> dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        # 开源场景下 config.json 不随包提交，第一次跑必然缺；给一句能照着敲的提示，
        # 而不是让用户看 Python 的 traceback。
        raise SystemExit(
            f"未找到配置文件：{CONFIG_PATH}\n"
            f"  首次使用请先复制示例再填真实值：\n"
            f"    copy \"{EXAMPLE_CONFIG}\" \"{CONFIG_PATH}\"\n"
            f"  或用环境变量 BALANCE_ALERT_CONFIG 指向已有的配置文件。"
        ) from None


def build_store(cfg: dict, log: "Logger | None" = None) -> CredStore:
    store = CredStore(cfg.get("keyring_service", "waimai-ops-kit"), ROOT / "creds")
    # 统一凭据模块 ②a-1：profile 正本 → 缓存兜底。
    # cookie_source=profile（缺省）：get() 先读浏览器 profile，不可达回退缓存并 WARN；
    # cookie_source=credman：旧行为，只读凭据管理器，绝不碰 CDP。
    store.configure_source(cfg, logger=log)
    return store


# ---------------------------------------------------------------- 取数

# 驱动名 -> 取数模块。一个驱动可以被多个账号复用（例如淘宝闪购的两个品牌），
# 账号差异（凭据键名、品牌名）全在 config.platforms 里描述，不写进代码。
PLATFORM_MODULES = {"ele": ele_mod, "meituan": mt_mod}


def driver_of(key: str, cfg: dict) -> str:
    """这个账号用哪个取数驱动。老配置没写 driver 时，键名本身就是驱动名。"""
    return (cfg["platforms"].get(key) or {}).get("driver") or key


def module_of(key: str, cfg: dict):
    drv = driver_of(key, cfg)
    mod = PLATFORM_MODULES.get(drv)
    if mod is None:
        raise KeyError(f"未知取数驱动「{drv}」（platforms.{key}.driver 只能填 "
                       f"{' / '.join(PLATFORM_MODULES)}）")
    return mod


def cred_key_of(key: str, cfg: dict) -> str:
    """这个账号的凭据键名。

    必须逐账号独立：两个品牌是两个登录态，共用一个键名会让后配置的
    覆盖前一个 —— 表现是「一个账号的余额被当成另一个账号的余额」，
    数字还都在合理范围内，肉眼根本看不出来。
    """
    p = cfg["platforms"].get(key) or {}
    return p.get("cred_key") or getattr(module_of(key, cfg), "CRED_KEY",
                                        f"{key}_cookie")


def display_of(key: str, cfg: dict) -> str:
    p = cfg["platforms"].get(key) or {}
    if p.get("display_name"):
        return p["display_name"]
    brand, label = p.get("brand"), p.get("label")
    if brand and label:
        return f"{brand}·{label}"
    return label or brand or key


def _fetch_one_once(key: str, cfg: dict, store: CredStore) -> BalanceResult:
    """取单个平台余额（单次尝试）。除 TransientError 外，异常都收敛成 error 字段。"""
    pcfg = cfg["platforms"][key]
    name = display_of(key, cfg)
    try:
        mod = module_of(key, cfg)
        res = mod.fetch_balance(cfg, store, key=key, cred_key=cred_key_of(key, cfg))
        res.key, res.display_name = key, name
        # 接口可能返回「分」而页面显示「元」，差 100 倍。
        # 但平台模块若声明 RETURNS_YUAN=True，说明它自己已经归一成元了，
        # 这时候再除一次就是双重换算（490.43 -> 4.90），会制造假告警。
        div = pcfg.get("unit_divisor")
        if getattr(mod, "RETURNS_YUAN", False):
            if div and float(div) not in (0.0, 1.0):
                res.note = (res.note + "；" if res.note else "") + (
                    f"⚠️ 忽略了配置里的 unit_divisor={div}（该平台已自行归一为元）")
        elif div and res.balance is not None and float(div) not in (0.0, 1.0):
            res.balance = res.balance / float(div)
            res.note = (res.note + "；" if res.note else "") + f"已按 ÷{div} 换算为元"
        return res
    except NotConfigured as e:
        # 还没配置 ≠ 取数失败。这是待办事项，不该每天播报，
        # 否则会把用户训练到无视告警。只在 verbose / status 里可见。
        return BalanceResult(key=key, display_name=name, balance=None,
                             error=str(e), pending=True)
    except TransientError:
        raise                                            # 交给 fetch_one 重试
    except Exception as e:                               # noqa: BLE001
        return BalanceResult(key=key, display_name=name, balance=None,
                             error=f"{type(e).__name__}: {e}")


def _note(msg: str) -> None:
    """诊断输出。计划任务用 pythonw 运行时 sys.stdout 可能是 None，必须兜底。"""
    try:
        out = sys.stdout
        if out is not None:
            out.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n")
            out.flush()
    except Exception:                                    # noqa: BLE001
        pass


def fetch_one(key: str, cfg: dict, store: CredStore,
              deadline: float | None = None) -> BalanceResult:
    """取单个平台余额：临时失败会重试，最终任何异常都收敛成 error 字段。

    为什么要重试：美团要起无头 Chrome，「页面没就绪 / 连接被重置」是常态，
    而第一次抖动就把账户判死，会让整天的播报里少一个账户 —— 2026-09-18 的
    09:00 播报就这样丢过美团，而「少一个账户」和「余额正常」肉眼上很难区分。
    凭据失效、未配置这类确定性错误不重试，立即返回。

    为什么预算必须是**全局**的（deadline 由调用方传入）：采集器
    （若配合企微快查询通道）给整条命令的总超时是 180s，超时被杀 →
    一个字节都没输出 → 快照不更新 → 群里报「数据陈旧」。2026-10-19 采集中断
    8 小时的直接原因就是这里的预算按「每个账号各 150s」算 —— 4 个账号最坏
    600s，前面账号的重试把后面账号的份额全吃了。改成 cmd_run 在循环外算一次
    全局 deadline，所有账号共享同一个余额：前一个账号烧掉多少，后面的就少多少，
    从而保证 render()（部分成功文案）总能来得及执行。
    传 deadline=None（登录验证等单账号场景）时退回旧的按次预算，行为不变。
    """
    name = display_of(key, cfg)
    attempts = max(1, int(cfg.get("transient_retries", 2)) + 1)
    delay = float(cfg.get("transient_retry_delay_sec", 20))
    budget = float(cfg.get("run_budget_sec", 150) or 0)
    if deadline is None:
        run_start = time.monotonic()
        deadline = (run_start + budget) if budget > 0 else None

    # 全局预算已被前面的账号烧光：连无头 Chrome 都不用起（起一个 ~10s），
    # 直接标记失败把时间留给 render() —— 否则最后一个账号会在超时边缘被强杀，
    # 连它的失败行都来不及写进正文（2026-10-19 的 0B 快照就是这么来的）。
    if deadline is not None and time.monotonic() > deadline - 20:
        _note(f"[{key}] {name} 全局时间预算已尽（剩余 "
              f"{deadline - time.monotonic():.0f}s），本账号跳过取数")
        return BalanceResult(
            key=key, display_name=name, balance=None,
            error="临时取数失败（全局时间预算已尽，本账号未尝试；其余账号数据见上）")

    for attempt in range(1, attempts + 1):
        t0 = time.monotonic()
        try:
            return _fetch_one_once(key, cfg, store)
        except TransientError as e:
            took = time.monotonic() - t0
            if attempt < attempts:
                # 下一轮至少还要跑这么久；再叠加间隔。撞线就别重试了。
                if deadline is not None and time.monotonic() + delay + took * 1.2 > deadline:
                    _note(f"[{key}] {name} 时间预算不足（累计已用 "
                          f"{time.monotonic() - (deadline - budget):.0f}s / 预算 {budget:.0f}s），"
                          f"跳过剩余重试：{e}")
                    return BalanceResult(
                        key=key, display_name=name, balance=None,
                        error=f"临时取数失败（为避免整批超时，已跳过剩余重试）：{e}")
                _note(f"[{key}] {name} 临时取数失败（第 {attempt}/{attempts} 次），"
                      f"{delay:.0f}s 后重试：{e}")
                time.sleep(delay)
                continue
            return BalanceResult(key=key, display_name=name, balance=None,
                                 error=f"临时取数失败（已重试 {attempts} 次）：{e}")


def threshold_of(key: str, cfg: dict) -> float:
    t = cfg["platforms"][key].get("threshold")
    return float(t if t is not None else cfg.get("default_threshold", 0))


# ---------------------------------------------------------------- 渲染

def _brand_of(key: str, cfg: dict) -> str:
    return (cfg["platforms"].get(key) or {}).get("brand") or ""


def _label_of(key: str, cfg: dict) -> str:
    """分组里用的短名（只有渠道名，品牌由分组标题给出）。"""
    p = cfg["platforms"].get(key) or {}
    return p.get("label") or display_of(key, cfg)


def _grouped(items: list, cfg: dict) -> list[tuple[str, list]]:
    """按品牌分组，顺序沿用 config 里的定义顺序（用户是按品牌排的）。

    多个品牌时，若只靠每行前面加品牌名，长列表会很难扫读；分组标题能让人
    一眼分清「哪几个数字是品牌B的、哪几个是品牌A的」。置顶的告警行反而要带
    品牌名 —— 它已经脱离了自己所属的分组。
    """
    order, groups = [], {}
    for r in items:
        b = _brand_of(r.key, cfg)
        if b not in groups:
            groups[b] = []
            order.append(b)
        groups[b].append(r)
    return [(b, groups[b]) for b in order]


def _print_preview(msg: str, orig_out=None) -> None:
    """把 `--preview` 的文案写到控制台，**编码不安全时降级**而不是静默吞掉。

    为什么不能直接 `print(msg)`（这是改动前就存在的缺陷，2026-10-22 验收时暴露）：
      1. Windows 控制台默认 GBK，文案里有 `¥`（U+00A5）和全角标点，直接写会抛
         `UnicodeEncodeError`；
      2. 此时 `sys.stdout` 已被 `Logger.attach()` 换成 `_Tee`，而 `_Tee.write` 是
         `try/except: pass` —— **异常被吞掉**，于是「预览模式：文案已打印」照常说，
         屏幕上是空消息。验收要「逐字比对余额文案」，前提是它真能打出来。
    所以调用方把 `Logger` 记下的**原始 stdout** 传进来（`orig_out`），这里绕开 Tee，
    并自带编码降级。

    降级顺序：原样写 → `backslashreplace` 重写 → 落 `logs/preview.txt` 并指路。
    """
    bar = "=" * 60
    text = f"\n{bar}\n{msg}\n{bar}\n"
    out = orig_out if orig_out is not None else sys.stdout
    if out is not None:
        try:
            out.write(text)
            out.flush()
            return
        except (UnicodeEncodeError, AttributeError):
            try:
                enc = getattr(out, "encoding", None) or "utf-8"
                safe = text.encode(enc, errors="backslashreplace").decode(enc, errors="replace")
                out.write(safe)
                out.flush()
                return
            except Exception:                              # noqa: BLE001
                pass
        except Exception:                                  # noqa: BLE001
            pass
    # 最后兜底：落文件。至少文案不会凭空消失。
    try:
        p = LOG_DIR / "preview.txt"
        p.write_text(text, encoding="utf-8")
        if out is not None:
            out.write(f"（控制台编码不支持，文案已写入 {p}）\n")
    except Exception:                                      # noqa: BLE001
        pass


def render(results: list[BalanceResult], cfg: dict) -> tuple[str, bool]:
    """渲染播报文案。返回 (markdown, 是否需要推送)。

    两种模式：
    - always_broadcast=True（每日播报）：无论余额是否正常都推送，把所有平台
      并列展示，低于预警线的用 warning 色 + ⚠️ 强调标注；
    - always_broadcast=False（静默模式）：只有「低于预警线」或「取数失败」
      才推送，其余情况返回空文案。
    """
    always = bool(cfg.get("always_broadcast", False))

    alerted, normal, errors, pending = [], [], [], []
    for r in results:
        if r.pending:
            pending.append(r)
        elif r.error:
            errors.append(r)
        elif r.balance is not None and r.balance < threshold_of(r.key, cfg):
            alerted.append(r)
        else:
            normal.append(r)

    # 静默模式下未配置的平台不进文案：天天播报「你还没设置」会把用户
    # 训练到无视告警。每日播报模式下则如实列出，否则会被误读成平台掉了。
    if not alerted and not errors and not always:
        return "", False

    title = "推广账户余额播报" if always else "推广账户余额预警"
    lines = [f"**{title}**", ""]

    # 要充值的排最前：强调的目的是让人一眼看到问题，而不是让人往下翻。
    for r in alerted:
        th = threshold_of(r.key, cfg)
        lines.append(
            f"**{r.display_name}**　<font color=\"warning\">¥{r.balance:,.2f}</font>"
            f" ／ 预警线 ¥{th:,.2f}"
            f"　<font color=\"warning\">⚠️ 低于预警线，建议充值</font>")
        if r.note:
            lines.append(f"> {r.note}")
    if alerted:
        lines.append("")

    for brand, items in _grouped(normal + errors + pending, cfg):
        if brand:                       # 没配 brand 的老配置就平铺，不硬造标题
            if lines and lines[-1] != "":
                # 组间空一行：否则上一组最后一条会紧贴下一组的标题，
                # 读起来像同一条，分组反而起了反作用。
                lines.append("")
            lines.append(f"**{brand}**")
        for r in items:
            label = _label_of(r.key, cfg)
            if r.error:
                tag = "待配置" if r.pending else "取数失败"
                lines.append(f"· **{label}**　<font color=\"comment\">{tag}</font>"
                             f"\n> {r.error}")
            else:
                th = threshold_of(r.key, cfg)
                lines.append(f"· **{label}**　¥{r.balance:,.2f} ／ 预警线 ¥{th:,.2f}")

    if errors and not alerted:
        lines.append("")
        lines.append("> 未能确认余额，请人工核对后再判断是否需要充值。")

    # ── 今日经营（看板轻指标，可选且故障隔离）──
    # 取不到（文件没导出 / 结构改版 / 超时）→ 这一段整段不出现，消息与改动前逐字相同。
    # 见 core/metrics.py 的三条约束；播报口径（预计收入，不是成交额）由看板侧 caliber 保证。
    lines += _mini_section(cfg)

    return "\n".join(lines), True


def _mini_section(cfg: dict) -> list[str]:
    """「今日经营」小节的若干行（含前置空行）；关闭或取不到时返回空列表。

    刻意**不抛异常**：余额播报是主业，轻指标是附加物。任何意外都在这里收掉，
    只往日志里留一行原因 —— 不能让一个附加小节把整条播报搞砸。
    """
    mcfg = cfg.get("mini_metrics") or {}
    if not mcfg.get("enabled", False):
        return []
    try:
        mini = mini_metrics.load_mini(mcfg.get("path") or None)
    except Exception as e:  # noqa: BLE001 —— 兜底：模块内部已收敛，这里再兜一层
        _note(f"[mini] 读取异常已忽略：{type(e).__name__}: {e}")
        return []
    if not mini.get("ok"):
        _note(f"[mini] 今日经营小节跳过：{mini.get('error')}")
        return []
    try:
        body = mini_metrics.render_mini(mini)
    except Exception as e:  # noqa: BLE001
        _note(f"[mini] 渲染异常已忽略：{type(e).__name__}: {e}")
        return []
    if not body:
        return []
    return [""] + body


def render_all(results: list[BalanceResult], cfg: dict) -> str:
    """verbose：无论是否告警都打印全部平台余额（不推送）。"""
    lines = [f"**推广账户余额**", ""]

    def _key(r):
        return 0 if (r.balance is not None and not r.error
                     and r.balance < threshold_of(r.key, cfg)) else 1

    # 低于预警线的排最前（这一批仍用完整名，因为它脱离了品牌分组）
    def _line(r, short: bool):
        name = _label_of(r.key, cfg) if short else r.display_name
        if r.pending:
            return [f"**{name}**　<font color=\"comment\">待配置</font>"
                    f"\n> {r.error}"]
        if r.error:
            return [f"**{name}**　<font color=\"comment\">取数失败</font>"
                    f"\n> {r.error}"]
        th = threshold_of(r.key, cfg)
        low = r.balance is not None and r.balance < th
        flag = "　<font color=\"warning\">⚠️ 低于预警线，建议充值</font>" if low else ""
        price = (f"<font color=\"warning\">¥{r.balance:,.2f}</font>"
                 if low else f"¥{r.balance:,.2f}")
        out = [f"**{name}**　{price} ／ 预警线 ¥{th:,.2f}{flag}"]
        # 溯源只在 verbose 露出，不进推送文案
        if r.provenance:
            out.append(f"> 来源：{r.provenance}")
        if r.note:
            out.append(f"> 说明：{r.note}")
        return out

    lows = [r for r in sorted(results, key=_key) if _key(r) == 0]
    for r in lows:
        lines += _line(r, short=False)
    if lows:
        lines.append("")

    rest = [r for r in sorted(results, key=_key) if _key(r) == 1]
    for brand, items in _grouped(rest, cfg):
        if brand:
            if lines and lines[-1] != "":
                lines.append("")
            lines.append(f"**{brand}**")
        for r in items:
            lines += _line(r, short=bool(brand))
    return "\n".join(lines)


# ---------------------------------------------------------------- 命令

def cmd_run(cfg: dict, args) -> int:
    log = Logger(LOG_DIR, "bot")
    log.attach()
    log.line("=" * 60)
    log.line(f"开始检查余额　mode={cfg.get('push_mode')}　verbose={args.verbose}")

    store = build_store(cfg, log=log)
    results = []
    # 全局时间预算：所有启用账号共享同一个 deadline（见 fetch_one 的 docstring）。
    # 采集器给整条命令 180s，这里按 run_budget_sec=150s 掐线，留 30s 给
    # render + 快照落盘 —— 哪怕美团两个账号全挂，另外两个账号的数字也能出得来。
    _budget = float(cfg.get("run_budget_sec", 150) or 0)
    global_deadline = (time.monotonic() + _budget) if _budget > 0 else None
    for key, pcfg in cfg["platforms"].items():
        if not pcfg.get("enabled"):
            log.line(f"[{key}] 已禁用，跳过")
            continue
        res = fetch_one(key, cfg, store, deadline=global_deadline)
        if res.pending:
            log.line(f"[{key}] 待配置：{res.error}")
        elif res.error:
            log.line(f"[{key}] 取数失败：{res.error}")
        else:
            log.line(f"[{key}] {res.display_name} 余额 = {res.balance}")
        results.append(res)

    if not results:
        log.line("没有任何启用的平台，不推送。")
        log.close()
        return 0

    if args.verbose:
        msg = render_all(results, cfg)
        flag = True
    else:
        msg, flag = render(results, cfg)

    if not flag:
        log.line("全部正常，无需告警，不推送。")
        log.close()
        return 0

    if cfg.get("safety", {}).get("pii_guard"):
        # 默认关闭：余额播报本身不含个人信息，开启后反而可能被
        # 错误信息里的长数字（trace id / 时间戳）误伤而拦住真告警。
        assert_no_pii(msg)

    # --preview：把「将会发出去的那条消息」原样打出来，不投递。
    # 必要性：--verbose 走的是 render_all()，和真正推送用的 render() 不是同一条
    # 路径，所以光靠 verbose 没法在发送前确认用户到底会看到什么
    # （分组对不对、告警有没有置顶、颜色标注在不在）。
    if getattr(args, "preview", False):
        # ⚠️ 必须显式写编码兜底：Windows 控制台默认 GBK（cp936），而播报文案里有 `¥`
        # 和全角标点 —— 直接 print() 会抛 UnicodeEncodeError；更糟的是 stdout 已被
        # Logger 换成 _Tee，它把异常吞掉，于是「预览模式：文案已打印」照常说，
        # 屏幕上却是一条空消息。这是既有缺陷（改动前 `--preview` 就只打印空行），
        # 这里修掉，保证验收能真的看见余额文案。
        _print_preview(msg, log._orig_out)
        log.line("预览模式：文案已打印，未投递")
        log.close()
        return 0

    success, info = wecom.deliver(cfg, msg, dry=args.dry)
    log.line(f"推送结果：{'成功' if success else '失败'}　{info}")
    log.close()
    return 0 if success else 2


def cmd_set(key: str, args) -> int:
    cfg = load_config()
    if key not in cfg["platforms"]:
        print(f"❌ config.json 里没有名为「{key}」的平台项。")
        print(f"   当前已配置：{', '.join(cfg['platforms'])}")
        print("   要新增账号：把 platforms 里任意一段复制一份，改键名、"
              "cred_key、brand 三个字段。")
        return 1
    store = build_store(cfg)
    try:
        mod = module_of(key, cfg)
    except KeyError as e:
        print(f"❌ {e}")
        return 1
    name = display_of(key, cfg)
    cred_key = cred_key_of(key, cfg)
    text = args.text

    if not text and getattr(args, "file", ""):
        p = Path(args.file.strip().strip('"'))
        if not p.exists():
            print(f"❌ 找不到文件：{p}")
            return 1
        text = p.read_text(encoding="utf-8", errors="ignore")

    if not text:
        print(f"请粘贴 {name} 的 cURL 文本（整段），或直接从浏览器复制 Cookie 字符串。")
        print("（也可以把这个 .bat 拖到含 cURL 的 txt 文件上，或先运行："
              f"python bot.py set-{key.replace('_', '-')} --file 路径)")
        print("粘贴完成后按回车两次，或输入单独一行 END 结束：")
        chunks = []
        while True:
            try:
                line = input()
            except EOFError:
                break
            if line.strip() == "END":
                break
            chunks.append(line)
        text = "\n".join(chunks).strip()

    if not text or not text.strip():
        print("没有输入内容，已取消。")
        return 1
    ok, msg = mod.save_credential(store, text, cfg, cred_key=cred_key, key=key)
    # 消息里要带上账号名与凭据键名：配错账号时，光看「已保存凭据」发现不了。
    print(("✅ " if ok else "❌ ") + f"[{name} · 凭据键 {cred_key}] " + msg)
    if store.degraded_reason:
        print("注意：" + store.degraded_reason)
    return 0 if ok else 1


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")


def cmd_login(cfg: dict, args) -> int:
    """开浏览器人工登录一次，自动抓齐凭据并当场验证取数。"""
    bar = "=" * 58
    print(bar)
    print("  推广账户余额预警 · 登录捕获（首次必做）")
    print(bar)
    print("  接下来会打开一个浏览器窗口（不影响你正在用的浏览器）：")
    print("    1) 在新窗口里完成登录（扫码即可）")
    print("    2) 登录后点进能看到「余额」的页面")
    print("    3) 脚本检测到余额数字后会自动继续，不需要按键")
    print()
    print("  上次没成功也没关系，重新双击 login.bat 再来一次即可。")
    print(bar)

    if args.platform:
        keys = [args.platform]
    else:
        keys = [k for k, v in cfg["platforms"].items() if v.get("enabled")]

    store = build_store(cfg)
    failed = []
    for key in keys:
        rep = loginflow.interactive_login(key, cfg, store,
                                          cred_key=cred_key_of(key, cfg))
        if not rep.get("ok"):
            print(f"❌ {key} 登录捕获失败：{rep.get('error')}")
            failed.append(key)
            continue

        p = cfg["platforms"][key]
        div = rep.get("unit_divisor")
        # 已自行归一为元的平台不写 unit_divisor：写了也只会在取数时被忽略/告警，
        # 徒增误导。标定结果仍留在 recon 报告里供人工核对。
        if div and getattr(module_of(key, cfg), "RETURNS_YUAN", False):
            print(f"  （{key} 模块已自行归一为元，跳过写入 unit_divisor={div}）")
            div = None
        if div and p.get("unit_divisor") != div:
            p["unit_divisor"] = div
            if rep.get("balance_field"):
                p["balance_field"] = rep["balance_field"]
            save_config(cfg)
            print(f"  已把金额单位标定结果写入 config.json（unit_divisor={div}）")

        print("  正在验证取数…", flush=True)
        res = fetch_one(key, cfg, store)
        if res.error:
            print(f"  ⚠️ 取数验证未通过：{res.error}")
            failed.append(key)
        else:
            note = f"（{res.note}）" if res.note else ""
            print(f"  ✅ 取数验证通过：{res.display_name} 余额 "
                  f"¥{res.balance:,.2f}{note}")
        print()

    print("=" * 62)
    if failed:
        print(f"以下平台未完成：{', '.join(failed)}")
        print("可以重新双击 login.bat 再试一次。")
        return 2
    print("全部完成。可以运行 check-now.bat 看一次真实播报效果。")
    return 0


def cmd_status(cfg: dict, args) -> int:
    store = build_store(cfg)
    mode = "每天必播（低于预警线强调标注）" if cfg.get("always_broadcast") else "静默（仅异常时推送）"
    print(f"push_mode      : {cfg.get('push_mode')}")
    print(f"播报模式       : {mode}")
    print(f"默认预警线     : ¥{cfg.get('default_threshold')}")
    print(f"计划检查时间   : 每天 {cfg['schedule']['hour']:02d}:{cfg['schedule']['minute']:02d}")
    print(f"运行位置       : {ROOT}")
    import sys
    bundled_py = ROOT / "runtime" / "python" / "python.exe"
    print(f"Python 运行时  : {sys.executable}"
          + ("（随部署包打包，不依赖外部安装）" if bundled_py.exists() else "（外部安装）"))
    bundled_cli = ROOT / "runtime" / "bin" / "wecom-cli.exe"
    print(f"推送程序       : {'runtime\\bin\\wecom-cli.exe（随包打包）' if bundled_cli.exists() else '需外部安装'}")
    print("-" * 46)
    for key, pcfg in cfg["platforms"].items():
        th = threshold_of(key, cfg)
        try:
            mod = module_of(key, cfg)
            drv = driver_of(key, cfg)
        except KeyError as e:
            print(f"{key:<12} ❌ {e}")
            continue
        cred = store.status(cred_key_of(key, cfg))
        div = pcfg.get("unit_divisor")
        if div and getattr(mod, "RETURNS_YUAN", False):
            extra = f"  ⚠️ unit_divisor={div} 已失效（该平台自行归一为元）"
        elif div:
            extra = f"  金额换算=÷{div}"
        else:
            extra = ""
        print(f"{display_of(key, cfg):<16} [{key}] 驱动={drv} 启用={pcfg.get('enabled')}  "
              f"预警线=¥{th:,.0f}  凭据={cred}{extra}")
    print("-" * 46)
    print("推送通道      : " + wecom.probe(cfg))
    return 0


def cmd_check_source(cfg: dict, args) -> int:
    """统一凭据模块体检：逐账号打印 端口→探活→cookie 条数→关键 cookie→来源。

    退出码：0 = 全部账号有凭据（无论来源是 profile 还是缓存）；
            1 = 至少一个账号完全无凭据（profile 不可达且缓存为空）。
    """
    from core import profile_cookie as pc

    KEY_COOKIES = {
        "ele": ("_m_h5_tk", "OUTER_AUTH_LOGIN", "WMUSS", "WMSTOKEN",
                "UNIFACTION", "UNIFACCTID"),
        # controlType 不在登录态判断里（登录态看 token/acctId），但它缺失时
        # /account/r/queryAcctBalance 会 400 "Missing cookie 'controlType'"，
        # 取数照样失败 —— 所以列入关键项，缺了要在 check-source 就看见。
        "meituan": ("token", "acctId", "acctLogin", "WEBDFPID", "device_uuid",
                    "controlType"),
    }
    store = build_store(cfg)
    print(f"cookie_source = {store.cookie_source}　"
          f"端口映射 = {store.profile_ports}")
    print("-" * 72)
    all_ok = True
    for key, pcfg in cfg["platforms"].items():
        if not pcfg.get("enabled"):
            print(f"{key:<12} 已禁用，跳过")
            continue
        cred_key = cred_key_of(key, cfg)
        driver = driver_of(key, cfg)
        # 端口映射按「账号键优先、驱动名兜底」查：ele_yf 这类账号在
        # profile_ports 里有自己的条目（9223），不能因为驱动是 ele 就
        # 落到品牌A的 9222 上。
        port = store.profile_ports.get(key) or store.profile_ports.get(driver)
        if store.cookie_source != "profile":
            have = store._cache_get(cred_key)
            src = "credman（未启用 profile）"
            print(f"{key:<12} [{cred_key}] 驱动={driver}  来源={src}  "
                  f"缓存={'有' if have else '无'}")
            if not have:
                all_ok = False
            continue
        if not port:
            print(f"{key:<12} ❌ profile_ports 里没有驱动「{driver}」的端口映射")
            all_ok = False
            continue
        alive = pc.probe_port(port)
        cookies = pc.fetch_profile_cookies(port) if alive else None
        n = len(cookies) if cookies else 0
        hits, missing = [], []
        wanted = KEY_COOKIES.get(driver, ())
        for w in wanted:
            if cookies and w in cookies:
                hits.append(w)
            else:
                missing.append(w)
        cache_val = store._cache_get(cred_key)
        src = "profile" if (cookies and hits) else "缓存"
        if src == "缓存" and not cache_val:
            src = "❌ 无凭据"
            all_ok = False
        key_state = (f"关键项 {'/'.join(hits) if hits else '—'}"
                     + (f"；缺 {len(missing)} 项" if missing and hits else
                        (f"；缺全部 {len(missing)} 项" if missing else "")))
        print(f"{key:<12} [{cred_key}] 端口={port} "
              f"{'UP' if alive else 'DOWN'}　cookie={n} 项　"
              f"{key_state}　来源={src}")
    print("-" * 72)
    print("说明：来源=profile 表示端口在线且关键项齐全；"
          "端口 DOWN / 关键项缺失时运行时会自动回退缓存并打 WARN。")
    return 0 if all_ok else 1
    print("=" * 58)
    print("  推送通道测试")
    print("=" * 58)
    print(f"  按 config.json 的 push_mode 依次尝试：{cfg.get('push_mode')}")
    print("  想只看文案、不发消息，就把 push_mode 设成 stdout。")
    print("-" * 58)
    msg = ("**余额预警播报 测试消息**\n"
           "> 如果你看到这条消息，说明推送通道已经打通。\n"
           f"> 时间：{datetime.now():%Y-%m-%d %H:%M}")
    ok, info = wecom.deliver(cfg, msg, dry=args.dry)
    print(("✅ 推送成功 " if ok else "❌ 推送失败 ") + info)
    return 0 if ok else 2


TASK_NAME = "WaimaiDailyBroadcast"

# Windows 计划任务用 XML 注册。不用 schtasks 命令行拼参数，是因为
# /TR 的值里只要路径带空格，引号就会被 cmd 吃掉，任务会注册成一条
# 指向错误路径的哑任务 —— 而且是静默的，正是最不该出的错。
_TASK_XML = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>推广账户余额预警播报（淘宝闪购 / 美团）</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>{boundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
      <WorkingDirectory>{workdir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def _run_schtasks(*argv: str) -> tuple[int, str]:
    import subprocess
    try:
        p = subprocess.run(["schtasks", *argv], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
    except Exception as e:                              # noqa: BLE001
        # 启动 schtasks 本身失败（安全策略禁止、PATH 里没有它、被杀软拦…）。
        # 不能让它抛出去：调用方要的是「这一步没成功」这个事实，
        # 而不是一个把整个部署流程打断的堆栈 —— 那样后面的试跑和
        # 「部署完成」提示都看不到了，用户只会觉得脚本跑到一半没了。
        return 1, f"{type(e).__name__}: {e}"
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def cmd_task_install(cfg: dict, args) -> int:
    import os
    from xml.sax.saxutils import escape
    if os.name != "nt":
        print("当前系统不是 Windows，请改用系统的定时机制（cron / launchd）。")
        return 1

    wrapper = ROOT / "run-check.bat"
    if not wrapper.exists():
        print(f"❌ 找不到定时任务入口：{wrapper}")
        return 1

    # 入口用「隐藏启动器」而不是直接把 .bat 交给计划任务：
    # 计划任务拉 .bat 会连带拉起一个控制台窗口，每天 09:00 在用户桌面上闪一下。
    # wscript.exe 属于 GUI 子系统，自身不创建控制台，再由它用隐藏窗口样式
    # 去拉 cmd.exe，整条链路都不会有窗口出现。
    # 找不到启动器时退回直接跑 .bat：宁可闪一下黑框，也不能不干活。
    hider = ROOT / "run-hidden.vbs"
    wscript = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "wscript.exe"
    if hider.exists() and wscript.exists():
        command, arguments = str(wscript), f'"{hider}"'
        silent = True
    else:
        command, arguments = str(wrapper), ""
        silent = False

    h = int(cfg["schedule"]["hour"])
    m = int(cfg["schedule"]["minute"])
    boundary = f"{datetime.now():%Y-%m-%d}T{h:02d}:{m:02d}:00"
    xml = _TASK_XML.format(boundary=boundary,
                           command=escape(command),
                           arguments=escape(arguments),
                           workdir=escape(str(ROOT)))

    xml_path = LOG_DIR / "task.xml"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    xml_path.write_text(xml, encoding="utf-16")      # 计划任务要求 UTF-16

    code, out = _run_schtasks("/Create", "/TN", TASK_NAME,
                              "/XML", str(xml_path), "/F")
    print(f"注册计划任务 {TASK_NAME}（每天 {h:02d}:{m:02d}）")
    if code != 0:
        print(f"❌ 创建失败（退出码 {code}）\n{out.strip()}")
        print("   若提示权限不足，请右键 install-task.bat → 以管理员身份运行。")
        return 2
    print("✅ 已创建")
    print(f"   入口：{wrapper}")
    if silent:
        print(f"   以隐藏窗口方式拉起（不会有黑框）：{command} {hider.name}")
    else:
        print("   ⚠️ 未找到 run-hidden.vbs，直接跑 .bat —— 运行时会有控制台窗口一闪。")
        print("      把 run-hidden.vbs 放回本目录并重新注册即可消除。")
    print(f"   试跑：schtasks /Run /TN \"{TASK_NAME}\"")
    return 0


def cmd_task_remove(cfg: dict, args) -> int:
    import os
    if os.name != "nt":
        print("非 Windows 系统，跳过。")
        return 0
    code, out = _run_schtasks("/Delete", "/TN", TASK_NAME, "/F")
    if code != 0:
        print(f"⚠️ 删除未成功（可能本来就不存在）：{out.strip()}")
        return 0
    print(f"✅ 已删除计划任务 {TASK_NAME}")
    return 0


def cmd_task_status(cfg: dict, args) -> int:
    import os
    if os.name != "nt":
        return 0
    code, out = _run_schtasks("/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST")
    if code != 0:
        print(f"计划任务 {TASK_NAME}：未安装")
        return 0
    keep = ("TaskName", "Next Run Time", "Last Run Time", "Last Result",
            "Status", "任务名", "下次运行时间", "上次运行时间", "上次结果", "状态")
    print("计划任务：")
    for line in out.splitlines():
        if any(k in line for k in keep) and line.strip():
            print("  " + line.strip())
    hb = LOG_DIR / "heartbeat.txt"
    if hb.exists():
        tail = hb.read_text(encoding="utf-8", errors="replace").splitlines()[-5:]
        print("  最近心跳：")
        for t in tail:
            print("    " + t)
    return 0


def cmd_install_cli(cfg: dict, args) -> int:
    """让部署包自带 wecom-cli。

    两条路：
    1) 本机已经装过 wecom-cli → 直接把 exe 复制进 runtime\\bin\\（离线、瞬间完成，
       之后整个目录可以搬到任意路径甚至别的机器）；
    2) 没装过 → 回退到 npm 安装（需要 Node 和网络）。
    """
    dst = ROOT / "runtime" / "bin" / "wecom-cli.exe"
    if dst.exists() and not args.force:
        print(f"✅ 推送程序已在部署包内：{dst}")
        print("   要强制重新收取请加 --force")
        return 0

    print("先尝试从本机已安装位置收取 wecom-cli.exe（不需要 Node / 联网）…")
    ok, info = wecom.harvest_cli_exe()
    if ok:
        print(f"✅ {info}")
        print("   现在整个目录已自带推送能力，可直接拷到其它路径使用。")
        return 0
    print(f"   （{info}）")

    # ---- 回退：npm 安装 ----
    import subprocess
    target = ROOT / "runtime" / "npm"
    entry = target / "node_modules" / "@wecom" / "cli" / "bin" / "wecom.js"

    node = wecom._find_node()
    if not node:
        print("❌ 找不到 node.exe，也无法从本机收取现成的 wecom-cli.exe。")
        print("   处理办法（任选其一）：")
        print("   1) 在装过 wecom-cli 的机器上执行 bot.py install-cli，")
        print("      再把 runtime\\bin\\wecom-cli.exe 拷过来；")
        print("   2) 安装 Node.js 18+ 后重跑本命令；")
        print("   3) 改用 push_mode=webhook（企微群机器人），彻底不需要 CLI。")
        return 1

    base = Path(node).parent
    for cand in (base / "node_modules" / "npm" / "bin" / "npm-cli.js",
                 base / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"):
        if cand.exists():
            npm_cli = cand
            break
    else:
        print(f"❌ 在 {base} 下找不到 npm-cli.js")
        return 1

    target.mkdir(parents=True, exist_ok=True)
    print(f"node    : {node}")
    print(f"安装到  : {target}")
    print("正在安装，需要联网，约 20 秒…", flush=True)
    p = subprocess.run([node, str(npm_cli), "install", "-g", "@wecom/cli",
                        "--prefix", str(target), "--no-fund", "--no-audit"],
                       capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if not entry.exists():
        print(f"❌ 安装失败（退出码 {p.returncode}）")
        print((p.stdout or "")[-1200:])
        print((p.stderr or "")[-1200:])
        return 2
    print(f"✅ 已安装：{entry}")
    print("   正在收进部署包…")
    ok, info = wecom.harvest_cli_exe(str(target / "node_modules" / "@wecom" / "cli"
                                        / "node_modules" / "@wecom"
                                        / "cli-win32-x64" / "bin" / "wecom-cli.exe"))
    print(("✅ " if ok else "⚠️ ") + info)
    return 0


def cmd_selftest(cfg: dict, args) -> int:
    """自检。六组行为，全部靠注入假数据来验证，不发真实消息。

    这里刻意不读 config 里的 always_broadcast，而是每个场景显式设定 ——
    否则用户改了配置，自检的结论就跟着变，那就不是在测代码而是在测配置。

    同样刻意不沿用 config 里的真实账号列表：账号是随时会增删的数据，而
    自检要验的是取数/渲染/投递的逻辑。用一份固定的、当场构造的 platforms
    当输入，结论才不会随「用户今天加了几个账号」而漂移。
    """
    import copy
    store = build_store(cfg)
    real_ele, real_mt = ele_mod.fetch_balance, mt_mod.fetch_balance
    captured: dict = {}

    # 场景用的最小账号集：两个品牌 × 各一个渠道，够覆盖分组与置顶逻辑。
    def base_cfg():
        c = copy.deepcopy(cfg)
        c["platforms"] = {
            "ele": {"enabled": True, "driver": "ele",
                    "cred_key": "selftest_ele", "brand": "品牌A",
                    "label": "淘宝闪购", "threshold": None},
            "meituan": {"enabled": True, "driver": "meituan",
                        "cred_key": "selftest_mt", "brand": "品牌A",
                        "label": "美团", "threshold": None},
            "ele_yf": {"enabled": True, "driver": "ele",
                       "cred_key": "selftest_ele_yf", "brand": "品牌B",
                       "label": "淘宝闪购", "threshold": None},
            "meituan_yf": {"enabled": True, "driver": "meituan",
                           "cred_key": "selftest_mt_yf", "brand": "品牌B",
                           "label": "美团", "threshold": None},
        }
        return c

    def fake_deliver(_cfg, msg, dry=False):
        captured["msg"] = msg
        return True, "captured"

    from core import wecom as _w
    real_deliver = _w.deliver
    _w.deliver = fake_deliver

    # 按「账号键」造数据：同一个驱动下的两个账号余额本来就不同，
    # 用「一个驱动一个值」会掩盖「两个账号串了」这类错误。
    # 未造数据的账号直接报错，而不是静默返回一个默认值 —— 以后加了账号，
    # 自检要立刻提醒补用例，而不是让新账号悄悄漏测。
    def fake_fetch(values: dict):
        def f(_cfg, _store, key=None, **_kw):
            if key not in values:
                raise RuntimeError(f"自检没有为账号「{key}」造数据")
            v = values[key]
            if isinstance(v, BaseException):
                raise v
            if v is None:
                raise NotConfigured(f"未配置测试凭据（{key}）")
            return BalanceResult(key=key, display_name=key, balance=v)
        return f

    def install(values: dict):
        ele_mod.fetch_balance = fake_fetch(values)
        mt_mod.fetch_balance = fake_fetch(values)

    try:
        # ---- 场景 1：故障隔离（静默模式）----
        # 一个平台挂掉，另一个平台的余额仍要出现在播报里。
        install({"ele": RuntimeError("模拟凭据失效"), "meituan": 300.0,
                 "ele_yf": RuntimeError("模拟凭据失效"), "meituan_yf": 300.0})
        c = base_cfg()
        c["always_broadcast"] = False
        for k in c["platforms"]:
            c["platforms"][k]["threshold"] = 1e9        # 强制进告警区，确保被渲染出来
        cmd_run(c, argparse.Namespace(verbose=False, dry=True))
        msg = captured.get("msg", "")
        assert "淘宝闪购" in msg and "取数失败" in msg, "失败平台未出现在播报里"
        assert "美团" in msg, "另一平台的结果被故障平台连带丢失"
        print("✅ 故障隔离通过：单平台失败未影响播报整体")

        # ---- 场景 2：静默模式下「未配置」不打扰 ----
        # 「还没配置」是待办，不是故障。天天播报「你还没设置 XX」会把用户
        # 训练到无视告警 —— 那正是这个工具最该避免的失败模式。
        captured.clear()
        install({"ele": None, "meituan": 300.0, "ele_yf": None, "meituan_yf": 300.0})
        c = base_cfg()
        c["always_broadcast"] = False
        for k in c["platforms"]:
            c["platforms"][k]["threshold"] = 200.0
        c["platforms"]["meituan"]["threshold"] = 1.0    # 300 远高于此，不该告警
        c["platforms"]["meituan_yf"]["threshold"] = 1.0
        cmd_run(c, argparse.Namespace(verbose=False, dry=True))
        assert not captured.get("msg"), "静默模式下未配置的平台不应触发推送"
        print("✅ 静默模式 · 未配置不打扰通过")

        # ---- 场景 3：每日播报 + 低于阈值强调标注 ----
        captured.clear()
        install({"ele": 490.43, "ele_yf": 490.43,
                 "meituan": 150.00, "meituan_yf": 150.00})   # 低于 200，应被强调
        c = base_cfg()
        c["always_broadcast"] = True
        for k in c["platforms"]:
            c["platforms"][k]["threshold"] = 200.0
        cmd_run(c, argparse.Namespace(verbose=False, dry=True))
        msg = captured.get("msg", "")
        assert msg, "每日播报模式下，余额正常也必须推送"
        assert "淘宝闪购" in msg and "美团" in msg, "每日播报应并列展示所有平台"
        assert "低于预警线" in msg, "低于预警线的平台缺少强调标注"
        assert '<font color="warning">' in msg, "强调标注未使用警示色"
        assert msg.index("美团") < msg.index("淘宝闪购"), \
            "低于预警线的平台应排在最前面，才能一眼看到问题"
        print("✅ 每日播报 · 低于预警线强调标注通过（且排在最前）")

        # ---- 场景 4：每日播报下「未配置」如实列出，但不被当作告警强调 ----
        captured.clear()
        install({"ele": None, "meituan": 300.0, "ele_yf": None, "meituan_yf": 300.0})
        c = base_cfg()
        c["always_broadcast"] = True
        for k in c["platforms"]:
            c["platforms"][k]["threshold"] = 200.0
        cmd_run(c, argparse.Namespace(verbose=False, dry=True))
        msg = captured.get("msg", "")
        assert "待配置" in msg, "每日播报里应如实列出未配置的平台，否则会被误读成平台掉了"
        assert "低于预警线" not in msg, "未配置的平台不应被当作超线告警"
        print("✅ 每日播报 · 未配置如实列出且不误报通过")

        # ---- 场景 5：多品牌分组（品牌B / 品牌A 不能混成一锅）----
        # 四个账号必须能分清「哪个数字是谁家的」；置顶的告警行要自带品牌名，
        # 否则脱离分组后就成了一个没有主语的数字。
        captured.clear()
        install({"ele": 490.00, "meituan": 300.00,
                 "ele_yf": 150.00, "meituan_yf": 310.00})   # 只有品牌B闪购低于线
        c = base_cfg()
        c["always_broadcast"] = True
        for k in c["platforms"]:
            c["platforms"][k]["threshold"] = 200.0
        cmd_run(c, argparse.Namespace(verbose=False, dry=True))
        msg = captured.get("msg", "")
        assert "品牌B" in msg and "品牌A" in msg, \
            "两个品牌没有同时出现，播报里分不清是谁的账户"
        assert msg.index("品牌B") < msg.index("品牌A"), \
            "低于预警线的品牌应置顶（连带其品牌名一起看得到）"
        assert "品牌B·淘宝闪购" in msg, \
            "置顶的告警行没带品牌名，脱离分组后不知道是谁的账户"
        assert msg.count("淘宝闪购") == 2, \
            "置顶账号在下面的分组里又列了一次（同一条余额被播报两遍）"
        assert "低于预警线" in msg and '<font color="warning">' in msg, \
            "多品牌场景下强调标注丢了"
        print("✅ 多品牌分组 · 品牌可区分、告警置顶且不重复计数通过")

        # ---- 场景 6：推送通道链的故障转移 ----
        # 主通道是企微群机器人，但它同样会失效（机器人被移出群、key 被重置、
        # 网络到不了 qyapi）。必须验证：主通道挂掉时能自动改走备用通道，
        # 而不是当天悄无声息 —— 「没有播报」和「余额正常」肉眼无法区分。
        captured.clear()
        real_wh, real_aibot = _w.send_webhook, _w.send_aibot
        calls: list[str] = []
        c = copy.deepcopy(cfg)
        c["push_mode"] = "webhook,wecomcli"
        c["wecom"]["webhook"] = ("https://qyapi.weixin.qq.com/cgi-bin/"
                                 "webhook/send?key=selftest-not-a-real-key")
        # 前面几个场景为了截获文案，把 _w.deliver 换成了假函数；
        # 这里要测的正是真实的投递逻辑，必须先换回真的，否则测的是空气。
        _w.deliver = real_deliver
        try:
            def wh_fail(*_a, **_k):
                calls.append("webhook")
                return False, "errcode=93000 invalid webhook url"

            def aibot_ok(*_a, **_k):
                calls.append("wecomcli")
                return True, "ok"

            def wh_ok(*_a, **_k):
                calls.append("webhook")
                return True, "ok"

            def aibot_fail(*_a, **_k):
                calls.append("wecomcli")
                return False, "wecom-cli 未授权"

            _w.send_webhook, _w.send_aibot = wh_fail, aibot_ok
            ok0, info0 = _w.deliver(c, "自检文案")
            assert ok0, "主通道失败时未降级到备用通道"
            assert calls == ["webhook", "wecomcli"], f"降级顺序不对：{calls}"
            assert "降级" in info0, "发生了降级却没在返回值里留痕"

            # 主通道正常时不应再补发第二条，否则用户每天收到两遍。
            calls.clear()
            _w.send_webhook = wh_ok
            ok1, info1 = _w.deliver(c, "自检文案")
            assert ok1 and calls == ["webhook"], f"主通道成功仍继续尝试备用：{calls}"
            assert "降级" not in info1, "没有降级却报了降级"

            # 全挂：返回值必须逐环带上原因，否则排障只能看到「失败」两个字。
            calls.clear()
            _w.send_webhook, _w.send_aibot = wh_fail, aibot_fail
            ok2, info2 = _w.deliver(c, "自检文案")
            assert not ok2, "所有通道都失败却报了成功"
            assert "93000" in info2 and "未授权" in info2, "失败原因未逐环保留"
            assert calls == ["webhook", "wecomcli"], f"未尝试完全部通道：{calls}"
            print("✅ 推送通道链 · 故障转移与逐环失败留痕通过")
        finally:
            _w.send_webhook, _w.send_aibot = real_wh, real_aibot
            _w.deliver = fake_deliver
    finally:
        ele_mod.fetch_balance, mt_mod.fetch_balance = real_ele, real_mt
        _w.deliver = real_deliver
    return 0


def cmd_deploy(cfg: dict, args) -> int:
    """一键部署：环境自检 → 依赖 → 推送程序 → 计划任务 → 试跑。

    为什么这段逻辑放在 Python 而不是 .bat 里：
    .bat 里写中文会踩 cmd.exe 的解析坑 —— cmd 按 512 字节分块解析批处理，
    且**期望每个字符都是单字节**；一旦混入多字节 UTF-8 字符，行尾定位就会错位，
    括号块会被判错并直接退出脚本。再叠加 LF 换行（cmd 期望 CRLF）必然出问题，
    表现就是「双击窗口一闪而过、什么都没干」。
    所以 .bat 只保留几行纯 ASCII 的启动代码，逻辑与中文提示全部放在这里。
    """
    import subprocess

    bar, thin = "=" * 58, "-" * 58
    print(bar)
    print("  推广账户余额预警播报 · 本地部署")
    print(bar)
    print("  依次完成：")
    print("    1) 自检运行环境        2) 核对依赖")
    print("    3) 确认推送程序        4) 注册每天 09:00 计划任务")
    print("    5) 试跑一次真实播报")
    print()

    # ---- 1/5 运行环境 ----
    print(thin)
    print("  [1/5] 运行环境")
    print(thin)
    bundled = ROOT / "runtime" / "python" / "python.exe"
    print(f"  当前解释器：{sys.executable}")
    if bundled.exists():
        if Path(sys.executable).resolve() == bundled.resolve():
            print("  [OK] 用的正是随包打包的运行时，不依赖外部安装。")
        else:
            print(f"  [提示] 包内自带运行时在 {bundled}，当前用的却是外部解释器。")
            print("         不算错误，只是便携性会下降。")
    else:
        print("  [!] 没找到 runtime\\python\\python.exe。")
        print("      便携性会下降：系统 Python 一旦被卸载或升级，本工具会静默失效，")
        print("      而「静默失效」和「余额正常」在你这一侧分辨不出来。")
        print("      建议把完整的 runtime 目录补回来。")
    print()

    # ---- 2/5 依赖 ----
    print(thin)
    print("  [2/5] 依赖完整性")
    print(thin)
    missing = []
    for name in ("requests", "keyring", "websocket"):
        try:
            __import__(name)
        except Exception:                               # noqa: BLE001
            missing.append(name)
    if missing:
        print(f"  缺少：{', '.join(missing)}")
        print("  正在安装（需要联网，约 1 分钟）…", flush=True)
        rc = subprocess.call([sys.executable, "-m", "pip", "install",
                              "--disable-pip-version-check", "-q",
                              "requests", "keyring", "pycryptodome",
                              "websocket-client"])
        if rc != 0:
            print("  [X] 安装失败，请检查网络后重新运行本部署脚本。")
            return 1
        print("  已安装。")
    print("  [OK] requests / keyring / pycryptodome / websocket-client 均在位")
    print()

    # ---- 3/5 推送程序 ----
    print(thin)
    print("  [3/5] 推送程序")
    print(thin)
    exe = ROOT / "runtime" / "bin" / "wecom-cli.exe"
    if exe.exists():
        print("  [OK] 已在部署包内：runtime\\bin\\wecom-cli.exe")
        print("       （直接调用它，不需要 Node，也不依赖外部安装）")
    else:
        print("  未找到，正在把本机已安装的推送程序收进部署包…")
        ok, info = wecom.harvest_cli_exe()
        print(("  [OK] " if ok else "  [!] ") + info)
    print(f"  推送通道：{wecom.probe(cfg)}")
    print()

    # ---- 4/5 计划任务 ----
    print(thin)
    print("  [4/5] 注册每天 09:00 的计划任务")
    print(thin)
    print("  任务以「当前登录用户」身份运行 —— 否则读不到凭据管理器里的登录凭据。")
    rc = cmd_task_install(cfg, args)
    if rc != 0:
        print()
        print("  若上面提示权限不足，请右键本文件 →「以管理员身份运行」，再跑一次。")
    print()

    # ---- 5/5 试跑 ----
    print(thin)
    print("  [5/5] 试跑一次（只看结果，不发消息）")
    print(thin)
    cmd_run(cfg, argparse.Namespace(verbose=True, dry=True))

    print()
    print(bar)
    print("  部署完成")
    print(bar)
    print("  日常只用这几个：")
    print("    check-now.bat       立刻查一次（只看不发）")
    print("    test-push.bat       发一条测试推送，验证通道")
    print("    login.bat           凭据失效时重新登录捕获")
    print("    install-task.bat    补装 / 重装定时任务")
    print("    uninstall-task.bat  卸载定时任务")
    print()
    print("  日志在 logs\\ 目录，心跳在 logs\\heartbeat.txt")
    print(bar)
    return 0


def main() -> int:
    cfg = load_config()
    ap = argparse.ArgumentParser(description="推广账户余额预警播报")
    # command 不做 choices 白名单：账号是可以随时加的平台项，写死白名单就等于
    # 「加账号要改代码」，而且报错信息会变成一句没用的 invalid choice。
    # 改成「已知命令 + set-<任意账号键>」两种形态，下面显式校验。
    ap.add_argument("command", nargs="?", default="check",
                    help="check / login / status / test-send / selftest / deploy / "
                         "task-install / task-remove / task-status / set-<账号键>")
    ap.add_argument("--verbose", action="store_true", help="打印全部平台余额（不推送）")
    ap.add_argument("--dry", action="store_true", help="不真正发送")
    ap.add_argument("--preview", action="store_true",
                    help="打印将要发送的播报文案，但不投递")
    ap.add_argument("--force", action="store_true", help="强制重装（install-cli 用）")
    ap.add_argument("--text", default="", help="凭据文本（cURL 或 Cookie）")
    ap.add_argument("--file", default="", help="从文件读取凭据文本（可拖拽文件到 .bat）")
    ap.add_argument("--platform", default="",
                    help="只处理指定平台（login 用），填 config.platforms 里的键名")
    args = ap.parse_args()

    known = {"check", "login", "status", "test-send", "selftest", "install-cli",
             "deploy", "task-install", "task-remove", "task-status",
             "check-source"}

    if args.command == "deploy":
        return cmd_deploy(cfg, args)
    if args.command == "check":
        if args.verbose:
            args.dry = True
        return cmd_run(cfg, args)
    if args.command == "login":
        if args.platform and args.platform not in cfg["platforms"]:
            print(f"❌ --platform「{args.platform}」不在 config.platforms 里。")
            print(f"   可选：{', '.join(cfg['platforms'])}")
            return 1
        return cmd_login(cfg, args)
    if args.command.startswith("set-"):
        # set-ele-yf  ->  ele_yf：命令行用连字符，配置里用下划线
        return cmd_set(args.command[4:].replace("-", "_"), args)
    if args.command not in known:
        print(f"❌ 未知命令「{args.command}」。")
        print(f"   可用命令：{', '.join(sorted(known))}")
        print(f"   注入凭据：set-<账号键>，当前账号键：{', '.join(cfg['platforms'])}")
        return 1
    if args.command == "status":
        return cmd_status(cfg, args)
    if args.command == "test-send":
        return cmd_test_send(cfg, args)
    if args.command == "check-source":
        return cmd_check_source(cfg, args)
    if args.command == "selftest":
        return cmd_selftest(cfg, args)
    if args.command == "install-cli":
        return cmd_install_cli(cfg, args)
    if args.command == "task-install":
        return cmd_task_install(cfg, args)
    if args.command == "task-remove":
        return cmd_task_remove(cfg, args)
    if args.command == "task-status":
        return cmd_task_status(cfg, args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
