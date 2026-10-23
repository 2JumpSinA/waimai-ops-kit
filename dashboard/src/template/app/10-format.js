/* ══════ 分片 10-format.js · 格式化与转义：`$` / `fmt` / `int` / `esc` ══════ */
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => (n === null || n === undefined || n === "" || isNaN(n)) ? "—"
  : Number(n).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
const int = (n) => (n === null || n === undefined || isNaN(n)) ? "—" : Number(n).toLocaleString("zh-CN");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

