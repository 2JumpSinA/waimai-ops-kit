"""网络与 cURL 解析工具。

核心能力：把用户从浏览器复制的 「Copy as cURL (bash)」 整段文本，
还原成 (url, method, headers, cookies, body)。这样用户只需粘贴一次，
Cookie / 接口名 / 参数 一次全部到位，比手工拼 Cookie 可靠得多。
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Callable

# ---------------------------------------------------------------- cURL 解析

_BASH_ESC = {
    r"\n": "\n", r"\r": "\r", r"\t": "\t",
    r"\'": "'", r"\"": '"', r"\\": "\\",
}


def _unescape(v: str) -> str:
    """还原 bash $'...' 转义串里的 \\uXXXX / \\n / \\' 等。"""
    if "\\u" in v:
        v = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), v)
    for k, r in _BASH_ESC.items():
        v = v.replace(k, r)
    return v


@dataclass
class Request:
    url: str
    method: str = "GET"
    headers: dict = field(default_factory=dict)
    body: str | None = None

    # ---- Cookie 工具 ----
    def cookie_pairs(self) -> list[tuple[str, str]]:
        raw = self.headers.get("cookie") or self.headers.get("Cookie") or ""
        out = []
        for item in raw.split(";"):
            item = item.strip()
            if not item or "=" not in item:
                continue
            k, _, v = item.partition("=")
            out.append((k.strip(), v.strip()))
        return out

    def cookie_dict(self, drop_non_ascii: bool = True) -> dict:
        """Cookie 转 dict。默认剔除非 ASCII 项。

        浏览器 Cookie 里常混入未做 URL 编码的中文项（如店名 wmPoiName），
        requests 对 header 值按 latin-1 编码，遇到这类字符会直接抛异常。
        这类项通常是展示用，剔掉不影响接口。
        """
        d, dropped = {}, []
        for k, v in self.cookie_pairs():
            if drop_non_ascii:
                try:
                    v.encode("ascii")
                except UnicodeEncodeError:
                    dropped.append(k)
                    continue
            d[k] = v
        self.dropped_cookies = dropped
        return d

    def cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookie_dict().items())

    def set_cookie_value(self, name: str, value: str) -> None:
        pairs = [(k, v) for k, v in self.cookie_pairs() if k != name]
        pairs.append((name, value))
        raw = "; ".join(f"{k}={v}" for k, v in pairs)
        self.headers["cookie"] = raw
        if "Cookie" in self.headers:
            self.headers["Cookie"] = raw


_COOKIE_RE = re.compile(r"(?:-b|--cookie)\s+\$?(['\"])(.*?)(?<!\\)\1", re.S)
_HEADER_RE = re.compile(r"(?:-H|--header)\s+\$?(['\"])(.*?)(?<!\\)\1", re.S)
_URL_RE = re.compile(r"https?://[^\s'\"\\]+")


def parse_curl(text: str) -> Request:
    """解析 bash 风格的 cURL 命令。容忍换行、续行符与多种引号。"""
    if not text or "curl" not in text:
        raise ValueError("看起来不是 cURL 文本（未找到 curl）")

    # 先把换行续行合并，便于正则
    flat = text.replace("\\\r\n", " ").replace("\\\n", " ")

    m = _COOKIE_RE.search(flat)
    cookie = _unescape(m.group(2)) if m else ""

    headers: dict = {}
    for hm in _HEADER_RE.finditer(flat):
        line = _unescape(hm.group(2))
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if k.lower() == "cookie":
            # 新版 Chrome 的 Copy as cURL 常常把 Cookie 放在 -H 里而不是 -b
            if not cookie:
                cookie = v
            continue
        headers[k] = v

    if cookie:
        headers["cookie"] = cookie

    method = "GET"
    mm = re.search(r"-X\s+([A-Z]+)", flat)
    if mm:
        method = mm.group(1)
    data = None
    dm = re.search(r"(?:--data-raw|--data|-d)\s+\$?(['\"])(.*?)(?<!\\)\1", flat, re.S)
    if dm:
        data = _unescape(dm.group(2))
        if method == "GET":
            method = "POST"

    # 关键：先把 -H / -b 的整个参数串从文本里抠掉，再找 URL。
    # 否则 -H 'referer: https://...' 里的地址也会被当成候选，
    # 而下面取的是「最长的 http 串」——referer 往往比真正的接口地址还长，
    # 会把 URL 认错，后面整条链路全废。
    bare = _COOKIE_RE.sub(" ", flat)
    bare = _HEADER_RE.sub(" ", bare)

    cleaned = [u.rstrip("'\"\\") for u in _URL_RE.findall(bare)]
    cleaned = [u for u in cleaned if u.startswith("http")]
    if not cleaned:
        raise ValueError("cURL 里没找到 URL")
    url = max(cleaned, key=len)

    return Request(url=url, method=method, headers=headers, body=data)


def curl_from_file(path: str) -> Request:
    with open(path, encoding="utf-8", errors="ignore") as f:
        return parse_curl(f.read())


# ---------------------------------------------------------------- 凭据抽取（多形态容错）

_HEADER_COOKIE_RE = re.compile(r"^[ \t]*cookie[ \t]*:[ \t]*(.+)$", re.I | re.M)


def _clean_pairs(raw: str) -> tuple[dict, list[str]]:
    """Cookie 字符串 -> 有序 dict，剔除非 ASCII 值。

    浏览器 Cookie 里常混入未做 URL 编码的中文项（如店名），
    requests 的 header 按 latin-1 编码，遇到会直接抛异常。这类项通常是展示用，
    剔掉不影响接口。
    """
    out: dict[str, str] = {}
    dropped: list[str] = []
    for item in (raw or "").replace("\r", "\n").replace("\n", ";").split(";"):
        item = item.strip()
        if not item or "=" not in item:
            continue
        k, _, v = item.partition("=")
        k, v = k.strip(), v.strip()
        if not k:
            continue
        try:
            v.encode("ascii")
        except UnicodeEncodeError:
            if k not in dropped:
                dropped.append(k)
            continue
        if k not in out or len(v) > len(out[k]):
            out[k] = v
    return out, dropped


def extract_cookie_header(text: str) -> tuple[str, list[str], "Request | None"]:
    """从用户实际会粘贴的任意形态里抽出 Cookie 头。

    支持三种形态（都是真实会遇到的）：
    1. 完整的「Copy as cURL」命令
    2. HTTP 请求头文本块（顺手把 Headers 面板整段选中复制的情况）
    3. 裸 Cookie 字符串

    返回 (cookie_header, 被剔除非 ASCII 的键名, 解析出的 Request 或 None)。
    """
    text = (text or "").strip()
    if not text:
        return "", [], None

    req = None
    raw_cookie = ""

    if "curl" in text.lower():
        try:
            req = parse_curl(text)
            raw_cookie = req.headers.get("cookie") or req.headers.get("Cookie") or ""
        except Exception:
            raw_cookie = ""

    if not raw_cookie:
        m = _HEADER_COOKIE_RE.search(text)
        if m:
            raw_cookie = m.group(1).strip()

    if not raw_cookie and "=" in text:
        # 裸 Cookie 字符串（可能带换行）
        raw_cookie = text

    pairs, dropped = _clean_pairs(raw_cookie)
    header = "; ".join(f"{k}={v}" for k, v in pairs.items())
    return header, dropped, req


# ---------------------------------------------------------------- 请求重试

def with_retry(fn: Callable, attempts: int = 3, base_delay: float = 1.2, what: str = "请求"):
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:          # noqa: BLE001
            last = e
            if i < attempts - 1:
                time.sleep(base_delay * (2 ** i))
    raise RuntimeError(f"{what} 连续 {attempts} 次失败：{type(last).__name__}: {last}")


# ---------------------------------------------------------------- 输出侧 PII 拦截

def assert_no_pii(text: str) -> None:
    """外发前兜底拦截疑似个人信息（连续 8 位以上数字）。"""
    for ln in text.splitlines():
        if re.search(r"\d{8,}", ln):
            raise RuntimeError(f"播报内容疑似含长数字串（个人信息风险），已阻止发送：{ln[:60]}")
