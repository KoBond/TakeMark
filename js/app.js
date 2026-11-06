import { parseCode } from './gs1.js';
import { store, requestPersistence } from './storage.js';
import { Scanner, loadDecoder } from './scanner.js';
import { loadDmtx } from './dmtx.js';
import { APP_VERSION, APP_DATE } from './version.js';
import { decodePhoto } from './photo.js';
import { rgbaToGray } from './imgproc.js';
import { makeFile, mailtoUrl, isEmail, formatDateTime, formatTime, fileName, buildText } from './export.js';

const MAX_SESSIONS = 3;   // всего, включая текущую
const MAX_EMAILS = 5;
const REPEAT_MS = 2500;   // антидребезг для марки в кадре
const MAILTO_SOFT_LIMIT = 150;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const state = { sessions: [], emails: [] };
let undo = null;

/* ---------- данные ---------- */

const current = () => state.sessions.find(s => !s.closedAt);

const saveSessions = () => store.set('sessions', state.sessions);
const saveEmails = () => store.set('emails', state.emails);

function makeSession() {
  return { id: crypto.randomUUID?.() || String(Date.now()), createdAt: Date.now(), items: [], sent: [] };
}

function startNewSession() {
  const cur = current();
  if (cur && cur.items.length === 0) return cur; // пустую не плодим
  if (cur) cur.closedAt = Date.now();
  const s = makeSession();
  state.sessions.unshift(s);
  state.sessions.sort((a, b) => b.createdAt - a.createdAt);
  state.sessions = state.sessions.slice(0, MAX_SESSIONS);
  saveSessions();
  return s;
}

function rememberEmail(addr) {
  const a = addr.trim().toLowerCase();
  state.emails = [a, ...state.emails.filter(e => e !== a)].slice(0, MAX_EMAILS);
  saveEmails();
}

/* ---------- обратная связь ---------- */

let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* без звука */ }
}
function beep(freq, ms, delay = 0) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + delay / 1000;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = freq;
  o.type = 'sine';
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + ms / 1000 + 0.02);
}
const vibrate = (p) => { try { navigator.vibrate?.(p); } catch { /* iOS не умеет */ } };

let toastTimer = null;
function toast(kind, text, action) {
  const t = $('#toast');
  t.replaceChildren(el('span', '', text));
  if (action) {
    const b = el('button', 'toast-action', action.label);
    b.type = 'button';
    b.onclick = () => { action.fn(); t.classList.remove('show'); };
    t.append(b);
  }
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2200);
}

function feedback(kind, text, showToast = true) {
  if (showToast) toast(kind, text);
  const vp = $('#viewport');
  vp.classList.remove('flash-ok', 'flash-dup', 'flash-err');
  void vp.offsetWidth;
  vp.classList.add('flash-' + kind);
  if (kind === 'ok') { beep(1180, 90); vibrate(50); }
  if (kind === 'dup') { beep(520, 90); beep(520, 90, 140); vibrate([40, 60, 40]); }
  if (kind === 'err') { beep(260, 160); vibrate(120); }
}

/* ---------- добавление марок ---------- */

const lastSeen = new Map();

function addCode(raw, source) {
  const r = parseCode(raw);
  const now = Date.now();

  if (source === 'scan') {
    const k = r.ok ? r.key : 'raw:' + raw;
    const prev = lastSeen.get(k);
    lastSeen.set(k, now);
    if (prev && now - prev < REPEAT_MS) return r; // та же марка всё ещё в кадре
    if (lastSeen.size > 500) lastSeen.clear();
  }

  if (!r.ok) { feedback('err', r.error, source !== 'manual'); return r; }

  const s = current();
  if (s.items.some(i => i.key === r.key)) {
    feedback('dup', 'Уже в списке: ' + r.sn, source !== 'manual');
    return { ...r, dup: true };
  }
  s.items.push({ key: r.key, gtin: r.gtin, sn: r.sn, line: r.line, ts: now, src: source });
  s.updatedAt = now;
  saveSessions();
  render();
  feedback('ok', 'Добавлено: ' + r.sn);
  return r;
}

function removeItem(key) {
  const s = current();
  const idx = s.items.findIndex(i => i.key === key);
  if (idx < 0) return;
  const [item] = s.items.splice(idx, 1);
  undo = { sessionId: s.id, item, idx };
  saveSessions();
  render();
  toast('info', 'Марка удалена', {
    label: 'Вернуть',
    fn: () => {
      const ses = state.sessions.find(x => x.id === undo?.sessionId);
      if (ses && !ses.items.some(i => i.key === undo.item.key)) {
        ses.items.splice(undo.idx, 0, undo.item);
        saveSessions();
        render();
      }
      undo = null;
    },
  });
}

/* ---------- отрисовка ---------- */

function render() {
  const s = current();
  const n = s.items.length;
  $('#count').textContent = n;
  $('#session-meta').textContent = `Начата ${formatDateTime(s.createdAt)}` +
    (s.sent?.length ? ` · отправлено: ${s.sent.at(-1).to || 'файлом'}` : '');

  const list = $('#list');
  list.replaceChildren();
  for (let i = n - 1; i >= 0; i--) {
    const it = s.items[i];
    const li = el('li', 'item');
    li.append(el('span', 'num', String(i + 1)));
    const body = el('div', 'item-body');
    body.append(el('span', 'sn', it.sn));
    const meta = el('span', 'meta', `GTIN ${it.gtin} · ${formatTime(it.ts)}`);
    if (it.src === 'manual') meta.append(el('em', 'tag', 'вручную'));
    if (it.src === 'photo') meta.append(el('em', 'tag', 'фото'));
    body.append(meta);
    li.append(body);
    const del = el('button', 'icon-btn del');
    del.type = 'button';
    del.setAttribute('aria-label', 'Удалить ' + it.sn);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.onclick = () => removeItem(it.key);
    li.append(del);
    list.append(li);
  }
  $('#empty').hidden = n > 0;

  const btn = $('#btn-send');
  btn.disabled = n === 0;
  btn.textContent = n ? `Отправить ${n} ${plural(n, 'марку', 'марки', 'марок')}` : 'Отправить';

  renderHistory();
}

function renderHistory() {
  const past = state.sessions.filter(s => s.closedAt);
  $('#history-card').hidden = past.length === 0;
  const ul = $('#history');
  ul.replaceChildren();
  for (const s of past) {
    const li = el('li', 'hist');
    const info = el('div', 'hist-info');
    info.append(el('b', '', formatDateTime(s.createdAt)));
    const last = s.sent?.at(-1);
    info.append(el('span', 'muted small',
      `${s.items.length} ${plural(s.items.length, 'марка', 'марки', 'марок')}` +
      (last ? ` · отправлено ${last.to || 'файлом'}` : ' · не отправлено')));
    li.append(info);
    const actions = el('div', 'hist-actions');
    const send = el('button', 'chip', 'Отправить');
    send.type = 'button';
    send.onclick = () => openSend(s.id);
    const dl = el('button', 'chip', 'Скачать');
    dl.type = 'button';
    dl.onclick = () => download(s);
    actions.append(send, dl);
    li.append(actions);
    ul.append(li);
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ---------- выгрузка и отправка ---------- */

function download(session) {
  const blob = new Blob([buildText(session.items)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = fileName(session);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

let sendSessionId = null;

function openSend(sessionId) {
  sendSessionId = sessionId;
  const s = state.sessions.find(x => x.id === sessionId);
  const n = s.items.length;
  $('#send-title').textContent = `Отправить ${n} ${plural(n, 'марку', 'марки', 'марок')}`;
  $('#send-error').hidden = true;
  $('#email-new').value = '';
  const note = $('#send-note');
  note.hidden = n <= MAILTO_SOFT_LIMIT;
  note.textContent = 'Список большой: некоторые почтовые приложения обрезают длинный текст письма. Надёжнее «Поделиться файлом».';
  renderEmails();
  $('#dlg-send').showModal();
}

function renderEmails() {
  const box = $('#email-list');
  box.replaceChildren();
  if (!state.emails.length) { box.hidden = true; return; }
  box.hidden = false;
  box.append(el('legend', 'small muted', 'Последние адреса'));
  state.emails.forEach((addr, i) => {
    const row = el('div', 'email-row');
    const label = el('label', 'email-opt');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'email';
    radio.value = addr;
    radio.checked = i === 0;
    radio.onchange = () => { $('#email-new').value = ''; };
    label.append(radio, el('span', '', addr));
    const rm = el('button', 'icon-btn');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Убрать адрес ' + addr);
    rm.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    rm.onclick = () => {
      state.emails = state.emails.filter(e => e !== addr);
      saveEmails();
      renderEmails();
    };
    row.append(label, rm);
    box.append(row);
  });
}

/** Адрес из поля «новый» или выбранный в списке. */
function chosenEmail() {
  const typed = $('#email-new').value.trim();
  if (typed) return typed;
  return document.querySelector('input[name="email"]:checked')?.value || '';
}

function sendError(text) {
  const e = $('#send-error');
  e.textContent = text;
  e.hidden = !text;
}

function markSent(session, to, method) {
  session.sent = [...(session.sent || []), { to: to || null, at: Date.now(), method }];
  saveSessions();
  render();
}

function onMail() {
  const s = state.sessions.find(x => x.id === sendSessionId);
  const to = chosenEmail();
  if (!isEmail(to)) return sendError(to ? 'Проверьте адрес почты' : 'Укажите адрес почты');
  sendError('');
  rememberEmail(to);
  markSent(s, to, 'mail');
  $('#dlg-send').close();
  location.href = mailtoUrl(to, s);
}

function onShare() {
  const s = state.sessions.find(x => x.id === sendSessionId);
  const to = chosenEmail();
  if (to && !isEmail(to)) return sendError('Проверьте адрес почты');
  sendError('');
  const file = makeFile(s);

  if (!navigator.canShare?.({ files: [file] })) {
    sendError('Этот браузер не умеет делиться файлами. Файл будет скачан.');
    download(s);
    return;
  }
  // буфер и share вызываем синхронно в одном нажатии — иначе Safari отклонит share
  if (to) navigator.clipboard?.writeText(to).catch(() => {});
  navigator.share({ files: [file], title: file.name })
    .then(() => {
      if (to) rememberEmail(to);
      markSent(s, to, 'share');
      $('#dlg-send').close();
      if (to) toast('info', 'Адрес скопирован: ' + to);
    })
    .catch(err => {
      if (err?.name !== 'AbortError') sendError('Не удалось поделиться: ' + (err?.message || err));
    });
}

/* ---------- диалоги ---------- */

function confirmAction(text, okLabel = 'Да') {
  return new Promise(resolve => {
    const d = $('#dlg-confirm');
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.returnValue = '';
    d.showModal();
  });
}

async function onMore(action) {
  const s = current();
  if (action === 'download') {
    if (!s.items.length) return toast('info', 'Список пуст');
    download(s);
  }
  if (action === 'new') {
    if (!s.items.length) return toast('info', 'Текущая сессия уже пустая');
    const notSent = !s.sent?.length;
    const ok = await confirmAction(
      `Начать новую сессию? Текущий список (${s.items.length}) перейдёт в историю.` +
      (notSent ? ' Он ещё не отправлен.' : '') +
      ' В истории хранятся 3 последние сессии.', 'Начать новую');
    if (ok) { startNewSession(); render(); toast('info', 'Новая сессия'); }
  }
  if (action === 'clear') {
    if (!s.items.length) return;
    const ok = await confirmAction(`Удалить все марки (${s.items.length}) из текущей сессии?`, 'Очистить');
    if (ok) { s.items = []; saveSessions(); render(); toast('info', 'Список очищен'); }
  }
}

/* ---------- сканер ---------- */

let scanner = null;

async function startScan() {
  unlockAudio();
  const status = $('#scan-status');
  const btn = $('#btn-scan');
  btn.disabled = true;
  status.textContent = 'Запускаю камеру…';
  scanner ??= new Scanner($('#video'), {
    onCode: (text) => addCode(text, 'scan'),
    onError: (e) => console.warn(e),
  });
  try {
    await scanner.start();
    applyPreviewState();
    $('#viewport').classList.add('live');
    $('#scan-idle').hidden = true;
    $('#scan-controls').hidden = false;
    const caps = scanner.capabilities();
    $('#btn-torch').hidden = !caps.torch;
    const zw = $('#zoom-wrap');
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      const z = $('#zoom');
      z.min = caps.zoom.min; z.max = Math.min(caps.zoom.max, 8); z.step = caps.zoom.step || 0.1;
      z.value = caps.zoom.min;
      zw.hidden = false;
    } else zw.hidden = true;
  } catch (err) {
    status.textContent = cameraErrorText(err);
    scanner.stop();
  } finally {
    btn.disabled = false;
  }
}

function stopScan() {
  scanner?.stop();
  $('#scan-paused').hidden = true;
  $('#viewport').classList.remove('live');
  $('#scan-idle').hidden = false;
  $('#scan-controls').hidden = true;
  $('#btn-torch').classList.remove('on');
  $('#scan-status').textContent = 'Наведите камеру на код DataMatrix на упаковке';
}

function cameraErrorText(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return isIOS()
      ? 'Нет доступа к камере. Настройки → Safari → Камера → «Разрешить», затем обновите страницу. Можно ввести код вручную.'
      : 'Нет доступа к камере. Нажмите на значок замка в адресной строке → Разрешения → Камера. Можно ввести код вручную.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена. Введите код вручную.';
  if (name === 'NotReadableError') return 'Камера занята другим приложением. Закройте его и попробуйте снова.';
  return (err?.message || 'Не удалось запустить сканер') +
    (navigator.onLine ? '' : '. Нет интернета: при первом запуске сканеру нужна сеть, чтобы загрузить декодер.');
}

/* ---------- пауза, когда окно камеры прокручено за экран ---------- */

const PAUSE_BELOW = 1 / 3;  // видно меньше 1/3 (скрыто больше 2/3) — обработка на паузе
const RESUME_ABOVE = 2 / 3; // видно больше 2/3 — обработка снова идёт
let previewVisible = true;

/** Доля видимой части окна камеры между шапкой и нижней кнопкой. */
function visibleShare(entry) {
  const h = entry.boundingClientRect.height;
  if (!h) return 0;
  const rootH = entry.rootBounds?.height || h;
  return entry.intersectionRect.height / Math.min(h, rootH); // если окно выше экрана — считаем от экрана
}

function applyPreviewState() {
  scanner?.setActive(previewVisible);
  const paused = !!scanner?.running && !previewVisible;
  $('#scan-paused').hidden = !paused;
  if (scanner?.running) $('#scan-controls').hidden = paused;
}

function watchPreview() {
  if (!('IntersectionObserver' in window)) return;
  const vp = $('#viewport');
  let io = null;
  const observe = () => {
    io?.disconnect();
    const top = $('.top').offsetHeight;
    const bottom = $('.bar').offsetHeight;
    const thresholds = [...Array.from({ length: 21 }, (_, i) => i / 20), PAUSE_BELOW, RESUME_ABOVE].sort((a, b) => a - b);
    io = new IntersectionObserver((entries) => {
      const share = visibleShare(entries[entries.length - 1]);
      if (previewVisible && share < PAUSE_BELOW) previewVisible = false;
      else if (!previewVisible && share > RESUME_ABOVE) previewVisible = true;
      else return;
      applyPreviewState();
    }, { rootMargin: `-${top}px 0px -${bottom}px 0px`, threshold: thresholds });
    io.observe(vp);
  };
  observe();
  let t = null;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(observe, 250); });
  $('#scan-paused').onclick = () => vp.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- распознавание по фото ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть фото')); };
    img.src = url; // <img> учитывает EXIF-поворот
  });
}

async function onPhoto(file) {
  if (!file) return;
  unlockAudio();
  const label = $('#photo-label');
  const btn = $('.photo-btn');
  btn.classList.add('busy');
  label.textContent = 'Распознаю фото…';
  try {
    const img = await loadImage(file);
    const maxSide = 2000;
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const gray = rgbaToGray(ctx.getImageData(0, 0, w, h).data, w, h);
    let zxingRead = null;
    try { zxingRead = await loadDecoder(); } catch { /* только libdmtx */ }
    await loadDmtx();
    const r = await decodePhoto(gray, w, h, {
      zxingRead,
      budgetMs: 15000,
      onProgress: (n) => { label.textContent = `Распознаю фото… (${n})`; },
    });
    if (r) addCode(r.text, 'photo');
    else feedback('err', 'Код на фото не прочитан. Снимите ближе, код в центре, без бликов — или введите вручную.');
  } catch (err) {
    feedback('err', err?.message || 'Ошибка распознавания фото');
  } finally {
    btn.classList.remove('busy');
    label.textContent = 'Сфотографировать марку';
    $('#photo-input').value = '';
  }
}

/* ---------- iPhone: подсказка «На экран Домой» ---------- */

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}
function setupIosHint() {
  if (!isIOS() || isStandalone()) return;
  let until = 0;
  try { until = +localStorage.getItem('takemark:iosHintUntil') || 0; } catch { /* */ }
  if (Date.now() < until) return;
  $('#ios-hint').hidden = false;
  $('#ios-hint-close').onclick = () => {
    $('#ios-hint').hidden = true;
    try { localStorage.setItem('takemark:iosHintUntil', String(Date.now() + 7 * 864e5)); } catch { /* */ }
  };
}

/* ---------- запуск ---------- */

async function init() {
  state.sessions = (await store.get('sessions')) || [];
  state.emails = (await store.get('emails')) || [];
  if (!current()) {
    state.sessions.unshift(makeSession());
    state.sessions = state.sessions.slice(0, MAX_SESSIONS);
    saveSessions();
  }
  render();
  setupIosHint();
  watchPreview();
  requestPersistence();

  $('#btn-scan').onclick = startScan;
  $('#btn-stop').onclick = stopScan;
  $('#btn-torch').onclick = async () => {
    const on = !scanner?.torchOn;
    try { if (await scanner.setTorch(on)) $('#btn-torch').classList.toggle('on', on); } catch { /* */ }
  };
  $('#photo-input').onchange = (e) => onPhoto(e.target.files?.[0]);
  $('#zoom').oninput = (e) => scanner?.setZoom(+e.target.value).catch(() => {});

  $('#manual').onsubmit = (e) => {
    e.preventDefault();
    unlockAudio();
    const input = $('#manual-input');
    const err = $('#manual-error');
    const r = addCode(input.value, 'manual');
    if (r.ok && !r.dup) { input.value = ''; err.hidden = true; }
    else { err.textContent = r.ok ? 'Эта марка уже в списке' : r.error; err.hidden = false; }
  };

  $('#btn-more').onclick = () => { $('#dlg-more').returnValue = ''; $('#dlg-more').showModal(); };
  $('#dlg-more').onclose = () => onMore($('#dlg-more').returnValue);
  $('#btn-send').onclick = () => openSend(current().id);
  $('#btn-mail').onclick = onMail;
  $('#btn-share').onclick = onShare;
  $('#btn-download').onclick = () => download(state.sessions.find(x => x.id === sendSessionId));
  $('#email-new').oninput = () => {
    if ($('#email-new').value) document.querySelectorAll('input[name="email"]').forEach(r => { r.checked = false; });
  };

  // закрытие нижних листов тапом по фону
  document.querySelectorAll('dialog.sheet').forEach(d => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
  });

  // камера выключается, когда приложение свёрнуто
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && scanner?.running) stopScan();
  });

  $('#app-version').textContent = `версия ${APP_VERSION} от ${APP_DATE}`;

  if ('serviceWorker' in navigator) {
    // новая версия установилась в фоне — предлагаем перезагрузить
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      toast('info', 'Доступна новая версия приложения', { label: 'Обновить', fn: () => location.reload() });
    });
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW', err));
  }
  // загружаем декодер заранее, чтобы он попал в кеш для офлайна
  const warm = () => { loadDecoder().catch(() => {}); loadDmtx().catch(() => {}); };
  ('requestIdleCallback' in window) ? requestIdleCallback(warm, { timeout: 3000 }) : setTimeout(warm, 1500);
}

init();
