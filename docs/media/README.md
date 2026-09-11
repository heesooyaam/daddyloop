# Product media

The screenshots show the current daddy web and terminal clients connected to isolated fixtures. Model replies, tickets, quotas and updates are illustrative offline data. No private Telegram chats or credentials are included.

Generate browser screenshots with `node scripts/capture-daddy.mjs` after a production build. Generate CLI screenshots with `python3 scripts/capture-daddy-cli.py`; it drives the actual Ink client in a PTY and renders its ANSI output with xterm.js. The capture verifies terminal restoration when the client exits.

Phone screenshots use a 390 × 844 viewport. The automated HTTPS test separately verifies browser pairing and continued access after the laptop client disconnects.
