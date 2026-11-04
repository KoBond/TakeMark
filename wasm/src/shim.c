// Минимальная «libc» для libdmtx в WebAssembly: bump-аллокатор, сбрасываемый после каждого декодирования.
#include <stddef.h>
#include <stdint.h>
#include <sys/time.h>
#include "dmtx.h"

extern unsigned char __heap_base;
static uintptr_t heap_start, heap_top, heap_end;

static void heap_init(void) {
  if (!heap_start) { heap_start = heap_top = ((uintptr_t)&__heap_base + 15) & ~15; heap_end = __builtin_wasm_memory_size(0) * 65536; }
}
void *malloc(size_t n) {
  heap_init();
  n = (n + 15) & ~(size_t)15;
  size_t *hdr; uintptr_t p = heap_top;
  if (p + n + 16 > heap_end) {
    size_t need = (p + n + 16 - heap_end + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, need) == (size_t)-1) return 0;
    heap_end += need * 65536;
  }
  hdr = (size_t *)p; *hdr = n; heap_top = p + 16 + n;
  return (void *)(p + 16);
}
void free(void *p) { (void)p; }
void *memset(void *d, int c, size_t n) { unsigned char *p = d; while (n--) *p++ = (unsigned char)c; return d; }
void *memcpy(void *d, const void *s, size_t n) { unsigned char *a = d; const unsigned char *b = s; while (n--) *a++ = *b++; return d; }
void *memmove(void *d, const void *s, size_t n) {
  unsigned char *a = d; const unsigned char *b = s;
  if (a < b) while (n--) *a++ = *b++; else { a += n; b += n; while (n--) *--a = *--b; }
  return d;
}
int memcmp(const void *x, const void *y, size_t n) { const unsigned char *a = x, *b = y; for (; n; n--, a++, b++) if (*a != *b) return *a - *b; return 0; }
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
void *calloc(size_t a, size_t b) { void *p = malloc(a * b); if (p) memset(p, 0, a * b); return p; }
void *realloc(void *p, size_t n) {
  if (!p) return malloc(n);
  size_t old = *(size_t *)((uintptr_t)p - 16);
  if (n <= old) return p;
  void *q = malloc(n); if (q) memcpy(q, p, old); return q;
}
double js_now_ms(void);
int gettimeofday(struct timeval *tv, void *tz) {
  (void)tz; double ms = js_now_ms(); tv->tv_sec = (time_t)(ms / 1000); tv->tv_usec = (suseconds_t)((ms - tv->tv_sec * 1000.0) * 1000); return 0;
}
time_t time(time_t *t) { time_t s = (time_t)(js_now_ms() / 1000); if (t) *t = s; return s; }

/* ---- API для JS ---- */
static unsigned char *img_buf; static size_t img_cap;
static unsigned char out_buf[4096]; static int out_len;
static uintptr_t mark;

__attribute__((export_name("image_buffer")))
unsigned char *image_buffer(int w, int h) {
  heap_init();
  size_t need = (size_t)w * h;
  if (need > img_cap) { heap_top = heap_start; img_buf = malloc(need); img_cap = img_buf ? need : 0; }
  mark = heap_top;
  return img_buf;
}

/* Ищет и декодирует один символ. Возвращает длину результата (0 — не найдено). shrink: 1 или 2. */
__attribute__((export_name("decode")))
int decode(int w, int h, int timeout_ms, int shrink) {
  out_len = 0;
  heap_top = mark;
  DmtxImage *img = dmtxImageCreate(img_buf, w, h, DmtxPack8bppK);
  if (!img) return 0;
  dmtxImageSetProp(img, DmtxPropImageFlip, DmtxFlipNone);
  DmtxDecode *dec = dmtxDecodeCreate(img, shrink > 0 ? shrink : 1);
  if (dec) {
    DmtxTime t = dmtxTimeAdd(dmtxTimeNow(), timeout_ms);
    DmtxRegion *reg = dmtxRegionFindNext(dec, &t);
    if (reg) {
      DmtxMessage *msg = dmtxDecodeMatrixRegion(dec, reg, DmtxUndefined);
      if (msg && msg->outputIdx > 0 && msg->outputIdx < sizeof(out_buf)) {
        memcpy(out_buf, msg->output, msg->outputIdx); out_len = (int)msg->outputIdx;
      }
    }
  }
  heap_top = mark; /* всё, что выделила библиотека, освобождаем разом */
  return out_len;
}

__attribute__((export_name("result_ptr")))
unsigned char *result_ptr(void) { return out_buf; }
