import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text: string) =>
  Array.from(segmenter.segment(text), (part) => part.segment);
export const width = stringWidth;
// Remote comments and agent text are data, never terminal control sequences.
export function safeText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export const oneLine = (value: unknown) => safeText(value).replace(/\s+/g, ' ').trim();
export function clip(text: unknown, columns: number): string {
  const value = safeText(text).replaceAll('\n', ' ').replaceAll('\t', '  ');
  if (columns <= 0) return '';
  if (width(value) <= columns) return value;
  let result = '';
  for (const part of graphemes(value)) {
    if (width(result + part) > columns - 1) break;
    result += part;
  }
  return result + '…';
}
export interface Row {
  text: string;
  kind?: 'heading' | 'muted' | 'code' | 'user' | 'author' | 'accent' | 'warning';
}
export function wrap(text: string, columns: number): string[] {
  const result: string[] = [];
  const limit = Math.max(1, columns);
  for (const line of safeText(text).replaceAll('\t', '  ').split('\n')) {
    let current = '';
    for (const word of line.split(/( +)/)) {
      if (width(word) <= limit) {
        if (width(current + word) > limit) {
          result.push(current.trimEnd());
          current = word.trimStart();
        } else current += word;
      } else
        for (const part of graphemes(word)) {
          if (width(current + part) > limit) {
            result.push(current.trimEnd());
            current = '';
          }
          current += width(part) > limit ? '?' : part;
        }
    }
    result.push(current);
  }
  return result;
}
export function markdown(text: string, columns: number): Row[] {
  let code = false;
  const rows: Row[] = [];
  const limited = safeText(text).slice(0, 50000);
  for (const line of limited.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      code = !code;
      rows.push({
        text: code ? `┌ ${oneLine(line.trimStart().slice(3)) || 'code'}` : '└',
        kind: 'muted',
      });
      continue;
    }
    const heading = /^#{1,6}\s+/.test(line);
    const plain = code
      ? line
      : line
          .replace(/^#{1,6}\s+/, '')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/^[-*]\s/, '• ');
    for (const part of wrap(plain, Math.max(1, columns - (code ? 2 : 0))))
      rows.push({
        text: code ? '  ' + part : part,
        kind: code ? 'code' : heading ? 'heading' : undefined,
      });
  }
  if (limited.length < safeText(text).length)
    rows.push({ text: '… Full message is available in the web panel.', kind: 'muted' });
  return rows;
}
