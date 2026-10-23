/* ══════ 分片 30-chart.js · 图表基建：chart() / 坐标轴 / 系列 / 网格 / 图例 ══════ */
/** 重建图表前先 dispose，否则 resize 时会拿到旧实例、图叠图 */
function chart(id, option) {
  const el = $(id);
  if (charts[id]) { charts[id].dispose(); delete charts[id]; }
  if (!el) return null;
  const c = echarts.init(el);
  c.setOption(option);
  charts[id] = c;
  return c;
}
const proj = () => VM.projects[CUR_PROJ];
const win = () => proj().windows[CUR_WIN] ?? {};

/**
 * 把一个图表容器换成**文字说明** —— 用于「该平台在该板块没有序列数据」时的**如实降级**。
 * ⚠️ 必须先 dispose 旧实例：否则 echarts 的 canvas 会盖在文字上面，看起来像没生效。
 */
function clearChart(id, html) {
  if (charts[id]) { charts[id].dispose(); delete charts[id]; }
  const el = $(id);
  if (el) el.innerHTML = html;
}

const AXIS = (data) => ({ type: "category", data, boundaryGap: false,
  axisLine: { lineStyle: { color: "#e6eaf2" } }, axisLabel: { color: "#6b7691", fontSize: 11 } });
const YAXIS = (name, extra = {}) => Object.assign({ type: "value", name,
  nameTextStyle: { color: "#6b7691", fontSize: 11 }, splitLine: { lineStyle: { color: "#f0f3f8" } },
  axisLabel: { color: "#6b7691", fontSize: 11 } }, extra);
const S = (name, data, color, extra = {}) => Object.assign({
  name, type: "line", data, smooth: true, symbol: "circle", symbolSize: 5,
  lineStyle: { width: 2, color }, itemStyle: { color }, areaStyle: { opacity: .10, color },
}, extra);
const GRID = { left: 8, right: 14, top: 36, bottom: 6, containLabel: true };
/**
 * ⚠️ 图例必须**居中**，不能右对齐（2026-09-22 修）。
 *
 * 真因：echarts 的 Y 轴 `name` 默认画在**轴的顶端**（`nameLocation:"end"`），
 *   所以右轴的「取消率 %」/「ROI」/「曝光人数」就落在**右上角**；
 *   而图例原来写的 `right: 0` 也在右上角 —— 两段文字叠在一起，
 *   看起来像「取消单数取消率」糊成一团。
 *   **不是图表高度不够**，调高度不会好。
 *   居中后图例位于左右两个轴名之间，互不遮挡。
 */
const LEGEND = { top: 0, left: "center", itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11.5, color: "#6b7691" } };

