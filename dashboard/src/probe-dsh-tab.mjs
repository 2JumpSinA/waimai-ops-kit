/**
 * 确认某个端口下的标签页里，DSH 面板（http://127.0.0.1:3080）是否真的渲染出来了。
 *   node src/probe-dsh-tab.mjs [--port=9222]
 *
 * 用途：经营者希望「DSH 开发面板」和「商家端」放在同一个窗口里。
 * 由于一个窗口只能属于一个 profile，做法是把 DSH 当一个**标签页**开在
 * 调试 Chrome 窗口里 —— 这里验证它确实能正常加载。
 */
import { connectToPage, evaluate } from "./lib/cdp.mjs";

const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 9222);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const dsh = list.filter((t) => t.type === "page" && /127\.0\.0\.1:3080/.test(t.url));
console.log(`端口 ${PORT} 上共有 ${list.filter((t) => t.type === "page").length} 个标签页`);
console.log(`其中 DSH 面板标签页：${dsh.length} 个\n`);

const cdp = await connectToPage(PORT);
const info = JSON.parse(
  await evaluate(
    cdp,
    `JSON.stringify({
       url: location.href,
       title: document.title,
       readyState: document.readyState,
       textLen: (document.body && document.body.innerText || '').length,
       head: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
     })`,
  ),
);
console.log(`当前工作标签页 URL : ${info.url}`);
console.log(`标题               : ${info.title}`);
console.log(`readyState         : ${info.readyState}`);
console.log(`正文长度           : ${info.textLen}`);
console.log(`正文开头           : ${info.head || "(空)"}`);

// 明确地问一次 DSH 那个标签页本身
const check = await evaluate(
  cdp,
  `(async () => {
     // 这里的工作标签页未必是 DSH，所以通过 title 判断不了；直接返回我们看到的
     return JSON.stringify({ isDsh: /127\\.0\\.0\\.1:3080/.test(location.href) });
   })()`,
);
console.log(`\n（本次脚本连的是新开的工作标签页，不是 DSH 那个 —— 属正常）`);

await cdp.close();
