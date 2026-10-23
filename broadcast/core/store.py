"""凭据存储：优先 Windows 凭据管理器（keyring），长内容自动分片。

设计要点（来自实战教训）：
- Windows 凭据管理器单个凭证有长度上限（CRED_MAX_CREDENTIAL_BLOB_SIZE=2560 字节，
  且 keyring 以 UTF-16 存入 -> 有效字符数约 1280）。整段 Cookie 很容易超限，
  超限时 set_password 会失败；若不校验就会静默降级，安全性悄悄变差。
  因此这里：分片存储 + 写回校验，校验不通过才明确回退到本地文件并提示用户。
- 本地文件回退时限制权限（Windows 下用 ACL 收紧到当前用户）。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from core import profile_cookie

CHUNK = 1000          # 单片刻度，留足余量
MAX_CHUNKS = 40       # 清理时遍历的上限

# 各驱动从 profile cookie 里挑哪些域的项（凭据消费格式是 `name=value; ...`
# header 串，由平台模块自己解析；这里只负责按域把本平台相关的项挑出来，
# 不掺别的平台的登录态 —— 一份 header 混进另一平台的几十个 cookie
# 没有任何好处，还可能撞同名项）。
_DRIVER_DOMAINS = {
    "ele": ("ele.me", "ele.to", "imaicai.com"),
    "meituan": ("meituan.com", "sankuai.com", "dianping.com"),
}

# 各驱动实际要打的站点。同名 cookie 在多个域各有一份且值不同时（美团 token
# 就是典型：waimaieapp 留旧值、ka.waimai 是新值，长度还一样），靠这个参数
# 决定取哪一份 —— 不给的话会取到旧值，表现为「刚登录完仍报登录失效」。
_DRIVER_PREFER_HOST = {
    "ele": "nr.ele.me",
    "meituan": "ka.waimai.meituan.com",
}

# 各驱动的「会话类」必需项（死会话判据用）。名字必须与外卖看板
# `src/lib/cookie.mjs` 的 required 同源，否则两边判断会打架。
_DRIVER_REQUIRED = {
    "ele": ("WMSTOKEN",),
    "meituan": ("token", "acctId"),
}

try:
    import keyring
    _HAS_KEYRING = True
except Exception:                                    # pragma: no cover
    keyring = None
    _HAS_KEYRING = False


class CredStore:
    def __init__(self, service: str, fallback_dir: Path):
        self.service = service
        self.fallback_dir = Path(fallback_dir)
        self.fallback_dir.mkdir(parents=True, exist_ok=True)
        self.degraded_reason: str | None = None
        # ---- profile 正本配置（统一凭据模块 ②a-1）----
        # cookie_source: "profile" = 浏览器 profile 是正本，keyring 只是缓存；
        #                "credman" = 旧行为，完全只读凭据管理器（绝不碰 CDP）。
        # profile_ports: 驱动名 -> CDP 端口。⚠️ 映射以实测账号名为准校正：
        # 看板侧分工是 9222 Chrome=品牌A / 9223 Edge=品牌B，BalanceAlert 的
        # ele_yf / meituan_yf 用 Edge（=品牌B），但最终以登录后浏览器里
        # 实际登录的账号为准。
        self.cookie_source: str = "profile"
        self.profile_ports: dict[str, int] = {
            "ele": 9222, "meituan": 9222, "ele_yf": 9223, "meituan_yf": 9223,
        }
        self.logger = None            # bot.py 注入 Logger；None 时只留内部状态
        self.last_source: dict[str, str] = {}   # cred_key -> "profile" | "缓存"
        self.driver_by_cred_key: dict[str, str] = {}
        self._warned_fallback: dict[str, bool] = {}  # 每凭据键只 WARN 一次（进程生命周期内）
        self._warned_dead: set[str] = set()          # 死会话告警同样每键一次

    def configure_source(self, cfg: dict, logger=None) -> None:
        """从 config 读正本配置（向后兼容：老 config 没写就用缺省 profile）。"""
        self.cookie_source = str(cfg.get("cookie_source", "profile") or "profile")
        ports = cfg.get("profile_ports")
        if isinstance(ports, dict) and ports:
            merged = {}
            for k, v in ports.items():
                try:
                    merged[k] = int(v)
                except (TypeError, ValueError):
                    continue          # 说明性注释键（_help 等）静默跳过
            self.profile_ports.update(merged)
        self.logger = logger

    def _log(self, msg: str) -> None:
        if self.logger is not None:
            self.logger.line(msg)
        else:
            try:
                sys.stderr.write(f"[store] {msg}\n")
            except Exception:                            # noqa: BLE001
                pass

    # cred_key -> 驱动名。bot.py 建好 store 后调用 set_driver_map() 填进来，
    # 这样 ele.py / meituan.py 里的 store.get(cred_key) 调用（签名不变）
    # 也能走到 profile 正本路径，平台模块零改动。
    def set_driver_map(self, mapping: dict[str, str]) -> None:
        self.driver_by_cred_key = dict(mapping)

    def _driver_of_cred_key(self, key: str) -> str | None:
        m = getattr(self, "driver_by_cred_key", None) or {}
        if key in m:
            return m[key]
        # 兜底推断：config 的 cred_key 约定是 <driver>[_yf]_cookie。
        base = key.removesuffix("_cookie")
        for cand in ("ele_yf", "meituan_yf", "ele", "meituan"):
            if base == cand:
                return cand
        return None

    # ---- profile 正本读取（只在这一层做回退与 WARN）----
    def _profile_header_for(self, cred_key: str, driver: str,
                            port: int) -> str | None:
        """从 profile 正本拼出该驱动需要的 cookie header 串。

        成功：返回 header 串（同时把缓存刷成同值，方向单向 profile→缓存）。
        profile 不可达：返回 None 并打 WARN（验收要求该 WARN 必须出现在
        bot.py 的日志流里），调用方回退缓存。
        **绝不允许**把缓存值写回 profile / 快照。
        """
        # 按 cookie 的 domain 属性挑本平台相关项（不能按 cookie 名过滤：
        # token / acctId / _m_h5_tk 这些关键项名字里都不含域名）。
        if cred_key in getattr(self, "_warned_fallback", {}):
            # 同一次取数里平台模块会 get() 多次（token 续期校验等），
            # 端口不可达时别把同一条 WARN 刷成瀑布 —— 每个凭据键只告警一次。
            return None
        entries = profile_cookie._fetch_profile_cookie_entries(port)
        if entries is None:
            getattr(self, "_warned_fallback", {}).setdefault(cred_key, True)
            snap = profile_cookie.read_snapshot(port)
            ts = (snap or {}).get("fetchedAt", "无快照")
            self._log(f"WARN: profile 不可达(端口 {port})，本次用缓存"
                      f"（快照时间 {ts}）")
            return None
        try:
            # 快照存全量（探活诊断用），只在本模块成功读取正本时更新。
            profile_cookie.save_snapshot(port, profile_cookie.filter_entries_by_domain(entries, None))
        except Exception:                                # noqa: BLE001
            pass
        picked = profile_cookie.filter_entries_by_domain(
            entries, _DRIVER_DOMAINS.get(driver),
            prefer_host=_DRIVER_PREFER_HOST.get(driver))
        if not picked:
            # 端口活着但一个本平台 cookie 都没有 —— 通常没登录该平台，
            # 如实告警并回退缓存（回退 WARN 上面分支已有；这里是补充说明）。
            self._log(f"WARN: profile(端口 {port}) 里没有 {driver} 域的 cookie"
                      f"（可能未登录该平台），本次用缓存")
            return None

        # 死会话判据（从外卖看板回灌）：只有父域副本、没有本域会话 cookie 时
        # 「读得出」会被误判成「可用」，以前要等调用方被踢到登录页才暴露。
        # 这里只告警不拒收 —— 静态文件/缓存兜底往往比直接失败更有用。
        host = _DRIVER_PREFER_HOST.get(driver) or ""
        is_dead, dead_detail = profile_cookie.detect_dead_session(
            entries, host, _DRIVER_REQUIRED.get(driver, ()))
        if is_dead and cred_key not in self._warned_dead:
            self._warned_dead.add(cred_key)
            self._log(f"WARN: {dead_detail}")

        header = "; ".join(f"{n}={v}" for n, v in picked.items())
        self.set(cred_key, header)                       # 缓存刷新（keyring 原路径）
        self.last_source[cred_key] = "profile"
        return header

    # ---------- 内部：本地文件回退 ----------
    def _file(self, key: str) -> Path:
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)
        return self.fallback_dir / f"{safe}.json"

    def _write_file(self, key: str, value: str) -> None:
        p = self._file(key)
        p.write_text(json.dumps({"value": value}, ensure_ascii=False), encoding="utf-8")
        try:                                          # 尽量收紧权限
            os.chmod(p, 0o600)
        except Exception:
            pass
        self.degraded_reason = "已回退为本地文件存储（凭据管理器写入校验未通过）"

    def _read_file(self, key: str) -> str | None:
        p = self._file(key)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8")).get("value")
        except Exception:
            return None

    # ---------- 内部：分片读写 ----------
    def _delete_chunks(self, key: str) -> None:
        if not _HAS_KEYRING:
            return
        try:
            keyring.delete_password(self.service, f"{key}__n")
        except Exception:
            pass
        for i in range(1, MAX_CHUNKS + 1):
            try:
                keyring.delete_password(self.service, f"{key}__{i}")
            except Exception:
                pass

    def _read_chunks(self, key: str) -> str | None:
        try:
            n = keyring.get_password(self.service, f"{key}__n")
        except Exception:
            return None
        if not n:
            return None
        parts = []
        for i in range(1, int(n) + 1):
            part = keyring.get_password(self.service, f"{key}__{i}")
            if part is None:
                return None
            parts.append(part)
        return "".join(parts)

    # ---------- 对外 API ----------
    def set(self, key: str, value: str) -> None:
        if _HAS_KEYRING:
            try:
                self._delete_chunks(key)
                parts = [value[i:i + CHUNK] for i in range(0, len(value), CHUNK)]
                if len(parts) <= MAX_CHUNKS:
                    for i, part in enumerate(parts, 1):
                        keyring.set_password(self.service, f"{key}__{i}", part)
                    keyring.set_password(self.service, f"{key}__n", str(len(parts)))
                    if self._read_chunks(key) == value:      # ★ 写回校验
                        self.degraded_reason = None
                        return
            except Exception as e:
                self.degraded_reason = f"凭据管理器写入失败：{type(e).__name__}: {e}"
        # 本地文件回退
        self._write_file(key, value)

    def get(self, key: str, *, driver: str | None = None) -> str | None:
        """取凭据。

        cookie_source=profile 时：先读浏览器 profile 正本，成功则刷缓存并返回；
        profile 不可达则回退缓存并 WARN（见 _profile_header_for）。
        cookie_source=credman 时：完全不碰 CDP，只走原 keyring 路径。
        `driver` 由 bot.py 传入（账号 -> 驱动名 -> 端口映射）；未传时按
        旧语义直接读缓存，保证所有既有调用（ele.py/meituan.py 的
        store.get(cred_key)）行为不变 —— 平台模块拿到的永远是 header 串。
        """
        if self.cookie_source == "profile":
            driver = self._driver_of_cred_key(key)
            if driver in self.profile_ports:
                v = self._profile_header_for(key, driver,
                                             self.profile_ports[driver])
                if v is not None:
                    return v
                # 回退缓存（last_source 标记为缓存，供 --check-source 展示）
                self.last_source[key] = "缓存"
        return self._cache_get(key)

    def _cache_get(self, key: str) -> str | None:
        if _HAS_KEYRING:
            v = self._read_chunks(key)
            if v:
                return v
        return self._read_file(key)

    def delete(self, key: str) -> None:
        self._delete_chunks(key)
        p = self._file(key)
        if p.exists():
            p.unlink()

    def status(self, key: str) -> str:
        if self._cache_get(key):
            return "本地文件" if self._file(key).exists() else "凭据管理器"
        return "未设置"
