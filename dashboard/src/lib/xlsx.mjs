/**
 * 零依赖 xlsx 读取器。
 *
 * 为什么自己写：本机**没有 Python**，也没装 xlsx 解析库。
 * 而 `.xlsx` 本质是个 ZIP（内部是 XML），Node 自带 `zlib` 就能解 deflate，
 * 所以不需要引入任何依赖 —— 也符合项目「只装 echarts」的约定。
 *
 * 支持：sharedStrings、inlineStr、数值/布尔/公式缓存值、单元格引用定位、稀疏行。
 * 不支持：日期格式渲染（读到的是 Excel 序列号）、样式、图表。台账用不到。
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ─────────────────────────── ZIP ───────────────────────────

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * 从 zip buffer 里取出一个条目（自动处理 stored / deflate）。
 */
function readZipEntry(buf, wantName) {
  // 1) 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是合法的 zip：未找到 EOCD");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory 起始偏移

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (name === wantName) {
      // 2) 定位到 local header，跳过它自己的 name/extra
      if (buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error(`local header 异常：${name}`);
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return raw;                 // stored
      if (method === 8) return inflateRawSync(raw); // deflate
      throw new Error(`不支持的压缩方式 ${method}：${name}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** 列出 zip 内所有条目名 */
export function zipList(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是合法的 zip");
  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// ─────────────────────────── XML ───────────────────────────

const unesc = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
   .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
   .replace(/&amp;/g, "&");

/** 解析 sharedStrings.xml → string[] */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  // 每个 <si> 可能包含多个 <r><t>（富文本），要拼起来
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const inner = m[1];
    let text = "";
    // 收集所有 <t>（含 <r><t>）
    for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unesc(t[1]);
    out.push(text);
  }
  return out;
}

/** "BC12" → 54（0 基列号） */
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 解析一个 worksheet → 二维数组（按 r 属性定位，容忍稀疏与空行） */
function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const attrs = rm[1];
    const rNum = Number(/r="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const cAttrs = cm[1];
      const cBody = cm[3] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(cAttrs)?.[1];
      const type = /t="([^"]+)"/.exec(cAttrs)?.[1];
      const idx = ref ? colIndex(ref) : cells.length;

      let val;
      if (type === "inlineStr") {
        val = unesc([...cBody.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cBody)?.[1];
        if (v === undefined) val = "";
        else if (type === "s") val = shared[Number(v)] ?? "";
        else if (type === "b") val = v === "1";
        else if (type === "str" || type === "e") val = unesc(v);
        else val = Number(v);
      }
      cells[idx] = val;
    }
    rows[rNum - 1] = cells;
  }
  // 补齐空洞
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// ─────────────────────────── 对外 API ───────────────────────────

/**
 * 读一个 xlsx 文件。
 * @returns {{ sheets: {name:string, rows:any[][]}[], sheetNames: string[] }}
 */
export function readXlsx(path) {
  const buf = readFileSync(path);
  const shared = parseSharedStrings(readZipEntry(buf, "xl/sharedStrings.xml")?.toString("utf8"));

  // workbook.xml → sheet 名与 rId
  const wb = readZipEntry(buf, "xl/workbook.xml")?.toString("utf8");
  if (!wb) throw new Error("缺少 xl/workbook.xml");
  const order = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const a = m[1];
    return {
      name: unesc(/name="([^"]*)"/.exec(a)?.[1] ?? ""),
      rid: /r:id="([^"]*)"/.exec(a)?.[1] ?? "",
    };
  });

  // workbook.xml.rels → rId 到文件
  const rels = readZipEntry(buf, "xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const ridToTarget = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = m[1];
    const id = /Id="([^"]*)"/.exec(a)?.[1];
    const tgt = /Target="([^"]*)"/.exec(a)?.[1];
    if (id && tgt) ridToTarget[id] = tgt.replace(/^\/?xl\//, "").replace(/^\//, "");
  }

  const sheets = order.map(({ name, rid }) => {
    const target = ridToTarget[rid] ?? "";
    const xml = readZipEntry(buf, "xl/" + target)?.toString("utf8") ?? "";
    return { name, rid, target, rows: parseSheet(xml, shared) };
  });

  return { sheets, sheetNames: sheets.map((s) => s.name) };
}

/** 把一张表转成对象数组（首行作表头）。空表头列会被跳过。 */
export function toObjects(rows, { headerRow = 0 } = {}) {
  const header = (rows[headerRow] ?? []).map((h) => String(h ?? "").trim());
  const out = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (r.every((v) => v === undefined || v === "" || v === null)) continue; // 整行空
    const o = {};
    for (let c = 0; c < header.length; c++) {
      if (!header[c]) continue;
      o[header[c]] = r[c] ?? "";
    }
    out.push(o);
  }
  return { header, rows: out };
}
