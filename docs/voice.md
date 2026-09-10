# Voice messages

Telegram voice notes are converted to text locally on the service host, using the bundled quantized Whisper Small model. Only the transcript is passed to the configured daddy model. Replies are text. No separate speech API key, ffmpeg installation or audio upload to an external ASR provider is required.

Start a session in a workspace first, then send a voice note in that session's Telegram topic or selected private conversation. `/language ru` and `/language en` choose the recognition language as well as the interface language. Standard OGG/Opus notes up to five minutes and 10 MB are supported. Read the displayed transcript and correct recognition mistakes with another message.

The inbox persists the owner, destination, generation, workspace selection and receipt before acknowledging input. One recognition child runs at a time with two inference threads, a bounded JavaScript heap and a three-minute timeout. Audio decoding is incremental with size, duration, channel and silence checks. At least 3.5 GiB available memory is required before recognition starts; existing host resource guards also apply. Interrupted work remains queued; processed audio is deleted. Subsequent text stays ordered behind the voice note, while control commands remain responsive.

A changed connection or session generation rejects late delivery. The recording can be sent again after resuming the intended session. Successful handoff uses the original Telegram receipt, so recovery cannot enqueue the same voice task twice.

## Source installations

Run `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci`, build the app, then `npm run speech:prepare` to obtain the pinned local model. The normal release installer already includes the model and CPU dependencies. Model files have fixed sizes and SHA-256 digests in `scripts/speech-model.json`.

See [model attribution and license](third-party/whisper.md). The package smoke test recognizes a generated English Opus recording without network access. Development also checked a Russian pronunciation recording; synthetic robotic speech exposed recognition limitations, so the larger Small checkpoint was selected over Base. These checks establish integration, not guaranteed transcription accuracy for every recording.
