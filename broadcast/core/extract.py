"""从文本/页面中提取金额的通用工具。"""
from __future__ import annotations

import re

# 支持 ¥1,234.56 / 1234.56元 / 1.23万 等
_MONEY = re.compile(r"(?:¥|￥|\bCNY\b)?\s*([0-9][0-9,]*\.?[0-9]{0,2})\s*(万元?|元)?")

# 长标签放前面：先试更具体的，避免被短标签抢走
LABELS = ("账户总余额", "账户可用余额", "总账户余额", "资金账户余额", "账户余额",
          "可用余额", "推广余额", "余额")


def _is_cjk(ch: str) -> bool:
    return "\u3400" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff"


def to_amount(s: str) -> float | None:
    """把 '1,234.56' 转 float。"""
    s = s.replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def money_near_label(text: str, labels=LABELS) -> tuple[float | None, str | None]:
    """在一段文本里找「余额」标签附近的金额。

    返回 (金额, 命中标签)。页面文案千变万化，这里按「标签后 80 字符窗口内
    第一个金额」来取，比写死 CSS 选择器更抗改版。

    关键约束：标签前一个字符不能是汉字。
    否则会被长词里的片段误命中 —— 实测美团首页有一条公告
    「总部资金账户余额不足7天」，其中的「账户余额」会被当成余额标签，
    再往后取第一个数字就拿到了「不足7天」的 7，报出一个错得离谱的余额。
    这类错误比取数失败更危险：它看起来像个正常数字，却会直接导致漏报或误报。
    """
    if not text:
        return None, None
    for lab in labels:
        for m in re.finditer(re.escape(lab), text):
            if m.start() > 0 and _is_cjk(text[m.start() - 1]):
                continue                       # 长词的一部分，不是真标签
            window = text[m.end(): m.end() + 80]
            mm = _MONEY.search(window)
            if not mm:
                continue
            amt = to_amount(mm.group(1))
            if amt is None:
                continue
            if mm.group(2) in ("万", "万元"):
                amt *= 10000
            return amt, lab
    return None, None


def pick_balance_field(obj, keys=("balance", "acctBalance", "availableBalance",
                                  "availBalance", "amount", "fundBalance")):
    """从接口返回的 JSON 里找余额字段（深度优先，取第一个命中）。"""
    if isinstance(obj, dict):
        for k in keys:
            if k in obj and isinstance(obj[k], (int, float, str)):
                v = to_amount(str(obj[k]))
                if v is not None:
                    return v, k
        for v in obj.values():
            r = pick_balance_field(v, keys)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = pick_balance_field(v, keys)
            if r:
                return r
    return None, None
