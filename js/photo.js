// Распознавание по фотографии: перебор областей, масштабов и фильтров,
// пока один из декодеров (libdmtx / zxing) не прочитает код.

import { scale, crop, applyFilter } from './imgproc.js';
import { dmtxDecodeGray } from './dmtx.js';
import { parseCode } from './gs1.js';

const FILTERS = ['plain', 'blur', 'min3', 'min5'];
const TARGETS = [420, 600, 300, 900]; // длинная сторона области после масштабирования, px
const MAX_SIDE = 1600; // фото уменьшается до этой длинной стороны перед перебором

function regions(w, h) {
  const s = Math.min(w, h), out = [];
  out.push({ name: 'full', x: 0, y: 0, w, h });
  for (const f of [0.7, 0.5]) out.push({ name: 'center' + f, x: (w - s * f) / 2, y: (h - s * f) / 2, w: s * f, h: s * f });
  // перекрывающиеся окна 3×3 — если код не в центре кадра
  const t = s * 0.5;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    out.push({ name: `tile${i}${j}`, x: (w - t) * i / 2, y: (h - t) * j / 2, w: t, h: t });
  }
  return out;
}

/**
 * gray — Uint8Array w×h. zxingRead(imageData) — необязательная функция декодера zxing.
 * Возвращает { text, attempt, ms } или null.
 */
export async function decodePhoto(gray, w, h, { zxingRead = null, budgetMs = 10000, onProgress } = {}) {
  const t0 = Date.now();
  if (Math.max(w, h) > MAX_SIDE) {
    const s = scale(gray, w, h, MAX_SIDE / Math.max(w, h));
    gray = s.data; w = s.w; h = s.h;
  }
  let n = 0;
  for (const reg of regions(w, h)) {
    const area = crop(gray, w, h, reg.x, reg.y, reg.w, reg.h);
    for (const target of TARGETS) {
      const f = target / Math.max(area.w, area.h);
      if (f > 2.5) continue;
      const scaled = scale(area.data, area.w, area.h, Math.min(f, 2.5));
      for (const filter of FILTERS) {
        if (Date.now() - t0 > budgetMs) return null;
        const img = applyFilter(scaled, filter);
        n++;
        onProgress?.(n);
        let text = await dmtxDecodeGray(img.data, img.w, img.h, { timeoutMs: 300 });
        if (!text && zxingRead && filter !== 'min5') {
          const rgba = new Uint8ClampedArray(img.w * img.h * 4);
          for (let i = 0; i < img.data.length; i++) { const v = img.data[i]; rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = v; rgba[4 * i + 3] = 255; }
          const texts = await zxingRead(new ImageData(rgba, img.w, img.h));
          text = texts.find(t => parseCode(t).ok) || null;
        }
        if (text && parseCode(text).ok) {
          return { text, attempt: `${reg.name}/${target}/${filter}`, tries: n, ms: Date.now() - t0 };
        }
        // дать браузеру перерисовать индикатор
        if (n % 4 === 0) await new Promise(r => setTimeout(r, 0));
      }
    }
  }
  return null;
}
