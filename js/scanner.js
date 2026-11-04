// Камера + два декодера DataMatrix:
//  - zxing-wasm: быстрый, для обычных печатных кодов. Локальная копия в ./vendor (кладёт сборка
//    GitHub Actions), иначе CDN. Service Worker кеширует оба варианта для офлайна.
//  - libdmtx (wasm/dmtx.wasm, лежит в репозитории): читает точечные коды на крышках и флаконах.
// Если zxing не загрузился, сканер работает на одном libdmtx.

import { rgbaToGray, scale, applyFilter } from './imgproc.js';
import { loadDmtx, dmtxDecodeGray } from './dmtx.js';

const DMTX_PASSES = [
  { size: 480, filter: 'plain' },
  { size: 480, filter: 'min3' },
  { size: 360, filter: 'blur' },
  { size: 640, filter: 'min3' },
  { size: 360, filter: 'plain' },
  { size: 480, filter: 'min5' },
];

const CDN_JS = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2/dist/iife/reader/index.js';

let decoderPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { el.remove(); reject(new Error('Не удалось загрузить модуль распознавания (' + new URL(src, location.href).host + '). Проверьте интернет и попробуйте снова')); };
    document.head.appendChild(el);
  });
}

async function vendorFiles() {
  try {
    const r = await fetch('./vendor/files.json', { cache: 'no-cache' });
    if (!r.ok) return null;
    const list = await r.json();
    return Array.isArray(list) && list.length ? list : null;
  } catch { return null; }
}

/** Загружает декодер один раз. Возвращает функцию read(imageData) → массив текстов. */
export function loadDecoder() {
  if (decoderPromise) return decoderPromise;
  decoderPromise = (async () => {
    const local = await vendorFiles();
    let usedLocal = false;
    if (local) {
      try { await loadScript('./vendor/zxing-reader.js'); usedLocal = true; } catch { /* пробуем CDN */ }
    }
    if (!usedLocal) await loadScript(CDN_JS);

    const Z = window.ZXingWASM;
    if (!Z) throw new Error('Декодер не инициализирован');

    const overrides = usedLocal
      ? { locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('./vendor/' + path, location.href).href : prefix + path) }
      : undefined;

    if (typeof Z.prepareZXingModule === 'function') {
      await Z.prepareZXingModule({ ...(overrides ? { overrides } : {}), fireImmediately: true });
    } else if (overrides && typeof Z.setZXingModuleOverrides === 'function') {
      Z.setZXingModuleOverrides(overrides);
    }

    const readFn = Z.readBarcodes || Z.readBarcodesFromImageData;
    if (typeof readFn !== 'function') throw new Error('Неизвестная версия zxing-wasm');

    const options = {
      formats: ['DataMatrix'],
      tryHarder: true,
      maxNumberOfSymbols: 4,
      textMode: 'Plain', // «сырой» текст с GS, а не (01)…(21)…
    };

    // прогрев: заставляем модуль скачать wasm сразу (важно для офлайна)
    try { await readFn(new ImageData(8, 8), options); } catch { /* ок */ }

    return async (imageData) => {
      const results = await readFn(imageData, options);
      return (results || []).filter(r => r && r.text && r.isValid !== false).map(r => r.text);
    };
  })();
  decoderPromise.catch(() => { decoderPromise = null; }); // дать шанс повторить при появлении сети
  return decoderPromise;
}

export class Scanner {
  constructor(video, { onCode, onError } = {}) {
    this.video = video;
    this.onCode = onCode;
    this.onError = onError;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.busy = false;
    this.stream = null;
    this.track = null;
    this.torchOn = false;
    this.interval = 120; // мс между попытками распознавания
    this._last = 0;
  }

  async start() {
    if (this.running) return;
    const [zx, dm] = await Promise.allSettled([loadDecoder(), loadDmtx()]);
    this.read = zx.status === 'fulfilled' ? zx.value : null;
    this.hasDmtx = dm.status === 'fulfilled';
    if (!this.read && !this.hasDmtx) throw (zx.reason || dm.reason);
    this.pass = 0;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Браузер не даёт доступ к камере. Откройте сайт по HTTPS в Safari или Chrome.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    this.track = this.stream.getVideoTracks()[0];
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();

    const caps = this.capabilities();
    if (caps.focusMode?.includes?.('continuous')) {
      this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    this.torchOn = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }

  capabilities() {
    try { return this.track?.getCapabilities?.() || {}; } catch { return {}; }
  }

  async setTorch(on) {
    if (!this.capabilities().torch) return false;
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
    this.torchOn = on;
    return true;
  }

  async setZoom(value) {
    if (!this.capabilities().zoom) return;
    await this.track.applyConstraints({ advanced: [{ zoom: value }] });
  }

  _loop() {
    if (!this.running) return;
    requestAnimationFrame(now => {
      if (!this.running) return;
      if (!this.busy && now - this._last >= this.interval && this.video.readyState >= 2) {
        this._last = now;
        this.busy = true;
        this._decodeFrame()
          .catch(err => this.onError?.(err))
          .finally(() => { this.busy = false; });
      }
      this._loop();
    });
  }

  async _decodeFrame() {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    // центральная область кадра (совпадает с рамкой на экране)
    const side = Math.round(Math.min(vw, vh) * 0.75);
    const sx = Math.round((vw - side) / 2), sy = Math.round((vh - side) / 2);
    const out = Math.min(side, 1000);
    if (this.canvas.width !== out) { this.canvas.width = out; this.canvas.height = out; }
    this.ctx.drawImage(v, sx, sy, side, side, 0, 0, out, out);
    const img = this.ctx.getImageData(0, 0, out, out);
    if (this.read) {
      const texts = await this.read(img);
      if (texts.length) { for (const t of texts) this.onCode?.(t); return; }
    }
    if (!this.hasDmtx) return;
    // точечные коды: каждый кадр — свой вариант масштаба и фильтра
    const p = DMTX_PASSES[this.pass++ % DMTX_PASSES.length];
    const gray = rgbaToGray(img.data, out, out);
    const sc = scale(gray, out, out, Math.min(1, p.size / out));
    const f = applyFilter(sc, p.filter);
    const text = await dmtxDecodeGray(f.data, f.w, f.h, { timeoutMs: 120 });
    if (text) this.onCode?.(text);
  }
}
