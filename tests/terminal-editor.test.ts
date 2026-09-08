import { it, expect } from 'vitest';
import { edit, emptyEditor, insert, editorRows } from '../src/terminal/editor.js';
import { safeText, width, wrap } from '../src/terminal/text.js';
it('edits Cyrillic and emoji as graphemes without damaging the next character', () => {
  let editor = insert(emptyEditor(), 'Привет 👨‍👩‍👧‍👦!');
  editor = edit(editor, '', { leftArrow: true });
  editor = edit(editor, '', { backspace: true });
  expect(editor.text).toBe('Привет !');
  editor = insert(editor, '🙂');
  expect(editor.text).toBe('Привет 🙂!');
});
it('keeps cursor movement inside the right logical line and preserves newlines', () => {
  let editor = insert(emptyEditor(), 'first\nsecond');
  editor = edit(editor, 'a', { ctrl: true });
  expect(editor.cursor).toBe(6);
  editor = edit(editor, '', { upArrow: true });
  expect(editor.cursor).toBe(0);
  expect(edit(editor, '', { home: true }).cursor).toBe(0);
  expect(edit(editor, 'j', { ctrl: true }).text).toBe('\nfirst\nsecond');
});
it('renders a visible cursor at wrapped and multiline boundaries within terminal width', () => {
  for (const text of ['abcd', 'абвг🙂', 'a\nb', '🙂🙂']) {
    const editor = insert(emptyEditor(), text),
      result = editorRows(editor, 4);
    expect(result.cursorRow).toBeGreaterThanOrEqual(0);
    for (const row of result.rows)
      expect(width(row.before + (row.cursor ?? '') + row.after)).toBeLessThanOrEqual(4);
  }
});
it('strips terminal commands from remote text and keeps Markdown content readable', () => {
  expect(safeText('hello\x1b]52;c;c2VjcmV0\x07\x1b[2Jworld\r\nnext')).toBe('helloworld\nnext');
  expect(wrap('A reviewer checks the revision.', 16)).toEqual([
    'A reviewer',
    'checks the',
    'revision.',
  ]);
});
