/**
 * 渲染指纹（P0-4）：在 Node 里跑看板应用脚本，把"页面长什么样"变成可 diff 的确定性 JSON。
 *
 * 为什么需要：
 *   结构优化（拆文件、抽函数、class 化）声称"没改行为"，但肉眼比对 HTML 不可信 ——
 *   模板一改，`innerHTML` 字符串几乎必然不同（哪怕渲染结果一模一样）。
 *   所以要在**同一份 VM 数据**上，把改前/改后的应用脚本各跑一遍，逐元素比对
 *   `innerHTML` / `textContent` / 属性 / 每个 `chart()` 的 option。
 *
 * 实现方式：`node:vm` 沙箱 + 极简 DOM/echarts 桩。
 *   桩只做两件事：**忠实地记录**（不解释、不美化），以及**支撑应用代码跑完**
 *   （`getElementById` / `createElement` / `innerHTML` / `querySelectorAll` / `classList` /
 *     `dataset` / `style` / `onclick` / `echarts.init`）。
 *   `innerHTML` 赋值会用一个小容错解析器建出子树 —— 因为 `drawStores` 在写完表格后要
 *   `querySelectorAll("th[data-s]")` 拿表头去绑排序事件，不建子树这一步会静默跳过。
 *
 * 确定性保证：
 *   · 所有对象按键名排序输出
 *   · 函数值统一序列化成 "<fn>"
 *   · 数值原样保留（浮点比较交给调用方，不在这里四舍五入）
 *
 * 本文件不碰文件系统、不碰浏览器。
 */
import vm from "node:vm";
import { extractVmBlock } from "./dashboard-html.mjs";

/**
 * 桩认识的静态 id。**必须与 `src/template/dashboard.html` 的 markup 完全一致** ——
 * `src/test-dashboard-parity.mjs` 会做双向集合断言（桩多一个 / 少一个都算失败），
 * 否则「模板删掉一个容器」这类回归会因为桩照样返回元素而被静默放过。
 */
export const STATIC_IDS = [
  "brand", "dataTime", "genAt", "freshBadge", "projSeg", "winSeg", "acctBadge", "storeBadge", "caliberBadge",
  "refreshWrap", "refreshScope", "refreshBtn", "runChip", "refreshHint", "runPanel", "runSpin",
  "runTitle", "runMeta", "runToggle", "runLog", "alerts", "kpis", "cancelTag", "cancelSub",
  "cancelCards", "incomeCaliberSub", "c-income", "c-cancel", "c-ka", "expoTag", "expoSub",
  "c-expo", "expoTopSub", "expoTopWrap", "highCancelWrap", "hcPlatSeg", "hcCitySel", "highCancelTag", "highCancelSub",
  "incomeTrendTag", "cancelTrendTag", "cancelTrendSub", "kaTag", "kaSub",
  "winSegIncome", "winSegCancel", "winSegKa", "winSegExpo",
  "platSeg", "platSegIncome", "platSegCancel", "platSegKa", "platSegExpo",
  "storeTag",
  "storeFilter", "storeWrap", "notes", "selfCheckTag", "selfCheckSub", "selfCheckWrap",
];

// ════════════════════════════════════════════════════════════════
// 极简 DOM
// ════════════════════════════════════════════════════════════════

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link"]);

/** 容错 HTML 解析：够用即可（生成出来的片段都是良构的） */
function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { top().text += html.slice(i); break; }
    if (lt > i) top().text += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt); i = e < 0 ? html.length : e + 3; continue; }
    const gt = html.indexOf(">", lt);
    if (gt < 0) { top().text += html.slice(lt); break; }
    const raw = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      continue;
    }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1).trim() : raw;
    const m = /^([a-zA-Z][\w-]*)([\s\S]*)$/.exec(body);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    const node = { tag, attrs, children: [], text: "" };
    top().children.push(node);
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(node);
  }
  return root;
}

let uidSeq = 0;

class StubEl {
  constructor(tag = "div", id = "") {
    this.tagName = String(tag).toUpperCase();
    this.tag = String(tag).toLowerCase();
    this.id = id;
    this.uid = ++uidSeq;
    this.parentElement = null;
    this.children = [];
    this._text = "";
    this._rawHtml = "";
    this.attrs = {};
    this.dataset = {};
    this.style = new Proxy({}, { get: (t, k) => t[k] ?? "", set: (t, k, v) => ((t[k] = v), true) });
    this.classList = makeClassList(this);
    this.onclick = null;
    this.onchange = null;
    this._listeners = {};
    this.value = "";
    this.disabled = false;
    this.title = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.checked = false;
  }
  get className() { return this._cls ?? ""; }
  set className(v) { this._cls = String(v); this._clsSet = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._rawHtml; }
  set innerHTML(v) {
    this._rawHtml = v == null ? "" : String(v);
    this.children = [];
    this._text = "";
    this._build(parseHtml(this._rawHtml));
  }
  /** 把容错解析树的直接子节点建成 StubEl 子树（父子关系必须保留，别摊平）。 */
  _build(node) {
    for (const c of node.children) this.appendChild(buildNode(c));
    if (node.text) this._text += node.text;
  }
  get textContent() {
    let s = this._text ?? "";
    for (const c of this.children) s += c.textContent;
    return s;
  }
  set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; this._rawHtml = ""; }
  get innerText() { return this.textContent; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(t, f) { (this._listeners[t] ??= []).push(f); }
  removeEventListener() {}
  dispatch(t, ev = {}) { for (const f of this._listeners[t] ?? []) f(ev); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith("data-")) this.dataset[k.slice(5)] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  matches(sel) { return matchesAny(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  closest(sel) { let n = this; while (n) { if (n.matches?.(sel)) return n; n = n.parentElement; } return null; }
  cloneNode() { const e = new StubEl(this.tag, this.id); e._rawHtml = this._rawHtml; e._text = this._text; return e; }
}

/** 由容错解析树的节点建出 StubEl（递归保留结构）。 */
function buildNode(node) {
  const el = new StubEl(node.tag);
  el.attrs = { ...node.attrs };
  el._cls = node.attrs.class ?? "";
  el._clsSet = new Set(el._cls.split(/\s+/).filter(Boolean));
  for (const [k, val] of Object.entries(node.attrs)) {
    if (k.startsWith("data-")) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = val;
  }
  el._text = node.text ?? "";
  for (const c of node.children) el.appendChild(buildNode(c));
  return el;
}

function makeClassList(el) {  const set = () => (el._clsSet ??= new Set());
  return {
    add: (...c) => c.forEach((x) => set().add(x)),
    remove: (...c) => c.forEach((x) => set().delete(x)),
    contains: (c) => set().has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set().has(c) : !!force;
      if (on) set().add(c); else set().delete(c);
      el._cls = [...set()].join(" ");
      return on;
    },
    get length() { return set().size; },
  };
}

/** 选择器：支持 `tag`、`.cls`、`#id`、`tag.cls`、`[attr]`、`tag[attr]`，以及空格后代组合。 */
function parseCompound(s) {
  const out = { tag: null, cls: [], id: null, attrs: [] };
  const re = /(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(#[\w-]+)|(\[[\w:-]+\])/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.cls.push(m[2].slice(1));
    else if (m[3]) out.id = m[3].slice(1);
    else if (m[4]) out.attrs.push(m[4].slice(1, -1).toLowerCase());
  }
  return out;
}
function matchCompound(el, c) {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.cls) if (!(el._clsSet ?? new Set()).has(k)) return false;
  for (const a of c.attrs) if (!(a in el.attrs) && !(a.startsWith("data-") && a.slice(5) in el.dataset)) return false;
  return true;
}
function matchesAny(el, sel) {
  const parts = String(sel).trim().split(/\s+/).map(parseCompound);
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let n = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (n) { if (matchCompound(n, parts[i])) { found = true; n = n.parentElement; break; } n = n.parentElement; }
    if (!found) return false;
  }
  return true;
}
function queryAll(root, sel) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (matchesAny(c, sel)) out.push(c); walk(c); } };
  walk(root);
  return out;
}

// ════════════════════════════════════════════════════════════════
// 指纹采集
// ════════════════════════════════════════════════════════════════

const FN = "<fn>";
const clean = (v, depth = 0) => {
  if (depth > 24) return "<deep>";
  if (typeof v === "function") return FN;
  if (v === undefined) return "<undefined>";
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = clean(v[k], depth + 1);
  return o;
};

const elSnapshot = (el) => ({
  tag: el.tag,
  id: el.id || null,
  html: el._rawHtml,
  text: el.textContent,
  value: el.value,
  disabled: !!el.disabled,
  title: el.title,
  display: el.style.display ?? "",
  cls: [...(el._clsSet ?? new Set())].sort().join(" "),
  dataset: clean(el.dataset),
  childTags: el.children.map((c) => c.tag),
  childCount: el.children.length,
});

/**
 * VM **读集探针**：把注入的 VM 字面量包成一个记录读取路径的 Proxy。
 *
 * 为什么需要（这是纯值对比永远抓不到的一类回归）：
 *   · **字段名漂移**：模板读 `s.mtName`（不存在）→ 观测到 kind 恒为 `undefined`。
 *     D-1 就是这种，靠人眼对了半天；有了探针，机器每次都能自动报。
 *   · **休眠回归**：当前数据下渲染结果相同、但读取路径变了（分支写坏），
 *     值对比全绿而探针能看出差异。
 *
 * 归一化：数组下标一律记成 `[]`，这样条数变化不会制造噪声。
 */
function wrapVmProbe(root) {
  const reads = new Map();
  /**
   * 宿主/基础访问不记录：`JSON.stringify` 会给每个对象探一次 `toJSON`，
   * 遍历还会碰 `constructor`/`length`/`map` 等。这些不是"读了哪个数据字段"，
   * 记进来只会把读集淹掉（第一版就是这么被 178 条 `xxx.toJSON` 噪声埋掉的）。
   */
  const INFRA = new Set([
    "length", "constructor", "map", "filter", "slice", "sort", "find", "findIndex", "forEach",
    "reduce", "indexOf", "includes", "concat", "join", "some", "every", "flatMap", "at",
    "keys", "values", "entries", "then", "toJSON", "toString", "valueOf", "hasOwnProperty",
  ]);
  const record = (path, val) => {
    const kind = val === undefined ? "undefined" : val === null ? "null"
      : val === "" ? "empty" : Array.isArray(val) ? "array" : typeof val;
    if (!reads.has(path)) reads.set(path, new Set());
    reads.get(path).add(kind);
  };
  const wrap = (v, path, depth) => {
    if (depth > 12 || v === null || typeof v !== "object") return v;
    return new Proxy(v, {
      get(t, k, r) {
        if (typeof k !== "string") return Reflect.get(t, k, r);
        if (INFRA.has(k)) return Reflect.get(t, k, r);
        const p = /^\d+$/.test(k) ? `${path}[]` : `${path}.${k}`;
        const val = Reflect.get(t, k, r);
        record(p, val);
        return wrap(val, p, depth + 1);
      },
    });
  };
  return { proxy: wrap(root, "", 0), reads };
}

/** 把 `const VM = {…};` 里那段字面量换成 `__wrapVM({…})` 调用。 */
function instrumentVm(source) {
  const declAt = source.indexOf("const VM = ");
  const s = source.indexOf("{", declAt);
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < source.length; i++) {
    const c = source[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return source.slice(0, s) + `__wrapVM(${source.slice(s, i + 1)})` + source.slice(i + 1); }
  }
  throw new Error("VM 块未配平，无法注入读集探针");
}

/**
 * 交互场景名（补上"动态交互无门禁"这个盲区）。
 * 纯渲染指纹只看「初次渲染长什么样」，**碰不到**输入框筛选与表头排序：
 * 代码路径根本没被执行过，改坏了也 0 差异。踩过：R10（城市名归一化）修完后
 * 登记项命中 0 次 —— 因为没人往筛选框里打字。
 *
 * ⚠️ 场景名**不含 `.`**，因为指纹叶子路径是 `scenarios.<场景名>.elements.…`，
 *    用名字当键才能让白名单精确到"哪个场景的哪个元素变"（用数组下标做不到）。
 */
export const INTERACTION_SCENARIOS = [
  "proj:品牌A", "proj:品牌B",
  // R10：品牌A台账里「杭州」与「杭州市」并存、品牌B里「上海」与「上海市」并存。
  // ⚠️ 要**带「市」后缀**去筛，才能命中旧代码的漏匹配方向（旧代码是字面包含，筛「杭州市」会漏掉「杭州」）。
  //    而且必须先切到对应项目 —— 一开始只测了留下状态的那个项目，R10 命中 0 次（踩过）。
  "filter:品牌A·杭州市", "filter:品牌A·杭州",
  "filter:品牌B·上海市", "filter:品牌B·上海",
  "filter:（清空）",
  // sort:name 是能体现 D-1 的场景：名字从「门店 ID」变成真实店名，按名称排序的顺序会变
  "sort:name×1", "sort:name×2", "sort:d7cancelRate×1", "sort:city×1",
];

/**
 * 跑一份应用脚本，返回确定性渲染指纹。
 *
 * 返回体**不含 label**：label 只用于报错时的文件名，若混进指纹会让"同输入两次运行"
 * 产生假差异（踩过）。
 *
 * @param {object} o
 * @param {string} o.appJs   应用脚本源码（含 `const VM = …;`）
 * @param {string} [o.label] 仅用于 `vm.runInContext` 的 filename，便于定位报错行
 * @param {string[][]} [o.matrix] 要遍历的 [项目label, 窗口label] 组合；缺省只跑初始态
 * @param {boolean} [o.probe] 是否开启 VM 读集探针（慢一些，但能抓字段名漂移与休眠回归）
 * @param {(url:string, init:any)=>Promise<any>} [o.fetchImpl] 自定义 fetch（用于服务模式档）
 * @param {boolean} [o.serviceMode] 是否注入 `window.__DSH_REFRESH__`（服务模式档）
 */
export function fingerprintApp({
  appJs, label = "app", matrix = [], probe = false,
  fetchImpl = null, serviceMode = false, flushTimers = false,
}) {
  uidSeq = 0;
  const errors = [];
  const timers = [];
  const fetches = [];

  const byId = new Map();
  const getEl = (id) => {
    if (!byId.has(id)) byId.set(id, new StubEl("div", id));
    return byId.get(id);
  };
  // 模板里静态存在的 id（与 STATIC_IDS 对齐，见该常量注释）
  for (const id of STATIC_IDS) getEl(id);
  // 让 c-ka 有 parentElement 和一个 .sub 兄弟（drawKa 会去改它）
  const kaParent = new StubEl("div");
  const kaSub = new StubEl("div");
  kaSub._clsSet = new Set(["sub"]); kaSub._cls = "sub";
  kaParent.appendChild(getEl("c-ka")); kaParent.appendChild(kaSub);

  const document = {
    getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
    createElement: (tag) => new StubEl(tag),
    querySelector: (s) => queryAll(rootish, s)[0] ?? null,
    querySelectorAll: (s) => queryAll(rootish, s),
    body: new StubEl("body"),
    documentElement: new StubEl("html"),
    addEventListener: () => {},
  };
  const rootish = new StubEl("#root");
  for (const el of byId.values()) rootish.appendChild(el);
  rootish.appendChild(kaParent);

  const chartCalls = [];
  const charts = new Map();
  const disposed = [];
  const echarts = {
    init: (el) => {
      const key = el?.id ?? `anon${uidSeq}`;
      const c = {
        setOption: (o) => { chartCalls.push({ id: key, option: clean(o) }); },
        dispose: () => { disposed.push(key); },
        resize: () => {},
        on: () => {},
        getDom: () => el,
      };
      charts.set(key, c);
      return c;
    },
    graphic: {},
  };

  // ── 服务模式档（file:// 之外的另一半刷新契约，见 60-refresh 分片）──
  const timerQueue = [];
  const reloads = [];
  const windowObj = {
    addEventListener: () => {},
    __DSH_REFRESH__: serviceMode ? { token: "T0KEN", scope: "current" } : undefined,
    location: { reload: () => reloads.push(Date.now()) },
  };

  const sandbox = {
    document,
    echarts,
    window: windowObj,
    location: { href: "file:///C:/example/waimai-dashboard.html", reload: () => reloads.push(Date.now()), protocol: serviceMode ? "http:" : "file:" },
    console,
    setTimeout: (f, ms) => { timers.push({ fn: typeof f, ms }); timerQueue.push(f); return timers.length; },
    clearTimeout: (id) => { void id; },
    setInterval: (f, ms) => { timers.push({ fn: typeof f, ms, interval: true }); timerQueue.push(f); return timers.length; },
    clearInterval: (id) => { void id; },
    fetch: fetchImpl
      ? (url, init) => { fetches.push({ url, init }); return fetchImpl(url, init); }
      : (url) => { fetches.push({ url }); return Promise.reject(new Error("fetch disabled in fingerprint harness")); },
    Intl,
    Math,
    JSON,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const { proxy: vmProxy, reads: vmReads } = wrapVmProbe(null); // 占位，真正的 VM 在脚本里
  void vmProxy; void vmReads;

  let probeStore = null;
  if (probe) {
    sandbox.__wrapVM = (v) => { probeStore = wrapVmProbe(v); return probeStore.proxy; };
    appJs = instrumentVm(appJs);
  }

  const ctx = vm.createContext(sandbox);
  let app = null;
  const instrumented = appJs + `
;globalThis.__APP__ = {
  VM,
  charts,
  render,
  clickSeg: (segId, text) => {
    const el = document.getElementById(segId);
    if (!el) return "no-seg";
    const b = el.children.find((x) => x.textContent === text);
    if (!b) return "no-btn";
    if (typeof b.onclick === "function") b.onclick();
    return "ok";
  },
  click: (id) => {
    const el = document.getElementById(id);
    if (!el) return "no-el";
    if (typeof el.onclick === "function") el.onclick();
    return "ok";
  },
  /** 往输入框写值并派发 input 事件（门店表筛选就是这么触发的） */
  setInput: (id, v) => {
    const el = document.getElementById(id);
    if (!el) return "no-el";
    el.value = v;
    el.dispatch("input", { target: el });
    return "ok";
  },
  /** 只改值不派发事件（用于"当前筛选词"这类需要保留状态但不重渲染的场合） */
  peekInput: (id) => document.getElementById(id)?.value ?? null,
  /** 点某个表头 N 次（走 onclick 绑的排序逻辑），返回是否找到该表头 */
  clickSort: (key, times = 1) => {
    const wrap = document.getElementById("storeWrap");
    if (!wrap) return "no-wrap";
    const th = wrap.querySelectorAll("th[data-s]").find((x) => x.dataset.s === key);
    if (!th) return "no-th";
    for (let i = 0; i < times; i++) if (typeof th.onclick === "function") th.onclick();
    return "ok";
  },
  state: () => ({ CUR_PROJ, CUR_WIN }),
};
`;
  try {
    vm.runInContext(instrumented, ctx, { filename: `${label}.js` });
    app = ctx.__APP__;
  } catch (e) {
    errors.push(`运行失败：${e.message}`);
  }

  const snap = (scenario) => ({
    scenario,
    state: app ? app.state() : null,
    elements: Object.fromEntries([...byId.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, elSnapshot(v)])),
    kaSub: elSnapshot(kaSub),
    charts: chartCalls.splice(0, chartCalls.length),
    // ⚠️ unifiedStores 在 init 里一次性算好并被记住，所以只在 init 场景存全量；
    //    其它场景只存条数 —— 否则 9 个场景各存一遍会让指纹膨胀到几 MB。
    unifiedStores: scenario === "init" && app
      ? Object.fromEntries(
          Object.keys(app.VM.projects).sort().map((k) => [k, clean((app.VM.projects[k].unifiedStores ?? []).slice(0, 400))]),
        )
      : null,
    unifiedStoresCount: app
      ? Object.fromEntries(Object.keys(app.VM.projects).sort().map((k) => [k, (app.VM.projects[k].unifiedStores ?? []).length]))
      : null,
  });

  const out = {
    errors: [...errors],
    timers: clean(timers),
    fetches: clean(fetches),
    disposedCharts: [...disposed],
    reloadCount: reloads.length,
    /**
     * ⚠️ 场景是**按名字作键的对象**，不是数组：
     *    指纹叶子路径会变成 `scenarios.init.elements.kpis.html`，
     *    白名单就能精确到"哪个场景的哪个元素变"，而不是 `scenarios.7.…` 这种要靠数下标的写法。
     */
    scenarios: {},
  };
  if (app) {
    out.scenarios.init = snap("init");
    for (const [projLabel, winLabel] of matrix) {
      const r1 = app.clickSeg("projSeg", projLabel);
      const r2 = app.clickSeg("winSeg", winLabel);
      out.scenarios[`${projLabel}|${winLabel}`] = { ...snap(`${projLabel}|${winLabel}`), clicks: [r1, r2] };
    }
    /**
     * ⚠️ 必须**先执行交互、再取快照**。
     *    写成 `{ ...snap(name), interaction: fn() }` 时，属性求值是从左到右的 ——
     *    `snap()` 会先跑，于是每个交互场景记录的都是**上一个场景**的状态
     *    （表现为所有计数整体错位一格，非常像"功能没生效"）。踩过。
     */
    const inter = (name, fn) => { const r = fn(); out.scenarios[name] = { ...snap(name), interaction: r }; };
    const S = INTERACTION_SCENARIOS;
    inter(S[0], () => app.clickSeg("projSeg", "品牌A"));
    inter(S[1], () => app.clickSeg("projSeg", "品牌B"));
    const filt = (proj, text) => () => {
      const a = app.clickSeg("projSeg", proj);
      const b = app.setInput("storeFilter", text);
      return `${a}/${b}`;
    };
    inter(S[2], filt("品牌A", "杭州市"));
    inter(S[3], filt("品牌A", "杭州"));
    inter(S[4], filt("品牌B", "上海市"));
    inter(S[5], filt("品牌B", "上海"));
    inter(S[6], () => app.setInput("storeFilter", ""));
    inter(S[7], () => app.clickSort("name", 1));
    inter(S[8], () => app.clickSort("name", 2));
    inter(S[9], () => app.clickSort("d7cancelRate", 1));
    inter(S[10], () => app.clickSort("city", 1));
    if (serviceMode) {      // 走一遍刷新按钮的异步链路，再把定时器队列 flush 掉（轮询 → 结束）
      const r = app.click("refreshBtn");
      const micro = [];
      for (const f of timerQueue.splice(0)) micro.push(typeof f === "function" ? "fn" : "non-fn");
      out.refreshClick = r;
      out.refreshFlushed = micro.length;
      out.refresh = {
        fetchCount: fetches.length,
        fetchUrls: fetches.map((f) => (typeof f === "string" ? f : f.url)),
        fetchTokens: fetches.map((f) => f?.init?.headers?.["X-Refresh-Token"] ?? null),
        fetchMethods: fetches.map((f) => f?.init?.method ?? "GET"),
        reloadCount: reloads.length,
        btnDisabled: getEl("refreshBtn").disabled,
        btnText: getEl("refreshBtn").textContent,
        title: getEl("runTitle").textContent,
        meta: getEl("runMeta").textContent,
        hint: getEl("refreshHint").textContent,
        panelDisplay: getEl("runPanel").style.display ?? "",
        logHtml: getEl("runLog").innerHTML,
        chipDisplay: getEl("runChip").style.display ?? "",
        scopeOptions: getEl("refreshScope").children.map((c) => c.textContent),
      };
      void flushTimers;
    }
  }
  if (probeStore) {
    out.vmReads = Object.fromEntries(
      [...probeStore.reads.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort().join("|")]),
    );
  }
  return out;
}
