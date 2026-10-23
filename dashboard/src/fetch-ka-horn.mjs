/**
 * 拉「微前端子应用注册表」+「CDN 清单」，找出报表子应用的入口。
 *   node src/fetch-ka-horn.mjs
 *
 * 从嗅探结果得知 ka 平台会请求这两个 horn 配置：
 *   /horn/v1/modules/micro-subapp-reconsitution/prod   ← 子应用注册表
 *   /horn/v1/modules/waimai_ad_fe_cdnList/prod         ← CDN 清单
 */
import { writeFile, mkdir } from "node:fs/promises";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const MODULES = [
  "micro-subapp-reconsitution",
  "waimai_ad_fe_cdnList",
  "lx-web-config",
];
const BASES = [
  "https://portal-portm.meituan.com/horn/v1/modules",
  "https://ka.waimai.meituan.com/horn/v1/modules",
];

await mkdir("_recon/ka", { recursive: true });

for (const base of BASES) {
  for (const m of MODULES) {
    const url = `${base}/${m}/prod`;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Referer: "https://ka.waimai.meituan.com/new", Accept: "application/json, text/plain, */*" },
      });
      const t = await r.text();
      console.log(`\n[${r.status}] ${url}  ${t.length} 字节`);
      if (!r.ok || t.length < 10) { console.log("    " + t.slice(0, 200).replace(/\s+/g, " ")); continue; }
      await writeFile(`_recon/ka/horn_${m}.json`, t, "utf8");
      let j = null;
      try { j = JSON.parse(t); } catch { /* 非 JSON */ }
      if (j) {
        console.log("    顶层键: " + JSON.stringify(Object.keys(j)).slice(0, 200));
        const s = JSON.stringify(j);
        // 找所有像 js / 路由 / 子应用名的字符串
        const apps = [...new Set([...s.matchAll(/"(?:name|key|appName|subappName|componentName)"\s*:\s*"([\w\-.]{2,60})"/g)].map((x) => x[1]))];
        if (apps.length) { console.log(`    名称类（${apps.length}）：`); for (const a of apps.slice(0, 60)) console.log("      " + a); }
        const js = [...new Set([...s.matchAll(/"(https?:)?\/\/[\w.\-/]+\.js"/g)].map((x) => x[0].replace(/"/g, "")))];
        if (js.length) { console.log(`    js 资源（${js.length}）：`); for (const a of js.slice(0, 40)) console.log("      " + a); }
        const routes = [...new Set([...s.matchAll(/"(\/[\w\-/]{3,80})"/g)].map((x) => x[1]))].filter((p) => /report|effect|data|home|account|analytic/i.test(p));
        if (routes.length) { console.log(`    路由类（${routes.length}）：`); for (const a of routes.slice(0, 50)) console.log("      " + a); }
      } else {
        console.log("    (非 JSON) " + t.replace(/\s+/g, " ").slice(0, 300));
      }
    } catch (e) {
      console.log(`\n  💥 ${url} → ${e.message}`);
    }
  }
}
