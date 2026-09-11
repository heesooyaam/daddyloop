[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Voice messages

Send a normal Telegram voice message to the paired bot chat or the topic of a daddy session. In the private chat, select a session first. The recognized text goes to daddy like a typed message.

```text
/language en
/language ru
```

The interface language selects recognition language too. Choose the language you speak. You can correct a mistaken transcript with the next text message.

- Supported input: Telegram OGG/Opus voice messages, up to **5 minutes and 10 MB**.
- Recognition runs locally with the bundled Whisper Small model. No additional API key or ffmpeg is required.
- One recording is processed at a time, with two CPU inference threads and a separate bounded process.
- Recognition waits for at least 3.5 GiB of available memory. Bot controls stay responsive.
- Voice and following text keep their order. Pending recordings survive a restart.
- The destination session/generation is captured at receipt time. A late transcript cannot bypass a pause or a changed binding.
- Raw audio is removed after processing; the transcript remains in the conversation.

Recognition quality depends on the recording. The package tests an offline speech fixture; that is not a guarantee for every accent or noisy recording. For source development prepare the model with `npm run speech:prepare`.

See [model attribution](../voice-model/en.md) and [resources](../operations/en.md).
