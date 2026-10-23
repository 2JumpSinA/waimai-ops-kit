/**
 * 修「未关联角色」误报：清掉站点本地数据（**保留 cookie**）再重载。
 *   node src/fix-console-state.mjs [--port=9223] [--dry]
 *
 * 依据：该账号的权限类接口全部健康
 *   /queryMenu          code 0（16 个一级菜单 / 67 个子菜单）
 *   /menu/category      code 0（6 个分类）
 *   /task/menuConfig    code 0（7 组权限）
 *   /accountstatus/get  code 0，onlineStatus 1
 * 但前端仍跳 /main/error 「未关联角色」 —— 怀疑是浏览器侧的前端引导状态坏了。
 *
 * ⚠️ 只能用**页级** CDP：
 *    `Network.clearBrowserCache` 在 browser 级连接上不存在（Network 是页级域），
 *    `Storage.clearDataForOrigin` 在 browser 级会报 Internal error。
 * 只清非 cookie 数据，登录态保留。
 */
import { connectToPage, evaluate, waitSignedReady } from "./lib/cdp.mjs";

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9223"));
const DRY = process.argv.includes("--dry");

const cdp = await connectToPage(PORT);
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await new Promise((r) => setTimeout(r, 6000));

if (!DRY) {
  // 1) 页级清缓存
  try {
    await cdp.send("Network.clearBrowserCache");
    console.log("✅ Network.clearBrowserCache");
  } catch (e) {
    console.log(`⚠️ clearBrowserCache: ${e.message}`);
  }
  // 2) 页级 Storage.clearDataForOrigin（不含 cookies）
  try {
    await cdp.send("Storage.clearDataForOrigin", {
      origin: "https://yiyao.meituan.com",
      storageTypes: "local_storage,indexeddb,cache_storage,websql,service_workers,file_systems",
    });
    console.log("✅ Storage.clearDataForOrigin（不含 cookies）");
  } catch (e) {
    console.log(`⚠️ clearDataForOrigin: ${e.message}`);
  }
  // 3) 兜底：直接用 JS 清 localStorage/sessionStorage
  const cleared = await evaluate(
    cdp,
    `(async () => {
       const n = { ls: 0, ss: 0, idb: 0 };
       try { n.ls = localStorage.length; localStorage.clear(); } catch (e) {}
       try { n.ss = sessionStorage.length; sessionStorage.clear(); } catch (e) {}
       try {
         const dbs = await indexedDB.databases();
         for (const d of dbs) { if (d.name) { indexedDB.deleteDatabase(d.name); n.idb++; } }
       } catch (e) {}
       return JSON.stringify(n);
     })()`,
  );
  console.log(`✅ JS 清理：${cleared}`);
} else {
  console.log("--dry，未执行");
}

// 重载并判定
await cdp.send("Page.navigate", { url: "https://yiyao.meituan.com/main/frame" });
await waitSignedReady(cdp, "/v2/sc/index/r/poiInfo/get", { timeoutMs: 60_000 }).catch(() => null);
await new Promise((r) => setTimeout(r, 14_000));

const probe = JSON.parse(
  await evaluate(
    cdp,
    `(() => {
       const lines = (document.body?.innerText || '').split('\\n').map(s=>s.trim()).filter(Boolean);
       return JSON.stringify({
         url: location.href,
         lineCount: lines.length,
         noRole: lines.some(x => /未关联角色|角色未关联/.test(x)),
         menus: ['首页','常用','全部订单','评价管理','经营指导','商品管理','营销活动','账号管理','财务管理']
                  .filter(x => lines.includes(x)),
       });
     })()`,
  ),
);
console.log(`\n重载后：`);
console.log(`  URL        : ${probe.url}`);
console.log(`  可见行数   : ${probe.lineCount}`);
console.log(`  仍是错误页 : ${probe.noRole ? "是 ⛔" : "否 ✅"}`);
console.log(`  菜单命中   : ${probe.menus.join(' / ') || '(无)'}`);

await cdp.close();
