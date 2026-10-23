"""平台模块统一接口。

每个平台模块实现：
  fetch_balance(cfg, store) -> BalanceResult
  save_credential(store, text)   # 从 cURL 文本注入凭据
  CookieExpired                  # 凭据失效时抛出，便于故障隔离

统一接口是为了主流程能用循环处理多平台（新增平台只加一行配置），
并保证各平台的容错行为一致。
"""
from __future__ import annotations

from dataclasses import dataclass


class CookieExpired(RuntimeError):
    """登录凭据失效，需要用户重新注入。"""


class TransientError(RuntimeError):
    """临时性取数失败：页面未就绪、连接被重置、超时等，重试可能就好了。

    必须与 CookieExpired 分开：把这类失败报成「登录已失效」，会让人白跑一趟
    重新登录，也会把真正的凭据故障淹没在噪音里。主流程对它会重试。
    """


class NotConfigured(RuntimeError):
    """尚未完成配置（缺接口名 / appKey / 凭据）。"""


# 平台模块声明：fetch_balance 返回的余额**已经是元**，无需再按 unit_divisor 换算。
# 有了这个声明，bot.fetch_one 才会跳过 ÷N，避免「模块内已 ÷100，外面又 ÷100」的双重换算
# （会把 490.43 变成 4.90，制造假告警）。新增平台若返回的是「分」，把这个设为 False。
RETURNS_YUAN = True


@dataclass
class BalanceResult:
    key: str                 # ele / meituan
    display_name: str        # 淘宝闪购 / 美团
    balance: float | None    # 余额（元）
    raw: dict | None = None  # 原始返回，便于排障
    # note 会直接进入推送文案，所以只放「用户看了有用」的话：
    # 分店/连锁的构成、口径不一致的警告、接口失败改走页面兜底这类降级留痕。
    # 别往里塞 "接口 data.balance.balance" 这种开发者术语——天天推给用户就是噪音。
    note: str | None = None
    # provenance 只在 verbose / 日志里出现，用于回答「这个数字是哪个字段来的」。
    provenance: str | None = None
    error: str | None = None # 取数失败时的原因（失败不抛，交由主流程降级）
    # 「还没配置」与「配置了但取数失败」必须区分：
    # 前者是待办事项，天天播报会把人训练到无视告警；
    # 后者可能是凭据失效，必须尽快让人知道。默认 False（即按失败处理）。
    pending: bool = False
