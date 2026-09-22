/**
 * 用模擬盤已結算的實測數據（computeStats 的輸出）判斷「這個等級／方向最近其實在虧錢」。
 *
 * 純粹用來標記提醒，不會過濾或擋掉任何訊號——樣本數還很小的時候讓程式自己
 * 關閉某一類，風險比噪音本身更大。等哪一類累積夠多筆還是負的，才值得
 * 認真考慮要不要調整評分邏輯或乾脆不看那一類。
 */
const MIN_SAMPLE = 8;

const findGroup = (list, key) => (list || []).find((g) => g.key === key);

/**
 * @param {object} stats computeStats() 的輸出（journal.stats）
 * @param {{grade?: string, dir?: string}} sig
 * @param {'zh'|'en'} lang
 * @returns {string|null} 有值代表這個等級或方向近期實測是負的，null 代表沒有異常
 */
export function perfWarning(stats, { grade, dir } = {}, lang = 'zh') {
  if (!stats) return null;
  const zh = lang === 'zh';
  const notes = [];

  const g = findGroup(stats.byGrade, grade);
  if (g && g.count >= MIN_SAMPLE && g.avgR < 0) {
    notes.push(zh ? `${grade} 級近 ${g.count} 筆期望值 ${g.avgR.toFixed(2)}R` : `${grade} last ${g.count}: ${g.avgR.toFixed(2)}R`);
  }

  const d = findGroup(stats.byDir, dir);
  if (d && d.count >= MIN_SAMPLE && d.avgR < 0) {
    const dirLabel = dir === 'long' ? (zh ? '做多' : 'Long') : (zh ? '做空' : 'Short');
    notes.push(zh ? `${dirLabel}近 ${d.count} 筆期望值 ${d.avgR.toFixed(2)}R` : `${dirLabel} last ${d.count}: ${d.avgR.toFixed(2)}R`);
  }

  if (!notes.length) return null;
  return (zh ? '⚠️ 實測偏弱：' : '⚠️ Weak track record: ') + notes.join(zh ? '；' : '; ');
}
