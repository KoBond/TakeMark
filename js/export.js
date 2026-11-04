// Формирование выгрузки: текст, имя файла, письмо.

const pad = n => String(n).padStart(2, '0');

export function formatDateTime(ts, withYear = true) {
  const d = new Date(ts);
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${withYear ? '.' + d.getFullYear() : ''}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Одна марка на строку в формате 01<GTIN>21<SN>, перевод строки CRLF. */
export function buildText(items) {
  return items.map(i => i.line).join('\r\n') + (items.length ? '\r\n' : '');
}

export function fileName(session) {
  const d = new Date(session.createdAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return `marks_${stamp}_${session.items.length}.txt`;
}

export function makeFile(session) {
  return new File([buildText(session.items)], fileName(session), { type: 'text/plain' });
}

export function isEmail(s) {
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(String(s).trim());
}

export function subject(session) {
  return `Марки: ${session.items.length} шт., ${formatDateTime(session.createdAt)}`;
}

export function mailtoUrl(to, session) {
  const body =
    `Отсканировано марок: ${session.items.length}\r\n` +
    `Сессия: ${formatDateTime(session.createdAt)}\r\n` +
    `Формат: 01<GTIN>21<серийный номер>\r\n\r\n` +
    buildText(session.items);
  const addr = encodeURIComponent(to.trim()).replace(/%40/g, '@');
  return `mailto:${addr}?subject=${encodeURIComponent(subject(session))}&body=${encodeURIComponent(body)}`;
}
