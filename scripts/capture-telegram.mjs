// Illustrative Telegram cards rendered from the application's entity formatter.
// No connection to Telegram and no real account/task data.
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TelegramText } from '../dist/server/integrations/telegram-text.js';
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function formatted(card) {
  let html = '',
    at = 0;
  for (const entity of [...card.entities].sort((a, b) => a.offset - b.offset)) {
    html += escape(card.text.slice(at, entity.offset));
    const tag = entity.type === 'bold' ? 'b' : entity.type === 'code' ? 'code' : 'span';
    html += `<${tag}>${escape(card.text.slice(entity.offset, entity.offset + entity.length))}</${tag}>`;
    at = entity.offset + entity.length;
  }
  return html + escape(card.text.slice(at));
}
const font = (
  await readFile('node_modules/@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2')
).toString('base64');
const latin = (
  await readFile('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')
).toString('base64');
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
try {
  for (const locale of ['en', 'ru']) {
    const ru = locale === 'ru';
    const title = ru ? 'Платежи без повторов' : 'Payments without duplicates';
    const response = new TelegramText()
      .add(ru ? 'Беру на себя. Папочка разберётся.' : 'Leave it with daddy. I’ve got this.', 'bold')
      .add(ru ? '\n\nРаздал работу:\n' : '\n\nThe crew has its orders:\n')
      .add(ru ? '01  API и тесты' : '01  API and tests', 'bold')
      .add(ru ? ' — одному воркеру.\n' : ' — one worker.\n')
      .add(ru ? '02  Документация' : '02  Documentation', 'bold')
      .add(
        ru
          ? ' — второму, параллельно.\n\nПроверю результат сам. Тебе напишу, когда будет что показать.'
          : ' — a second, in parallel.\n\nI’ll check the result myself. You’ll hear from me when there’s something to show.',
      );
    const followup = new TelegramText()
      .add(
        ru ? 'Учёл. Потерянный ответ тоже проверим.' : 'Added. We’ll test lost responses too.',
        'bold',
      )
      .add(
        ru
          ? '\nПапочка уже передал это воркеру. Второе списание не проскочит незамеченным.'
          : '\nThe worker has the instruction. A second charge won’t slip past the review.',
      );
    const page = await browser.newPage({
      viewport: { width: 1120, height: 900 },
      deviceScaleFactor: 1.5,
    });
    await page.setContent(`<!doctype html><html lang="${locale}"><meta charset="utf-8"><style>
      @font-face{font-family:Inter;src:url(data:font/woff2;base64,${font});font-weight:100 900;unicode-range:U+0400-052F}@font-face{font-family:Inter;src:url(data:font/woff2;base64,${latin});font-weight:100 900;unicode-range:U+0000-024F}*{box-sizing:border-box}body{margin:0;font-family:Inter,sans-serif;background:#eef5f2;color:#1e303b;padding:26px}.app{display:flex;background:#fff;border:1px solid #cbdcd5;border-radius:20px;overflow:hidden;box-shadow:0 18px 60px #1e4a3720;height:810px}.topics{width:265px;background:#fff;border-right:1px solid #dce5e1;flex-shrink:0}.brand{padding:26px 22px;font-size:24px;font-weight:750}.brand small{display:block;font-size:12px;color:#71827b;font-weight:400;margin-top:7px}.topic{padding:18px 22px;border-top:1px solid #f1f5f3;font-size:15px}.topic strong{display:block;margin-bottom:7px}.topic small{color:#738079}.topic.active{background:#e1f4e9;border-left:4px solid #399c76;padding-left:18px}.screen{flex:1;min-width:0;display:flex;flex-direction:column}.header{height:79px;display:flex;gap:12px;align-items:center;padding:18px 25px;border-bottom:1px solid #dce5e1}.avatar{background:#4dab88;color:white;border-radius:50%;width:42px;height:42px;display:grid;place-content:center;font-size:25px;font-weight:bold}.header b{display:block}.header small{font-size:12px;color:#738b7d}.chat{flex:1;padding:18px 32px;display:flex;flex-direction:column;gap:13px;background-color:#eaf3ec;background-image:radial-gradient(#afcab32d 1px,transparent 1px);background-size:18px 18px}.day{align-self:center;font-size:11px;color:#517864;padding:5px 13px;border-radius:20px;background:#dceade}.bubble{max-width:565px;padding:13px 17px;border-radius:14px;background:white;box-shadow:0 1px 2px #25453614;font-size:14px;line-height:1.45;white-space:pre-wrap}.bubble.user{background:#d4f2d3;align-self:flex-end;max-width:515px}.bubble .who{display:block;font-size:12px;color:#248164;font-weight:bold;margin-bottom:7px}.time{display:block;text-align:right;font-size:10px;color:#7d948a;margin-top:4px}.buttons{display:flex;gap:5px;max-width:565px;margin-top:-9px}.buttons span{background:#fff9;flex:1;padding:9px 12px;font-size:12px;border-radius:7px;text-align:center;color:#286c53}.compose{height:58px;padding:19px 28px;color:#99a69f;background:white;font-size:14px}.footer{font-size:11px;color:#71887b;margin:12px 4px}
    </style><div class="app"><aside class="topics"><div class="brand">daddy works<small>${ru ? 'Папочка и его дела' : 'daddy and his jobs'}</small></div><div class="topic active"><strong>◉ ${title}</strong><small>daddy · ${ru ? 'бригада: 2 / 3' : 'crew: 2 / 3'}</small></div><div class="topic"><strong>◈ ${ru ? 'Поиск в приложении' : 'App search'}</strong><small>${ru ? 'Готово · ждёт тебя' : 'Done · ready for you'}</small></div><div class="topic"><strong>+ ${ru ? 'Ещё дело для папочки' : 'Another job for daddy'}</strong><small>/new</small></div></aside><main class="screen"><div class="header"><span class="avatar">d.</span><div><b>${title}</b><small>${ru ? 'Тема сессии · daddy-ops' : 'Session topic · daddy-ops'}</small></div></div><div class="chat"><span class="day">${ru ? 'Сегодня' : 'Today'}</span><div class="bubble user">${ru ? 'Бро, почини повторы платежей. Вот тикет, там всё описано. И доку обнови, плиз.' : 'Fix repeated payments, please. The ticket has the details. Update the docs too.'}<span class="time">10:24 ✓✓</span></div><div class="bubble"><span class="who">daddy</span>${formatted(response)}<span class="time">10:24</span></div><div class="buttons"><span>${ru ? 'Задачи' : 'Tasks'}</span><span>${ru ? 'Бригада' : 'Crew'}</span><span>${ru ? 'Лимиты' : 'Limits'}</span></div><div class="bubble user">▶ ▂▃▆▅▂▇▆▃▂▅▇▂▃▆▂▅▂  0:08<span class="time">10:25 ✓✓</span></div><div class="bubble"><span class="who">daddy</span>${formatted(followup)}<span class="time">10:25</span></div></div><div class="compose">${ru ? 'Написать папочке…' : 'Message daddy…'} <span style="float:right;color:#43a77d">🎙</span></div></main></div><div class="footer">${ru ? 'Иллюстрация сценария Telegram. Текст форматирует daddyloop; данные вымышлены.' : 'Illustrative Telegram workflow. Text formatted by daddyloop; fixture data.'}</div>`);
    const output = resolve('docs/media', locale);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'daddy-telegram.png') });
    await page.close();
  }
} finally {
  await browser.close();
}
