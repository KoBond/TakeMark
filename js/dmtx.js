// Второй декодер: libdmtx (BSD-2), собранный в WebAssembly (wasm/dmtx.wasm, ~44 КБ).
// Лучше zxing читает точечные (DPM / каплеструйные) коды на крышках и флаконах.

let instPromise = null;

export function loadDmtx(url = new URL('../wasm/dmtx.wasm', import.meta.url)) {
  if (instPromise) return instPromise;
  const imports = {
    env: {
      js_sin: Math.sin, js_cos: Math.cos, js_atan2: Math.atan2, js_acos: Math.acos,
      js_now_ms: () => Date.now(),
    },
  };
  instPromise = (async () => {
    let bytes;
    if (typeof url === 'string' || url instanceof URL) {
      if (typeof fetch === 'function' && !String(url).startsWith('file:')) {
        const r = await fetch(url);
        if (!r.ok) throw new Error('dmtx.wasm: ' + r.status);
        bytes = await r.arrayBuffer();
      } else {
        const fs = await import('fs');
        bytes = fs.readFileSync(url);
      }
    } else bytes = url;
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    return instance.exports;
  })();
  instPromise.catch(() => { instPromise = null; });
  return instPromise;
}

/**
 * gray: Uint8Array (1 байт на пиксель), w×h.
 * Возвращает строку кода (GS = \x1D) или null.
 */
export async function dmtxDecodeGray(gray, w, h, { timeoutMs = 120, shrink = 1 } = {}) {
  const ex = await loadDmtx();
  const ptr = ex.image_buffer(w, h);
  if (!ptr) return null;
  new Uint8Array(ex.memory.buffer, ptr, w * h).set(gray);
  const len = ex.decode(w, h, timeoutMs, shrink);
  if (!len) return null;
  const out = new Uint8Array(ex.memory.buffer, ex.result_ptr(), len);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(out[i]);
  return s;
}
