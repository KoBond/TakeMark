// Обработка изображений в оттенках серого (Uint8Array, 1 байт на пиксель).
// Нужна для точечных (каплеструйных) кодов на крышках: «склеиваем» точки в модули.

export function rgbaToGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    g[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return g;
}

/** Минимум в окне k×k (k нечётное): тёмные точки расширяются и сливаются. */
export function minFilter(src, w, h, k = 3) {
  const r = k >> 1;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 255;
      const x0 = x - r < 0 ? 0 : x - r, x1 = x + r >= w ? w - 1 : x + r;
      for (let i = x0; i <= x1; i++) { const v = src[row + i]; if (v < m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = y - r < 0 ? 0 : y - r, y1 = y + r >= h ? h - 1 : y + r;
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let j = y0; j <= y1; j++) { const v = tmp[j * w + x]; if (v < m) m = v; }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Размытие box 3×3 (повторить n раз ≈ гаусс). */
export function boxBlur(src, w, h, n = 1) {
  let a = src;
  for (let p = 0; p < n; p++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let j = -1; j <= 1; j++) {
          const yy = y + j; if (yy < 0 || yy >= h) continue;
          for (let i = -1; i <= 1; i++) {
            const xx = x + i; if (xx < 0 || xx >= w) continue;
            s += a[yy * w + xx]; c++;
          }
        }
        out[y * w + x] = (s / c) | 0;
      }
    }
    a = out;
  }
  return a;
}

/** Масштабирование (билинейное). */
export function resize(src, w, h, nw, nh) {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  const out = new Uint8Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, (y + 0.5) * sy - 0.5), y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), dy = Math.max(0, fy - y0);
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1, (x + 0.5) * sx - 0.5), x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(w - 1, x0 + 1), dx = Math.max(0, fx - x0);
      const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1];
      out[y * nw + x] = (a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy) | 0;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** При уменьшении больше чем в 2 раза — сначала усредняем, чтобы не терять точки. */
export function scale(src, w, h, f) {
  let cur = { data: src, w, h };
  while (f < 0.5) {
    const nw = cur.w >> 1, nh = cur.h >> 1, out = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = 2 * y * cur.w + 2 * x;
      out[y * nw + x] = (cur.data[i] + cur.data[i + 1] + cur.data[i + cur.w] + cur.data[i + cur.w + 1]) >> 2;
    }
    cur = { data: out, w: nw, h: nh };
    f *= 2;
  }
  return f === 1 ? cur : resize(cur.data, cur.w, cur.h, cur.w * f, cur.h * f);
}

export function crop(src, w, h, x, y, cw, ch) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  cw = Math.min(w - x, Math.round(cw)); ch = Math.min(h - y, Math.round(ch));
  const out = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) out.set(src.subarray((y + j) * w + x, (y + j) * w + x + cw), j * cw);
  return { data: out, w: cw, h: ch };
}

/** Применить фильтр: 'plain' | 'blur' | 'min3' | 'min5'. */
export function applyFilter(img, name) {
  if (name === 'blur') return { ...img, data: boxBlur(img.data, img.w, img.h, 2) };
  if (name === 'min3') return { ...img, data: minFilter(img.data, img.w, img.h, 3) };
  if (name === 'min5') return { ...img, data: minFilter(img.data, img.w, img.h, 5) };
  return img;
}
