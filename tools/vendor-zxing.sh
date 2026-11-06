#!/bin/sh
# Кладёт библиотеку распознавания zxing-wasm в ./vendor, чтобы приложение не зависело от CDN.
# Нужны только curl и tar (npm не используется). Запуск из корня репозитория:
#   sh tools/vendor-zxing.sh && git add vendor && git commit -m "vendor zxing-wasm"
set -e
VER="${1:-2.2.4}"   # та же версия, что ZXING_VERSION в js/scanner.js
TMP="$(mktemp -d)"
curl -fsSL "https://registry.npmjs.org/zxing-wasm/-/zxing-wasm-$VER.tgz" -o "$TMP/zx.tgz"
tar -xzf "$TMP/zx.tgz" -C "$TMP" package/dist/iife/reader/index.js package/dist/reader/zxing_reader.wasm
mkdir -p vendor
cp "$TMP/package/dist/iife/reader/index.js" vendor/zxing-reader.js
cp "$TMP/package/dist/reader/zxing_reader.wasm" vendor/zxing_reader.wasm
echo '["zxing-reader.js","zxing_reader.wasm"]' > vendor/files.json
rm -rf "$TMP"
ls -la vendor
