#!/bin/sh
# Сборка wasm/dmtx.wasm из исходников libdmtx (BSD-2, https://github.com/dmtx/libdmtx).
# Нужны clang и wasm-ld (LLVM 15+). Emscripten не нужен: минимальная libc — в shim.c и inc/.
set -e
cd "$(dirname "$0")"
[ -d libdmtx ] || git clone --depth 1 https://github.com/dmtx/libdmtx.git
clang --target=wasm32 -O2 -nostdlib -ffreestanding -fno-builtin-malloc \
  -Iinc -Ilibdmtx -DVERSION='"0.7.7"' -DHAVE_SYS_TIME_H \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--export-dynamic -Wl,--strip-all \
  -o ../dmtx.wasm libdmtx/dmtx.c shim.c
ls -la ../dmtx.wasm
