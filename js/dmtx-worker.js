// Отдельный поток для libdmtx: тяжёлая обработка не тормозит интерфейс и zxing.
//  type 'frame' — кадр живого сканирования, один вариант обработки на кадр (по кругу);
//  type 'photo' — фотография, полный перебор областей, масштабов и фильтров.

import { scale, applyFilter } from './imgproc.js';
import { loadDmtx, dmtxDecodeGray } from './dmtx.js';
import { decodePhoto } from './photo.js';

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
  const { type = 'frame', id, gray, w, h, budgetMs } = e.data;
  try {
    await loadDmtx();
    if (type === 'photo') {
      let last = 0;
      const r = await decodePhoto(new Uint8Array(gray), w, h, {
        budgetMs,
        onProgress: (n) => {
          const now = Date.now();
          if (now - last > 200) { last = now; self.postMessage({ type: 'progress', id, n }); }
        },
      });
      self.postMessage({ type: 'photo', id, text: r?.text || null, tries: r?.tries });
      return;
    }
    const p = PASSES[pass++ % PASSES.length];
    const sc = scale(new Uint8Array(gray), w, h, Math.min(1, p.size / Math.max(w, h)));
    const f = applyFilter(sc, p.filter);
    const text = await dmtxDecodeGray(f.data, f.w, f.h, { timeoutMs: 150 });
    self.postMessage({ type: 'frame', id, text });
  } catch (err) {
    self.postMessage({ type, id, text: null, error: String(err?.message || err) });
  }
};
