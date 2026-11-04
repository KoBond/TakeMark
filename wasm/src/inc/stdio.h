#pragma once
#include <stddef.h>
typedef struct FILE FILE;
#define stdout ((FILE *)0)
#define stderr ((FILE *)0)
static inline int fprintf(FILE *f, const char *fmt, ...) { (void)f; (void)fmt; return 0; }
static inline int snprintf(char *s, size_t n, const char *fmt, ...) { (void)fmt; if (n) s[0] = 0; return 0; }
static inline int sprintf(char *s, const char *fmt, ...) { (void)fmt; s[0] = 0; return 0; }
static inline void perror(const char *s) { (void)s; }
static inline int fputc(int c, FILE *f) { (void)f; return c; }
