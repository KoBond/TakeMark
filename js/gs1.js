// Разбор кодов маркировки GS1 DataMatrix (Честный ЗНАК / МДЛП).
// Из кода берутся только GTIN (AI 01) и серийный номер (AI 21);
// криптохвост (91, 92, 93) и прочие AI отбрасываются.

export const GS = '\x1D';

// AI с фиксированной длиной данных (без учёта самого AI)
const FIXED = {
  '00': 18, '01': 14, '02': 14,
  '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6,
  '20': 2,
};

// AI, которые обычно идут сразу после серийного номера
const AFTER_SN = ['91', '92', '93', '17', '10', '11', '24', '71', '01'];

const SN_LEN_MDLP = 13;
const SN_MAX = 20;

/** Приводит строку от сканера или из ручного ввода к «сырому» виду с GS. */
export function normalizeRaw(input) {
  let s = String(input ?? '');
  s = s.replace(/[\r\n\t]/g, '');
  // текстовые обозначения разделителя
  s = s.replace(/<GS>|\{GS\}|\[GS\]|\\x1d|\\u001d|␝/gi, GS);
  // FNC1, который некоторые декодеры отдают как «è» (код 232)
  s = s.replace(/è/g, GS);
  s = s.trim();
  // идентификатор символики: ]d2 (GS1 DataMatrix), ]C1, ]Q3, ]e0
  s = s.replace(/^\][A-Za-z]\d/, '');
  s = s.replace(/^\x1D+/, '');
  return s;
}

/** Контрольная цифра GTIN-14. */
export function gtinValid(gtin) {
  if (!/^\d{14}$/.test(gtin)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const d = +gtin[12 - i];
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === +gtin[13];
}

function parseBracketed(s) {
  const fields = {};
  const re = /\((\d{2,4})\)([^(]*)/g;
  let m;
  while ((m = re.exec(s))) {
    if (!(m[1] in fields)) fields[m[1]] = m[2].replace(/\x1D/g, '');
  }
  return fields;
}

function parseRaw(s) {
  const fields = {};
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) { i++; continue; }
    const ai = s.substr(i, 2);
    if (!/^\d\d$/.test(ai)) break;
    i += 2;
    let value;
    if (FIXED[ai]) {
      value = s.substr(i, FIXED[ai]);
      i += FIXED[ai];
    } else {
      let end = s.indexOf(GS, i);
      const segEnd = end === -1 ? s.length : end;
      if (ai === '21') {
        const seg = s.slice(i, segEnd);
        // GS потерян: серийный номер длиннее допустимого или «слипся» с криптохвостом
        const glued = seg.length > SN_LEN_MDLP &&
          AFTER_SN.includes(seg.substr(SN_LEN_MDLP, 2));
        if (seg.length > SN_MAX || (end === -1 && glued)) {
          end = i + SN_LEN_MDLP;
        }
      }
      if (end === -1) end = s.length;
      value = s.slice(i, end);
      i = end;
    }
    if (!(ai in fields)) fields[ai] = value;
  }
  return fields;
}

/**
 * Разбирает код маркировки.
 * @returns {{ok:true, gtin, sn, key, line} | {ok:false, error}}
 */
export function parseCode(input) {
  const s = normalizeRaw(input);
  if (!s) return { ok: false, error: 'Пустой код' };

  const fields = s.startsWith('(') ? parseBracketed(s) : parseRaw(s);
  const gtin = fields['01'];
  const sn = fields['21'];

  if (!gtin || sn === undefined) {
    return { ok: false, error: 'Не код маркировки: нет GTIN (01) или серийного номера (21)' };
  }
  if (!gtinValid(gtin)) {
    return { ok: false, error: 'Неверный GTIN: ' + gtin };
  }
  if (!/^[\x21-\x7E]{1,20}$/.test(sn)) {
    return { ok: false, error: 'Неверный серийный номер' };
  }
  return { ok: true, gtin, sn, key: gtin + '|' + sn, line: '01' + gtin + '21' + sn };
}
