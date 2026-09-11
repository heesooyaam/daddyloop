import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const walk = (path) =>
  readdirSync(path, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? walk(join(path, item.name)) : [join(path, item.name)],
  );
const docs = walk(join(root, 'docs')).filter((path) => path.endsWith('.md'));
const errors = [];
for (const path of docs) {
  if (path === join(root, 'docs/README.md')) continue;
  if (!/\/docs\/[^/]+\/(en|ru)\.md$/.test(path)) {
    errors.push(`Use docs/<topic>/en.md + ru.md: ${path}`);
    continue;
  }
  for (const language of ['en', 'ru'])
    if (!existsSync(join(dirname(path), language + '.md')))
      errors.push(`Missing ${language} pair: ${path}`);
}
for (const path of [...docs, join(root, 'README.md'), join(root, 'README.ru.md')]) {
  const text = readFileSync(path, 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+)\)|(?:src|href)="([^"]+)"/g)) {
    const link = (match[1] || match[2]).split(/[?#]/)[0];
    if (!link || /^[a-z]+:/i.test(link) || link.startsWith('/')) continue;
    if (!existsSync(resolve(dirname(path), decodeURIComponent(link))))
      errors.push(`Broken link in ${path}: ${link}`);
  }
  if (path.endsWith('/en.md') && !text.includes('[Русский](ru.md)'))
    errors.push(`Missing language switch: ${path}`);
  if (path.endsWith('/ru.md') && !text.includes('[English](en.md)'))
    errors.push(`Missing language switch: ${path}`);
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(
  `Documentation checked: ${(docs.length - 1) / 2} paired topics, both READMEs and local links.`,
);
