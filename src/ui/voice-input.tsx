import { useEffect, useRef, useState } from 'react';
import { Mic, Square, LoaderCircle, X } from 'lucide-react';
import { useLocale } from './i18n.js';

async function wavForRecognition(blob: Blob) {
  const context = new OfflineAudioContext(1, 1, 16000);
  const pcm = await context.decodeAudioData(await blob.arrayBuffer());
  const length = Math.min(pcm.length, 16000 * 300);
  const bytes = new ArrayBuffer(44 + 2 * length),
    view = new DataView(bytes);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, 2 * length, true);
  const channels = Array.from({ length: pcm.numberOfChannels }, (_, index) =>
    pcm.getChannelData(index),
  );
  for (let i = 0; i < length; i++) {
    let sample = 0;
    for (const channel of channels) sample += channel[i];
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(44 + 2 * i, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

type Recording = {
  abort: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
};
function release(rec: Recording) {
  clearTimeout(rec.timer);
  for (const track of rec.stream?.getTracks() ?? []) track.stop();
}

export function VoiceInput({
  onText,
  disabled = false,
  onBusy,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useLocale();
  const [phase, setPhase] = useState<'idle' | 'permission' | 'recording' | 'recognizing'>('idle'),
    [error, setError] = useState('');
  useEffect(() => {
    onBusy(phase !== 'idle');
    return () => onBusy(false);
  }, [phase, onBusy]);
  const current = useRef<Recording | undefined>(undefined);
  const deliver = useRef(onText);
  deliver.current = onText;
  function cancel() {
    const rec = current.current;
    if (rec) {
      current.current = undefined;
      rec.abort.abort();
      if (rec.recorder?.state === 'recording') rec.recorder.stop();
      release(rec);
    }
  }
  useEffect(() => {
    if (disabled) {
      cancel();
      setPhase('idle');
    }
    return cancel;
  }, [disabled]);
  async function start() {
    if (current.current) return;
    setError('');
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined' ||
      typeof OfflineAudioContext === 'undefined'
    ) {
      setError(
        'Open daddy over HTTPS or localhost in a browser that supports microphone recording.',
      );
      return;
    }
    const rec: Recording = { abort: new AbortController() };
    current.current = rec;
    setPhase('permission');
    const done = (message?: string) => {
      release(rec);
      if (current.current !== rec) return;
      current.current = undefined;
      setPhase('idle');
      if (message) setError(message);
    };
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      if (current.current !== rec) {
        release(rec);
        return;
      }
      const recorder = new MediaRecorder(rec.stream);
      rec.recorder = recorder;
      const chunks: Blob[] = [];
      let size = 0;
      recorder.ondataavailable = (e) => {
        if (current.current !== rec) return;
        size += e.data.size;
        if (size > 10 * 1024 * 1024) {
          done('Voice messages can be at most 5 minutes and 10 MB.');
          return;
        }
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onerror = () => done('Could not record from the microphone.');
      recorder.onstop = async () => {
        release(rec);
        if (current.current !== rec) return;
        setPhase('recognizing');
        try {
          const wav = await wavForRecognition(new Blob(chunks, { type: recorder.mimeType }));
          rec.abort.signal.throwIfAborted();
          const response = await fetch('/api/voice/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav', 'X-daddyloop-Request': '1' },
            body: wav,
            signal: rec.abort.signal,
          });
          const body = await response.json();
          if (!response.ok || typeof body.text !== 'string' || !body.text.trim())
            throw new Error(body.error?.message || 'Voice recognition failed');
          if (current.current === rec) deliver.current(body.text.trim());
          done();
        } catch (e) {
          done(e instanceof Error ? e.message : 'Voice recognition failed');
        }
      };
      recorder.start(1000);
      setPhase('recording');
      rec.timer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 300000);
    } catch (e) {
      done(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Allow microphone access in your browser.'
          : 'Could not record from the microphone.',
      );
    }
  }
  const label = t(
    phase === 'recording'
      ? 'Stop recording and transcribe'
      : phase === 'recognizing'
        ? 'Transcribing voice…'
        : phase === 'permission'
          ? 'Waiting for microphone permission'
          : 'Dictate message',
  );
  return (
    <span className="daddy-voice-control">
      <button
        type="button"
        className="daddy-text-button"
        title={label}
        aria-label={label}
        disabled={disabled || phase === 'recognizing' || phase === 'permission'}
        onClick={() => {
          if (phase === 'recording') {
            if (current.current?.recorder?.state === 'recording') current.current.recorder.stop();
          } else void start();
        }}
      >
        {phase === 'recording' ? (
          <Square size={17} />
        ) : phase === 'recognizing' || phase === 'permission' ? (
          <LoaderCircle size={17} />
        ) : (
          <Mic size={17} />
        )}
      </button>
      {phase !== 'idle' && (
        <>
          <small role="status">
            {t(
              phase === 'recording'
                ? 'Recording…'
                : phase === 'permission'
                  ? 'Waiting for microphone permission'
                  : 'Transcribing voice…',
            )}
          </small>
          <button
            type="button"
            className="daddy-text-button"
            aria-label={t('Cancel voice input')}
            onClick={() => {
              cancel();
              setPhase('idle');
            }}
          >
            <X size={16} />
          </button>
        </>
      )}
      {error && <small role="alert">{t(error)}</small>}
    </span>
  );
}

export function appendDictation(draft: string, text: string) {
  const result = draft ? draft.replace(/\s+$/, '') + ' ' + text : text;
  if (result.length > 20000)
    throw new Error('The transcript would exceed the 20,000 character limit.');
  return result;
}
