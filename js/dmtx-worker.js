// Отдельный поток для libdmtx: тяжёлая обработка не тормозит интерфейс и zxing.
// Получает кадр в оттенках серого, перебирает по очереди варианты масштаба и фильтра.

import { scale, applyFilter } from './imgproc.js';
import { loadDmtx, dmtxDecodeGray } from './dmtx.js';

const PASSES = [
  { size: 480, filter: 'plain' },
  { size: 480, filter: 'min3' },
  { size: 360, filter: 'blur' },
  { size: 640, filter: 'min3' },
  { size: 360, filter: 'plain' },
  { size: 480, filter: 'min5' },
];
let pass = 0;

self.onmessage = async (e) => {
  const { id, gray, w, h } = e.data;
  try {
    await loadDmtx();
    const p = PASSES[pass++ % PASSES.length];
    const sc = scale(new Uint8Array(gray), w, h, Math.min(1, p.size / Math.max(w, h)));
    const f = applyFilter(sc, p.filter);
    const text = await dmtxDecodeGray(f.data, f.w, f.h, { timeoutMs: 150 });
    self.postMessage({ id, text });
  } catch (err) {
    self.postMessage({ id, text: null, error: String(err?.message || err) });
  }
};
