import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, Definition } from 'mdast';
import stringWidth from 'string-width';

type Style = 'bold' | 'italic' | 'strikethrough';
export interface TextEntity {
  type: Style | 'code' | 'pre' | 'text_link' | 'blockquote';
  offset: number;
  length: number;
  url?: string;
  language?: string;
}
export interface FormattedText {
  text: string;
  entities: TextEntity[];
}
export interface TelegramButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export interface TelegramCard extends FormattedText {
  buttons?: TelegramButton[][];
}

export function safeLink(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      value.length <= 2048
      ? url.href
      : undefined;
  } catch {
    return;
  }
}
/** Explicit entities keep user text literal: there are no HTML tags to escape. */
export class TelegramText implements FormattedText {
  text = '';
  entities: TextEntity[] = [];
  add(text: string, type?: TextEntity['type'], extra: Pick<TextEntity, 'url' | 'language'> = {}) {
    const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '�');
    if (type && clean.length)
      this.entities.push({ type, offset: this.text.length, length: clean.length, ...extra });
    this.text += clean;
    return this;
  }
  append(value: FormattedText) {
    const offset = this.text.length;
    this.text += value.text;
    this.entities.push(
      ...value.entities.map((entity) => ({ ...entity, offset: offset + entity.offset })),
    );
    return this;
  }
  markdown(text: string) {
    return this.append(markdownText(text));
  }
}
const plain = (node: Nodes): string =>
  'value' in node
    ? node.value
    : node.type === 'image' || node.type === 'imageReference'
      ? (node.alt ?? '')
      : 'children' in node
        ? node.children.map((child) => plain(child)).join('')
        : '';

export function markdownText(source: string): FormattedText {
  try {
    return renderMarkdown(source);
  } catch {
    return new TelegramText().add(source);
  }
}
function renderMarkdown(source: string): FormattedText {
  const root = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, Definition>();
  const collect = (node: Nodes) => {
    if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node);
    if ('children' in node) for (const child of node.children) collect(child);
  };
  collect(root);
  const output = new TelegramText();
  const write = (text: string, styles: Style[]) => {
    const offset = output.text.length;
    output.add(text);
    for (const type of new Set(styles))
      if (output.text.length > offset)
        output.entities.push({ type, offset, length: output.text.length - offset });
  };
  const render = (node: Nodes, styles: Style[] = [], depth = 0) => {
    if (depth > 40) {
      write(plain(node), styles);
      return;
    }
    const children = (extra = styles) => {
      if ('children' in node) for (const child of node.children) render(child, extra, depth + 1);
    };
    switch (node.type) {
      case 'root': {
        const blocks = node.children.filter((child) => child.type !== 'definition');
        blocks.forEach((child, i) => {
          if (i) output.add('\n\n');
          render(child, styles, depth + 1);
        });
        return;
      }
      case 'text':
        write(node.value, styles);
        return;
      case 'paragraph':
        children();
        return;
      case 'heading':
        children([...styles, 'bold']);
        return;
      case 'strong':
        children([...styles, 'bold']);
        return;
      case 'emphasis':
        children([...styles, 'italic']);
        return;
      case 'delete':
        children([...styles, 'strikethrough']);
        return;
      case 'inlineCode':
        output.add(node.value, 'code');
        return;
      case 'code':
        output.add(
          node.value || ' ',
          'pre',
          node.lang && /^[A-Za-z0-9_+-]{1,40}$/.test(node.lang) ? { language: node.lang } : {},
        );
        return;
      case 'break':
        output.add('\n');
        return;
      case 'thematicBreak':
        output.add('──────────');
        return;
      case 'html':
        write(node.value, styles);
        return;
      case 'link':
      case 'linkReference':
      case 'image':
      case 'imageReference': {
        const target =
          'url' in node ? node.url : definitions.get(node.identifier.toUpperCase())?.url;
        const url = target && safeLink(target),
          label = plain(node) || target || '';
        const offset = output.text.length;
        write(label, styles);
        if (url && output.text.length > offset)
          output.entities.push({
            type: 'text_link',
            url,
            offset,
            length: output.text.length - offset,
          });
        else if (target && target !== label) write(` (${target})`, styles);
        return;
      }
      case 'blockquote': {
        // A visible quote prefix allows code and links inside quotes without
        // Telegram's restrictions on nested structural entities.
        node.children.forEach((child, i) => {
          if (i) output.add('\n');
          output.add('▎ ');
          render(child, styles, depth + 1);
        });
        return;
      }
      case 'list':
        node.children.forEach((child, i) => {
          if (i) output.add('\n');
          output.add(
            typeof child.checked === 'boolean'
              ? child.checked
                ? '☑ '
                : '☐ '
              : node.ordered
                ? `${(node.start ?? 1) + i}. `
                : '• ',
          );
          child.children.forEach((part, j) => {
            if (j) output.add('\n  ');
            render(part, styles, depth + 1);
          });
        });
        return;
      case 'table': {
        const rows = node.children.map((row) =>
          row.children.map((cell) => plain(cell).replaceAll('\n', ' ')),
        );
        const widths = rows[0].map((_, i) =>
          Math.max(...rows.map((row) => stringWidth(row[i] ?? ''))),
        );
        const lines = rows.map((row) =>
          row
            .map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i] - stringWidth(cell))))
            .join(' │ '),
        );
        lines.splice(1, 0, widths.map((width) => '─'.repeat(width)).join('─┼─'));
        output.add(lines.join('\n'), 'pre');
        return;
      }
      case 'footnoteReference':
        write(`[${node.label ?? node.identifier}]`, styles);
        return;
      case 'footnoteDefinition':
        output.add(`[${node.label ?? node.identifier}] `);
        children();
        return;
      case 'definition':
        return;
      default:
        children();
    }
  };
  render(root);
  return output;
}

/** Offsets are UTF-16, as required by Telegram. Text is never truncated. */
export function splitTelegramText(value: FormattedText, limit = 3800): FormattedText[] {
  if (limit < 16 || limit > 4096) throw new Error('Invalid Telegram text limit');
  const boundaries: number[] = [];
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.text))
    boundaries.push(part.index);
  boundaries.push(value.text.length);
  const boundary = (end: number) => {
    let low = 0,
      high = boundaries.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (boundaries[mid] <= end) low = mid;
      else high = mid - 1;
    }
    return boundaries[low];
  };
  const chunks: FormattedText[] = [];
  for (let start = 0; start < value.text.length;) {
    let end = boundary(Math.min(start + limit, value.text.length));
    if (end <= start) {
      // Pathological combining sequences can exceed a whole message. Preserve
      // all code points even when that one grapheme cannot fit intact.
      end = Math.min(start + limit, value.text.length);
      if (/[\uD800-\uDBFF]/.test(value.text[end - 1])) end--;
    }
    if (end < value.text.length) {
      const newline = value.text.lastIndexOf('\n', end - 1) + 1;
      if (newline > start + limit / 2) end = boundary(newline);
    }
    const candidates = value.entities
      .filter(
        (entity) =>
          entity.length > 0 && entity.offset < end && entity.offset + entity.length > start,
      )
      .sort((a, b) => a.offset - b.offset || b.length - a.length);
    if (candidates.length > 90 && candidates[90].offset > start)
      end = boundary(candidates[90].offset);
    const entities = candidates.flatMap((entity) => {
      const offset = Math.max(start, entity.offset),
        last = Math.min(end, entity.offset + entity.length);
      return last > offset ? [{ ...entity, offset: offset - start, length: last - offset }] : [];
    });
    chunks.push({ text: value.text.slice(start, end), entities });
    start = end;
  }
  return chunks.length ? chunks : [{ text: '…', entities: [] }];
}
