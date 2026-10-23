"""读看板导出的「轻指标」（默认 `<仓库>/dashboard/data/mini-metrics.json`），给群播报补一节「今日经营」。

设计约束（照本套件一贯的故障隔离风格）：

1. **任何异常都收敛成 `ok=False`**，绝不抛出。余额播报是这条消息的主业，
   看板侧文件缺失 / 半截 JSON / 结构改版 / 时钟被改坏 —— 哪一种都不能让余额播报跟着翻车。
   `ok=False` 时调用方整段不输出（见 bot.py render()），用户看到的就是改动前那条消息。
2. **硬超时 3s**。挂在 Windows 计划任务的网络盘 / 杀软扫描下，一次 `read` 也可能卡住；
   播报有 180s 总预算，不能让它一个人占满。
3. **陈旧就说话**：文件里的 `today` 是看板按**北京时间**算的今天。若它不等于本机（北京时间）
   今天 → 整份数据视为陈旧，`stale=True`，调用方**明写数据日期、不出任何环比**。
   `metrics.*.value is None` 一律按「没有这个数」处理，**绝不兜底成 0**。
4. 不做单位换算、不做四舍五入以外的加工：数值怎么来就怎么用，
   口径脚注（`foot`）原样透传给播报 —— 口径真相源在看板侧 `caliber.mjs`，这里不复制一套。
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 北京时间：看板侧生成戳、`today` 全按 Asia/Shanghai 算（见 export-mini-metrics.mjs）。
# 本机可能配成 UTC，所以这里**不**用本机时区 —— 否则凌晨 0–8 点会整体差一天。
BEIJING = timezone(timedelta(hours=8))

#: 仓库根（broadcast/core/metrics.py → 上两级）。看板与广播在同一个仓库里时用它算默认路径，
#: 换盘 / 换机器 / 别人 clone 下来都不必改代码。
_KIT_ROOT = Path(__file__).resolve().parents[2]

#: 默认路径：同仓库的看板产物。取不到时的解析顺序（见 load_mini）：
#:   config.mini_metrics.path → 环境变量 MINI_METRICS_PATH → 本默认值
DEFAULT_PATH = Path(os.environ.get("MINI_METRICS_PATH")
                    or (_KIT_ROOT / "dashboard" / "data" / "mini-metrics.json"))

#: 读盘硬超时（秒）。见模块 docstring 第 2 条。
TIMEOUT_SEC = 3.0

#: 播报只关心这两个 + 两个（顺序即展示顺序）。看板侧多导的字段这里不读。
METRIC_ORDER = ("projectedIncome", "validOrderCount", "cancelRate", "promoCost")


def _today_beijing() -> str:
    return datetime.now(BEIJING).strftime("%Y-%m-%d")


def _read_json_with_timeout(path: Path, timeout: float) -> dict:
    """在后台线程里读盘并解析，主线程最多等 `timeout` 秒。

    ⚠️ 用守护线程而不是 signal.alarm：Windows 上没有 SIGALRM。
    超时后线程会被丢下（daemon，不阻塞退出）—— 这是刻意的取舍：
    宁可泄漏一个卡在 IO 上的线程，也不能让播报卡死。
    """
    box: dict = {}

    def work() -> None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                box["data"] = json.load(f)
        except BaseException as e:  # noqa: BLE001 —— 任何异常都要收敛到 box
            box["error"] = e

    th = threading.Thread(target=work, name="mini-metrics-read", daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        raise TimeoutError(f"读取超过 {timeout}s")
    if "error" in box:
        raise box["error"]
    data = box.get("data")
    if not isinstance(data, dict):
        raise ValueError("JSON 顶层不是对象")
    return data


def _num(v):
    """只接受真数字；bool 是 int 的子类，必须排掉（True 会被当成 1 播出去）。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _metric(raw: dict, key: str) -> dict | None:
    """把看板导出的单个指标规整成播报要用的极小结构；取不到就是 None。"""
    m = (raw or {}).get(key)
    if not isinstance(m, dict):
        return None
    value = _num(m.get("value"))
    if value is None:
        return None
    return {
        "key": key,
        "label": str(m.get("label") or ""),
        "value": value,
        "dataDate": m.get("dataDate") if isinstance(m.get("dataDate"), str) else None,
        "dataEnd": m.get("dataEnd") if isinstance(m.get("dataEnd"), str) else None,
        "basis": m.get("basis") if isinstance(m.get("basis"), str) else None,
        "foot": str(m.get("foot") or ""),
        # ⚠️ stale 由本模块**现算**（比对北京今天），不看文件里那枚标记 ——
        #    文件可能是昨天导出的，它自己算的「今天」早就过期了。
        "stale": True,
    }


def load_mini(path: Path | str | None = None, timeout: float = TIMEOUT_SEC) -> dict:
    """读轻指标。**永不抛异常**。

    返回结构（`ok=False` 时只有 ok/error/reason，其余一律空，调用方据此整段跳过）：

        {
          "ok": bool,
          "error": str | None,          # 人话原因，进日志
          "generatedAt": str | None,    # 看板导出时间（ISO）
          "today": str | None,          # 看板认定的「今天」（北京时间）
          "stale": bool,                # 整份数据是否陈旧
          "projects": {key: {"label": str, "dataDate": str|None,
                             "metrics": {key: {...}}}}   # 只含有数的指标
        }
    """
    out: dict = {"ok": False, "error": None, "generatedAt": None, "today": None,
                 "stale": True, "projects": {}}
    p = Path(path) if path is not None else DEFAULT_PATH
    try:
        raw = _read_json_with_timeout(p, timeout)
    except FileNotFoundError:
        out["error"] = f"未找到 {p}"
        return out
    except TimeoutError as e:
        out["error"] = f"读取超时：{e}"
        return out
    except Exception as e:  # noqa: BLE001 —— 收敛一切：坏 JSON、权限、编码……
        out["error"] = f"读取失败：{type(e).__name__}: {e}"
        return out

    try:
        file_today = raw.get("today")
        file_today = file_today if isinstance(file_today, str) else None
        now_today = _today_beijing()
        stale_all = file_today != now_today

        projects = raw.get("projects")
        if not isinstance(projects, dict) or not projects:
            out["error"] = "结构里没有 projects"
            return out

        built: dict = {}
        for key, proj in projects.items():
            if not isinstance(proj, dict):
                continue
            windows = proj.get("windows")
            today_win = (windows or {}).get("today") if isinstance(windows, dict) else None
            raw_metrics = (today_win or {}).get("metrics") if isinstance(today_win, dict) else None
            metrics: dict = {}
            for mk in METRIC_ORDER:
                m = _metric(raw_metrics, mk)
                if m is None:
                    continue
                # 单项陈旧：数据日不是北京今天 → 该项标 stale（单项可能比整份更旧）
                m["stale"] = stale_all or (m["dataDate"] != now_today)
                metrics[mk] = m
            if not metrics:
                continue
            built[str(key)] = {
                "label": str(proj.get("label") or key),
                "dataDate": proj.get("dataDate") if isinstance(proj.get("dataDate"), str) else None,
                "metrics": metrics,
            }

        if not built:
            out["error"] = "两个项目都没有可用指标"
            return out

        out.update({
            "ok": True,
            "generatedAt": raw.get("generatedAt") if isinstance(raw.get("generatedAt"), str) else None,
            "today": now_today,
            "fileToday": file_today,
            "stale": stale_all,
            "projects": built,
        })
        return out
    except Exception as e:  # noqa: BLE001 —— 结构改版/类型意外，一律降级
        out.update({"ok": False, "error": f"解析异常：{type(e).__name__}: {e}", "projects": {}})
        return out


# ---------------------------------------------------------------- 渲染

def _fmt_money(v: float) -> str:
    return f"¥{v:,.2f}"


def _fmt_count(v: float) -> str:
    # 订单数是整数；上游若给了 92.0 也按整数播
    return f"{int(round(v)):,}"


def render_mini(mini: dict) -> list[str]:
    """把 `load_mini()` 的结果渲染成播报里的几行 markdown；**取不到就返回空列表**。

    文案原则（经营者在群里的阅读场景）：
      · 先给「今天」还是「昨天」，一句话说清，日期永远写在数字旁边；
      · 陈旧数据明写「数据截止 X」，并且**不出现任何环比/箭头**（硬约束）；
      · 缺的指标就省略，不写「—」占位 —— 一行里挤满破折号会让人以为数据坏了。
    """
    if not mini or not mini.get("ok"):
        return []
    projects = mini.get("projects") or {}
    if not projects:
        return []

    lines: list[str] = []

    if mini.get("stale"):
        # 整份数据不是今天的：标题里就把截止日钉死，避免被读成「今天」
        gen = mini.get("generatedAt") or "（时间未知）"
        lines.append("**今日经营**　<font color=\"comment\">数据非当天</font>")
        lines.append(f"> 看板数据生成于 {gen}；未包含今天的数，故不显示任何环比。")
    else:
        lines.append("**今日经营**")

    for proj in projects.values():
        label = proj.get("label") or "?"
        ms = proj.get("metrics") or {}
        bits: list[str] = []
        dates: set[str] = set()

        if "projectedIncome" in ms:
            m = ms["projectedIncome"]
            bits.append(f"预计收入 {_fmt_money(m['value'])}")
            if m.get("dataDate"):
                dates.add(m["dataDate"])
        if "validOrderCount" in ms:
            bits.append(f"有效订单 {_fmt_count(ms['validOrderCount']['value'])}")
        if "cancelRate" in ms:
            # ⚠️ 看板侧 `cancelRate` 是**百分数**（6.61 表示 6.61%），不再乘 100
            bits.append(f"取消率 {ms['cancelRate']['value']:.2f}%")
        if "promoCost" in ms:
            bits.append(f"推广消耗 {_fmt_money(ms['promoCost']['value'])}")

        if not bits:
            continue

        # 数据日期：同一项目里各指标可能不同日（T+1 缺行），都列出来，别只挑一个
        md = proj.get("dataDate")
        if md:
            dates.add(md)
        stamp = ""
        if mini.get("stale"):
            stamp = f"（数据截止 {max(dates)}）" if dates else ""
        lines.append(f"· **{label}**　{'｜'.join(bits)}{stamp}")

    if len(lines) <= 1:
        return []
    return lines
