/**
 * 账号注册表 —— 一个看板要服务多个独立项目（品牌A / 品牌B），
 * 每个项目有自己的登录态（独立浏览器 profile + 独立调试端口）。
 *
 * 设计要点：
 *   - **一个账号一个 profile**：同一账号的美团医药 / 推广 / 闪购是不同域名，
 *     cookie 互不覆盖，可以共用一个 profile。
 *   - 不同账号必须隔离，否则会互相挤下线（yiyao 是单账号会话）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const ACCOUNTS = {
  quanyi: {
    label: "品牌A",
    fullLabel: "品牌A健康",
    port: 9222,
    profile: "user-chrome",
    cookieFile: ".secrets/meituan.cookie.txt",       // 美团医药
    kaCookieFile: ".secrets/ka.cookie.txt",          // 推广（若有）
    taobaoCookieFile: ".secrets/taobao.cookie.txt",  // 闪购
    planSheet: "品牌A",                                // 台账里的表名
  },
  yifeng: {
    label: "品牌B",
    fullLabel: "品牌B",
    port: 9223,
    profile: "user-chrome-yifeng",
    cookieFile: ".secrets/meituan-yifeng.cookie.txt",
    kaCookieFile: ".secrets/ka-yifeng.cookie.txt",
    taobaoCookieFile: ".secrets/taobao-yifeng.cookie.txt",
    planSheet: "品牌B",
  },
};

export const ACCOUNT_KEYS = Object.keys(ACCOUNTS);

/**
 * 解析 `--account=xxx` 参数（默认 quanyi），并把 port 覆盖合并进去。
 * 用法：`const acct = resolveAccount(process.argv)`
 */
export function resolveAccount(argv = process.argv) {
  const a = argv.find((x) => x.startsWith("--account="));
  const key = a ? a.split("=")[1] : "quanyi";
  const base = ACCOUNTS[key];
  if (!base) {
    throw new Error(`未知账号 "$${key}"。可用：${ACCOUNT_KEYS.join(", ")}`);
  }
  const p = argv.find((x) => x.startsWith("--port="));
  return { key, ...base, port: p ? Number(p.split("=")[1]) : base.port };
}

/** 数据输出路径（按账号分文件） */
export const dataPath = (acct, name) => join(ROOT, "data", "raw", `${name}-${acct.key}.json`);

/** 读一份按账号分文件的原始数据；不存在返回 null */
export function readData(acct, name) {
  const p = dataPath(acct, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
