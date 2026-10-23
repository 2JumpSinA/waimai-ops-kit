/**
 * 读 cookie 数据库的 **host_key 分布**（只读域名，不解密任何 cookie 值）。
 *   node src/scan-cookie-hosts.mjs [文件路径...]
 *
 * 用途：判断某个浏览器 profile 里**有没有**目标站点的登录记录，
 *       以决定「播种（seed）」这条路是否值得走。只看域名，不碰值，不做解密。
 *
 * ⚠️ 为什么不用「在字节流里搜域名」那种土办法：
 *   我先写的就是那个版本，对**三个** profile 都报「0 个美团域名」——
 *   而其中 `_recon/user-chrome` 明确有 15 条 yiyao cookie。
 *   结论是**方法错了**，不是数据没有。土办法会给出**看起来很确定的错误结论**。
 *   正路是用 SQLite 查询（Node 22.5+ 自带 `node:sqlite`）。
 */
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_TARGETS = [
  "C:/Users/Administrator/AppData/Local/Google/Chrome/User Data/Default/Network/Cookies",
  "C:/Users/Administrator/AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies",
];

const WATCH = [
  { label: "美团医药", host: "yiyao.meituan.com" },
  { label: "美团推广 ka", host: "ka.waimai.meituan.com" },
  { label: "美团外卖 SSO", host: "waimaie.meituan.com" },
  { label: "美团 SSO 根", host: "meituan.com" },
  { label: "淘宝闪购", host: "nr.ele.me" },
  { label: "饿了么", host: "ele.me" },
];

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = files.length ? files : DEFAULT_TARGETS;
let anyReadable = false;

for (const f of targets) {
  console.log(`\n════ ${f} ════`);
  if (!existsSync(f)) { console.log("  ❌ 不存在"); continue; }

  let db;
  try {
    // readOnly：绝不写入；被浏览器独占锁定时会抛 EBUSY
    db = new DatabaseSync(f, { readOnly: true });
  } catch (e) {
    console.log(`  🔒 打不开（浏览器正在占用？）：${String(e.message).slice(0, 100)}`);
    console.log(`     → 先关掉对应浏览器再看。running 的库读不了，这是设计如此。`);
    continue;
  }

  try {
    const rows = db.prepare("SELECT host_key, COUNT(*) AS n FROM cookies GROUP BY host_key ORDER BY n DESC").all();
    anyReadable = true;
    console.log(`  ${(statSync(f).size / 1024).toFixed(0)} KB · 域名 ${rows.length} 个 · cookie ${rows.reduce((a, r) => a + r.n, 0)} 条`);

    const mei = rows.filter((r) => /meituan|dianping/i.test(r.host_key));
    console.log(`  含 meituan/dianping 的域名 ${mei.length} 个:`);
    for (const r of mei.slice(0, 12)) console.log(`     ${String(r.host_key).padEnd(40)} ${r.n} 条`);

    console.log(`  关注站点:`);
    for (const w of WATCH) {
      const hit = rows.filter((r) => String(r.host_key).replace(/^\./, "").endsWith(w.host));
      const n = hit.reduce((a, r) => a + r.n, 0);
      console.log(`     ${n ? "✅" : "  "} ${w.label.padEnd(16)} ${String(n).padStart(3)} 条   ${hit.map((r) => r.host_key).slice(0, 3).join(", ")}`);
    }
  } catch (e) {
    console.log(`  ⚠️ 查询失败：${String(e.message).slice(0, 140)}`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

console.log(`\n说明：这里只统计 **host_key 与条数**，不读取任何 cookie 值、不做解密。`);
console.log(`      有域名 ≠ 登录有效 —— 有效性必须在播种后由浏览器解密再实测。`);
if (!anyReadable && files.length) console.log(`\n⚠️ 没有成功读取任何库，本结论无效。`);
