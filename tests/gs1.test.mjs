// Тесты разбора кодов: node tests/gs1.test.mjs
import { parseCode, gtinValid } from '../js/gs1.js';
import { buildText, mailtoUrl, fileName, isEmail } from '../js/export.js';

const GS = '\x1D';
const GTIN = '04601234567893';
const SN = 'Ab3XyZ0Q9w!%_';            // 13 символов, в т.ч. спецсимволы GS1
const CRYPTO = 'dGVzdGNyeXB0b3RhaWxmb3J0YWtlbWFya3Rlc3QxMjM0'.padEnd(44, 'Q'); // 44 символа
const KEY91 = 'EE06';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ', name); }
  else { fail++; console.log('  FAIL ', name, extra); }
}
function expectOk(name, input, gtin = GTIN, sn = SN) {
  const r = parseCode(input);
  check(name, r.ok && r.gtin === gtin && r.sn === sn && r.line === '01' + gtin + '21' + sn, JSON.stringify(r));
}
function expectErr(name, input) {
  const r = parseCode(input);
  check(name, !r.ok, JSON.stringify(r));
}

console.log('GTIN');
check('валидная контрольная цифра', gtinValid(GTIN));
check('невалидная контрольная цифра', !gtinValid('04601234567890'));

console.log('Коды МДЛП');
const full = `01${GTIN}21${SN}${GS}91${KEY91}${GS}92${CRYPTO}`;
expectOk('полный код с GS', full);
expectOk('префикс ]d2', ']d2' + full);
expectOk('ведущий FNC1/GS', GS + full);
expectOk('без GS (слипшийся)', `01${GTIN}21${SN}91${KEY91}92${CRYPTO}`);
expectOk('текстовые <GS>', `01${GTIN}21${SN}<GS>91${KEY91}<GS>92${CRYPTO}`);
expectOk('скобки HRI', `(01)${GTIN}(21)${SN}(91)${KEY91}(92)${CRYPTO}`);
expectOk('только 01+21 (ручной ввод)', `01${GTIN}21${SN}`);
expectOk('с пробелами и переводом строки', `  01${GTIN}21${SN}\n`);
expectOk('с 17 и 10 перед 21', `01${GTIN}17271231` + `10SERIES1${GS}21${SN}${GS}91${KEY91}${GS}92${CRYPTO}`);
expectOk('короткий SN медизделия с GS', `01${GTIN}21ABC123${GS}91${KEY91}${GS}92${CRYPTO}`, GTIN, 'ABC123');
expectOk('короткий криптохвост 93 (медизделия/БАД)', `01${GTIN}21${SN}${GS}93abCD`);
expectOk('93 без GS', `01${GTIN}21${SN}93abCD`);
expectOk('FNC1 как «è»', `01${GTIN}21${SN}è91${KEY91}è92${CRYPTO}`);

console.log('Не коды маркировки');
expectErr('EAN-13', '4601234567893');
expectErr('QR-ссылка', 'https://example.com/?id=1');
expectErr('неверный GTIN', `01046012345678902${'1'}${SN}`);
expectErr('нет серийного номера', `01${GTIN}`);
expectErr('пусто', '   ');

console.log('Выгрузка');
const session = { createdAt: new Date(2026, 10, 4, 9, 5).getTime(), items: [
  { line: `01${GTIN}21${SN}` }, { line: `01${GTIN}21ABC123` }] };
const txt = buildText(session.items);
check('CRLF и без криптохвоста', txt === `01${GTIN}21${SN}\r\n01${GTIN}21ABC123\r\n` && !txt.includes(KEY91));
check('имя файла', fileName(session) === 'marks_2026-11-04_09-05_2.txt', fileName(session));
const m = mailtoUrl('manager@company.ru', session);
check('mailto: адрес', m.startsWith('mailto:manager@company.ru?subject='), m.slice(0, 60));
check('mailto: тело содержит коды', decodeURIComponent(m.split('body=')[1]).includes(`01${GTIN}21ABC123`));
check('валидный email', isEmail('a.b+c@mail.ru'));
check('невалидный email', !isEmail('a@b') && !isEmail('a b@c.ru') && !isEmail(''));

console.log('Версия');
{
  const { readFileSync } = await import('fs');
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const APP_VERSION = sw.match(/const VERSION = 'takemark-([^']+)'/)[1];
  check('sw.js VERSION = takemark-' + APP_VERSION, sw.includes(`const VERSION = 'takemark-${APP_VERSION}'`));
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  check('index.html показывает ' + APP_VERSION, html.includes(`id="app-version">${APP_VERSION} ·`));
  check('index.html: защита кеша для ' + APP_VERSION, html.includes(`var V = 'takemark-${APP_VERSION}'`));
  check('index.html: ?v= у css и js', html.includes(`app.css?v=${APP_VERSION}`) && html.includes(`app.js?v=${APP_VERSION}`));
}

console.log(`\n${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
