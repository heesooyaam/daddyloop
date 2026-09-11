[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Product screenshots

Images in `docs/media/` show the real web and Ink terminal interfaces connected to isolated fixtures. Task replies, quotas and model catalogues in these scenes are illustrative data. They are not private user conversations or evidence of a live provider write.

```bash
npm run build
node scripts/capture-daddy.mjs
```

The script captures desktop, phone, settings and themes. It also starts the actual CLI in a PTY and replays its ANSI output through xterm.js. Terminal modes and the service PID are checked after the client exits. Phone screenshots use a 390 × 844 viewport; the separate browser test verifies HTTPS pairing and laptop-disconnect behavior.

Regenerate screenshots after changing UI copy, layout or colors. Keep old screenshots out of current instructions. Do not capture tokens, real private bot chats or corporate task contents.

The README uses the Mint capture as its main image. `node scripts/capture-telegram.mjs` renders the illustrative Telegram card from `TelegramText` entities and local fonts, without contacting Telegram.
