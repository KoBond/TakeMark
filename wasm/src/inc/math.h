#pragma once
#define sqrt(x) __builtin_sqrt(x)
#define fabs(x) __builtin_fabs(x)
#define floor(x) __builtin_floor(x)
#define ceil(x) __builtin_ceil(x)
double js_sin(double); double js_cos(double); double js_atan2(double, double); double js_acos(double);
#define acos(x) js_acos(x)
#define sin(x) js_sin(x)
#define cos(x) js_cos(x)
#define atan2(y, x) js_atan2(y, x)
#define M_PI 3.14159265358979323846
#define HUGE_VAL __builtin_huge_val()
