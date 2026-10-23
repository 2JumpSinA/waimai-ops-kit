/**
 * 连到某个**指定 URL 的标签页**，读它的标题与正文，确认真的渲染出来了。
 *   node src/probe-tab-by-url.mjs --port=9222 --match=127.0.0.1:3080
 *
 * 用途：确认「DSH 面板当标签页开在调试 Chrome 窗口里」这条路真的通。
 */
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=")[1] : d;
};
const PORT = Number(arg("port", "9222"));
const MATCH = arg("match", "127.0.0.1:3080");

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url.includes(MATCH));
if (!target) {
  console.log(`找不到匹配 "${MATCH}" 的标签页。当前有：`);
  for (const t of list.filter((x) => x.type === "page")) console.log(`  ${t.title}  ${t.url}`);
  process.exit(1);
}
console.log(`目标标签页：${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", () => rej(new Error("WS 连接失败")), { once: true });
});

const send = (id, method, params = {}) =>
  new Promise((resolve) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener("message", onMsg);
      resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send(1, "Runtime.enable");
const r = await send(2, "Runtime.evaluate", {
  expression: `JSON.stringify({
    url: location.href,
    title: document.title,
    ready: document.readyState,
    textLen: ((document.body && document.body.innerText) || '').length,
    head: ((document.body && document.body.innerText) || '').replace(/\\s+/g,' ').trim().slice(0, 200),
  })`,
  returnByValue: true,
});
console.log("  结果：" + r.result.value);
ws.close();
