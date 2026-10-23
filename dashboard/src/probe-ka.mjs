/**
 * 美团推广平台（ka.waimai.meituan.com）· 静态侦察
 *   node src/probe-ka.mjs
 *
 * 第一步不需要 cookie：先看入口页、拿到入口包，再挖接口。
 * 与美团医药（yiyao）同属美团体系，预期同样走 mtgsig 风控 → 可能需要 CDP。
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const HOST = "ka.waimai.meituan.com";
const URLS = [`https://${HOST}/new`, `https://${HOST}/`, `https://${HOST}/new#/newhome`];

for (const url of URLS) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "manual" });
    const html = await r.text();
    console.log(`\n${"=".repeat(72)}`);
    console.log(`  ${url}`);
    console.log(`${"=".repeat(72)}`);
    console.log(`  status=${r.status}  location=${r.headers.get("location") ?? "-"}  bytes=${Buffer.byteLength(html)}`);
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1];
    console.log(`  title=${title ?? "-"}`);

    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    const links = [...html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)].map((m) => m[1]);
    if (scripts.length) {
      console.log(`  scripts（${scripts.length}）：`);
      for (const s of scripts) console.log("    " + s);
    }
    if (links.length) {
      console.log(`  links（${links.length}）：`);
      for (const s of links.slice(0, 15)) console.log("    " + s);
    }
    if (Buffer.byteLength(html) < 1500) {
      console.log("  body: " + html.replace(/\s+/g, " ").slice(0, 800));
    }
  } catch (e) {
    console.log(`\n  💥 ${url} → ${e.message}`);
  }
}
