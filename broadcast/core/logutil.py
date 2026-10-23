"""日志：同时写 stdout 与文件。

计划任务用 pythonw.exe 运行（无控制台），出错时唯一证据就是日志文件；
而 print 在无控制台环境下会因 sys.stdout is None 直接崩，所以必须兜底。

注意实现细节：attach() 会把 stdout 变成 Tee（同时写文件），
因此 line() 绝不能再走 print()，否则每行都会被写两遍。
line() 直接写「原始 stdout」+ 文件，Tee 只负责兜住第三方库的散装输出。
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path


class _Tee:
    def __init__(self, *streams):
        self.streams = [s for s in streams if s is not None]

    def write(self, s):
        for st in self.streams:
            try:
                st.write(s)
                st.flush()
            except Exception:
                pass
        return len(s)

    def flush(self):
        for st in self.streams:
            try:
                st.flush()
            except Exception:
                pass


class Logger:
    def __init__(self, log_dir: Path, prefix: str = "bot"):
        log_dir = Path(log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        self.file = log_dir / f"{prefix}_{datetime.now():%Y-%m-%d}.log"
        self._fh = open(self.file, "a", encoding="utf-8")
        self._orig_out = sys.stdout
        self._orig_err = sys.stderr

    def attach(self) -> None:
        """让 stdout/stderr 也落到日志文件（兜住 traceback 与第三方库输出）。"""
        sys.stdout = _Tee(self._orig_out, self._fh)
        sys.stderr = _Tee(self._orig_err, self._fh)

    def line(self, *a) -> None:
        msg = " ".join(str(x) for x in a)
        s = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
        for st in (self._orig_out, self._fh):      # 不走 print()，避免重复写文件
            try:
                if st is not None:
                    st.write(s + "\n")
                    st.flush()
            except Exception:
                pass

    def close(self) -> None:
        try:
            sys.stdout = self._orig_out
            sys.stderr = self._orig_err
        except Exception:
            pass
        try:
            self._fh.close()
        except Exception:
            pass
