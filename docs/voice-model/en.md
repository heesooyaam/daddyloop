[English](en.md) · [Русский](ru.md) · [All guides](../index/en.md)

# Speech model attribution

The release uses the quantized **Whisper Small** ONNX export from `onnx-community/whisper-small`, revision `36050c46d777d46dc4b5f43f6d90574fc38f8732`. The exact files, sizes and SHA-256 digests are pinned in `scripts/speech-model.json` and verified by `scripts/prepare-speech.mjs`.

The model files total approximately 240 MiB. Runtime inference uses the CPU through Transformers.js and ONNX Runtime. Telegram OGG/Opus decoding is local. Model downloads happen during release/source preparation, not for each voice message.

The model export identifies Apache-2.0 licensing. The [original license text](../licenses/Apache-2.0.txt) is retained verbatim. Dependency packages carry their own license notices. See [voice usage](../voice/en.md) for limits and recognition behavior.
