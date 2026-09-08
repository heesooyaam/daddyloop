import type { Key } from 'ink';
import { graphemes, safeText, width } from './text.js';
export interface Editor {
  text: string;
  cursor: number;
  literal?: boolean;
}
export const emptyEditor = (): Editor => ({ text: '', cursor: 0 });
export function insert(editor: Editor, value: string): Editor {
  const parts = graphemes(editor.text),
    added = graphemes(safeText(value).replaceAll('\t', '  '));
  const available = Math.max(0, 10000 - parts.length);
  added.splice(available);
  parts.splice(editor.cursor, 0, ...added);
  return { ...editor, text: parts.join(''), cursor: editor.cursor + added.length };
}
export function edit(editor: Editor, input: string, key: Partial<Key>): Editor {
  const parts = graphemes(editor.text);
  let cursor = Math.min(editor.cursor, parts.length);
  const lineStart = cursor === 0 ? 0 : parts.lastIndexOf('\n', cursor - 1) + 1;
  const end = parts.indexOf('\n', cursor),
    lineEnd = end === -1 ? parts.length : end;
  if (key.home || (key.ctrl && input === 'a')) cursor = lineStart;
  else if (key.end || (key.ctrl && input === 'e')) cursor = lineEnd;
  else if (key.leftArrow || (key.ctrl && input === 'b')) cursor = Math.max(0, cursor - 1);
  else if (key.rightArrow || (key.ctrl && input === 'f'))
    cursor = Math.min(parts.length, cursor + 1);
  else if (key.backspace) {
    if (cursor > 0) parts.splice(--cursor, 1);
  } else if (key.delete) parts.splice(cursor, 1);
  else if (key.ctrl && input === 'u') {
    parts.splice(lineStart, cursor - lineStart);
    cursor = lineStart;
  } else if (key.ctrl && input === 'k') parts.splice(cursor, lineEnd - cursor);
  else if (key.ctrl && input === 'w') {
    let start = cursor;
    while (start > 0 && /\s/.test(parts[start - 1])) start--;
    while (start > 0 && !/\s/.test(parts[start - 1])) start--;
    parts.splice(start, cursor - start);
    cursor = start;
  } else if (key.upArrow && lineStart > 0) {
    const previous = parts.lastIndexOf('\n', lineStart - 2) + 1;
    cursor = Math.min(lineStart - 1, previous + cursor - lineStart);
  } else if (key.downArrow && lineEnd < parts.length) {
    const next = parts.indexOf('\n', lineEnd + 1);
    cursor = Math.min(next === -1 ? parts.length : next, lineEnd + 1 + cursor - lineStart);
  } else if ((key.return && (key.shift || key.meta)) || (key.ctrl && input === 'j'))
    return insert(editor, '\n');
  else if (!key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && input)
    return insert(editor, input);
  return {
    ...editor,
    text: parts.join(''),
    cursor,
    literal: parts.length ? editor.literal : false,
  };
}
export function editorRows(editor: Editor, columns: number) {
  const rows: { before: string; cursor?: string; after: string }[] = [{ before: '', after: '' }];
  const parts = graphemes(editor.text);
  let current = rows[0],
    used = 0,
    afterCursor = false;
  for (let i = 0; i <= parts.length; i++) {
    if (i === parts.length && i !== editor.cursor) break;
    const part = parts[i] ?? ' ';
    if (used + width(part) > Math.max(1, columns)) {
      current = { before: '', after: '' };
      rows.push(current);
      used = 0;
      afterCursor = false;
    }
    if (i === editor.cursor) {
      current.cursor = part === '\n' ? ' ' : part;
      afterCursor = true;
    } else if (i < parts.length && part !== '\n') current[afterCursor ? 'after' : 'before'] += part;
    used += width(part);
    if (part === '\n') {
      current = { before: '', after: '' };
      rows.push(current);
      used = 0;
      afterCursor = false;
    }
  }
  const cursorRow = rows.findIndex((row) => row.cursor !== undefined);
  return { rows, cursorRow };
}
