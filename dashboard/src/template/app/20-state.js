/* ══════ 分片 20-state.js · 运行态：当前项目 / 当前窗口 / 当前平台 / 图表实例表 ══════ */
let CUR_PROJ = VM.projectOrder[0];
let CUR_WIN = "today";
/**
 * ⭐ 平台维度（2026-09-22 经营者要求）：全部平台 / 美团 / 闪购，默认全部平台。
 * ⛔「全部平台」是**并列展示**，不是把两个平台相加（口径不同 + 门店集合不同）。
 * 默认值由 `VM.caliber.platformDefault` 给（口径集中化，模板不写死）。
 */
let CUR_PLATFORM = VM.caliber?.platformDefault ?? "all";
const charts = {};
