// Камера + два декодера DataMatrix:
//  - zxing-wasm: быстрый, для обычных печатных кодов. Локальная копия в ./vendor (кладёт сборка
//    GitHub Actions), иначе CDN. Service Worker кеширует оба варианта для офлайна.
//  - libdmtx (wasm/dmtx.wasm, лежит в репозитории): читает точечные коды на крышках и флаконах.
// Если zxing не загрузился, сканер работает на одном libdmtx.

import { rgbaToGray, scale, applyFilter } from './imgproc.js';
import { loadDmtx, dmtxDecodeGray } from './dmtx.js';

const ZXING_INTERVAL = 120;  // мс между кадрами для zxing (как в первой версии)
const DMTX_INTERVAL = 300;   // мс между кадрами для libdmtx
const DMTX_AFTER_MISS = 600; // libdmtx включается, если zxing ничего не находит столько мс
const DMTX_SIDE = 640;       // размер кадра, который уходит в libdmtx

// Запасной вариант без Worker: libdmtx в основном потоке, реже и в один проход
const MAIN_PASSES = [
  { size: 480, filter: 'plain' },
  { size: 480, filter: 'min3' },
  { size: 360, filter: 'blur' },
];

export const ZXING_VERSION = '2.2.4'; // та же версия — в tools/vendor-zxing.sh и в workflow
const CDN_JS = `https://cdn.jsdelivr.net/npm/zxing-wasm@${ZXING_VERSION}/dist/iife/reader/index.js`;

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
    this.small = document.createElement('canvas');
    this.sctx = this.small.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.active = true;   // false — предпросмотр прокручен за экран, обработка на паузе
    this.busy = false;
    this.stream = null;
    this.track = null;
    this.torchOn = false;
    this._looping = false;
    this._last = 0;
    this._lastDmtx = 0;
    this._lastHit = 0;
    this._missSince = 0;
    this.worker = null;
    this.workerBusy = false;
    this.mainPass = 0;
    this.stats = { zxing: 0, dmtx: 0 };
  }

  async start() {
    if (this.running) return;
    const [zx, dm] = await Promise.allSettled([loadDecoder(), this._initDmtx()]);
    this.read = zx.status === 'fulfilled' ? zx.value : null;
    this.dmtxMode = dm.status === 'fulfilled' ? dm.value : null; // 'worker' | 'main' | null
    if (!this.read && !this.dmtxMode) throw (zx.reason || dm.reason);
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
    this._missSince = performance.now();
    this._loop();
  }

  /** Поток для libdmtx; если Worker недоступен — основной поток. */
  async _initDmtx() {
    if (this.worker) return 'worker';
    try {
      const w = new Worker(new URL('./dmtx-worker.js', import.meta.url), { type: 'module' });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('worker timeout')), 8000);
        w.onerror = (e) => { clearTimeout(t); reject(e); };
        w.onmessage = () => { clearTimeout(t); resolve(); };
        w.postMessage({ id: 0, gray: new Uint8Array(16).buffer, w: 4, h: 4 }); // прогрев: загрузка wasm
      });
      w.onerror = () => { this.worker = null; this.dmtxMode = this.dmtxMode && 'main'; };
      w.onmessage = (e) => {
        this.workerBusy = false;
        if (e.data?.text && this.running) { this._lastHit = performance.now(); this.onCode?.(e.data.text); }
      };
      this.worker = w;
      return 'worker';
    } catch {
      await loadDmtx();
      return 'main';
    }
  }

  stop() {
    this.running = false;
    this.torchOn = false;
    this.workerBusy = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }

  /** Пауза/возобновление обработки кадров (камера продолжает показывать изображение). */
  setActive(on) {
    if (this.active === on) return;
    this.active = on;
    if (on) { this._missSince = performance.now(); this._loop(); }
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
    if (this._looping) return;
    this._looping = true;
    const tick = (now) => {
      if (!this.running || !this.active) { this._looping = false; return; } // на паузе цикл не крутится
      if (!this.busy && now - this._last >= ZXING_INTERVAL && this.video.readyState >= 2) {
        this._last = now;
        this.busy = true;
        this._decodeFrame(now)
          .catch(err => this.onError?.(err))
          .finally(() => { this.busy = false; });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Центральная область кадра (совпадает с рамкой на экране). */
  _cropRect() {
    const v = this.video;
    const side = Math.round(Math.min(v.videoWidth, v.videoHeight) * 0.75);
    return { sx: Math.round((v.videoWidth - side) / 2), sy: Math.round((v.videoHeight - side) / 2), side };
  }

  async _decodeFrame(now) {
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) return;
    const { sx, sy, side } = this._cropRect();

    // 1) zxing — каждый кадр, как в первой версии
    if (this.read) {
      const out = Math.min(side, 1000);
      if (this.canvas.width !== out) { this.canvas.width = out; this.canvas.height = out; }
      this.ctx.drawImage(v, sx, sy, side, side, 0, 0, out, out);
      const texts = await this.read(this.ctx.getImageData(0, 0, out, out));
      this.stats.zxing++;
      if (texts.length) {
        this._lastHit = now;
        this._missSince = now;
        for (const t of texts) this.onCode?.(t);
        return;
      }
    }

    // 2) libdmtx — только если zxing какое-то время ничего не находит (точечные коды)
    if (!this.dmtxMode || !this.running || !this.active) return;
    if (this.read && now - this._missSince < DMTX_AFTER_MISS) return;
    if (now - this._lastDmtx < (this.dmtxMode === 'worker' ? DMTX_INTERVAL : DMTX_INTERVAL * 2)) return;
    if (this.dmtxMode === 'worker' && this.workerBusy) return;
    this._lastDmtx = now;

    // уменьшение делает браузер (быстро), в серый — уже маленький кадр
    const n = Math.min(side, DMTX_SIDE);
    if (this.small.width !== n) { this.small.width = n; this.small.height = n; }
    this.sctx.drawImage(v, sx, sy, side, side, 0, 0, n, n);
    const gray = rgbaToGray(this.sctx.getImageData(0, 0, n, n).data, n, n);
    this.stats.dmtx++;

    if (this.dmtxMode === 'worker' && this.worker) {
      this.workerBusy = true;
      this.worker.postMessage({ id: this.stats.dmtx, gray: gray.buffer, w: n, h: n }, [gray.buffer]);
      return;
    }
    const p = MAIN_PASSES[this.mainPass++ % MAIN_PASSES.length];
    const sc = scale(gray, n, n, Math.min(1, p.size / n));
    const f = applyFilter(sc, p.filter);
    const text = await dmtxDecodeGray(f.data, f.w, f.h, { timeoutMs: 80 });
    if (text) { this._lastHit = now; this.onCode?.(text); }
  }
}
