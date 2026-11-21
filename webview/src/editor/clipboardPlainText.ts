import { markdownTaskContentPrefix } from '../../../src/foundation/markdownTaskList';
import type MarkdownIt from 'markdown-it';
import { parseClipboardHtml } from './htmlPaste';
import { parseHtmlTableElement } from './tableClipboard';

const omittedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'IFRAME', 'OBJECT', 'SVG']);
const textBlockTags = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|CAPTION|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|MAIN|NAV|P|SECTION)$/;
const plainBlockTokens = new Set(['paragraph_open', 'paragraph_close', 'inline']);
const plainInlineTokens = new Set(['text', 'text_special', 'softbreak', 'hardbreak']);

export function clipboardTableText(cells: readonly (readonly string[])[], cellText = (cell: string) => cell): string {
  return cells.map(row => row.map(cell => cellText(cell).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

export function clipboardHtmlText(root: Element): string | null {
  // Breaks are queued so nested wrappers do not add extra blank lines. Tabs in
  // table rows and whitespace in code remain part of their actual text.
  const parts: string[] = [];
  let breaks = 0;
  let space = false;
  let invalidTable = false;
  const lineBreak = (count: number) => {
    breaks = Math.max(breaks, count);
    if (count) space = false;
  };
  const append = (value: string) => {
    if (!value) return;
    if (parts.length && breaks) parts.push('\n'.repeat(breaks));
    else if (parts.length && space) parts.push(' ');
    breaks = 0;
    space = false;
    parts.push(value);
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node.textContent ?? '').replace(/[\t\r\n\f ]+/g, ' ');
      if (value.startsWith(' ')) space = true;
      append(value.replace(/^ | $/g, ''));
      if (value.endsWith(' ')) space = true;
      return;
    }
    if (!(node instanceof Element) || omittedTags.has(node.tagName)) return;
    const tag = node.tagName;
    if (tag === 'BR' || tag === 'HR') { lineBreak(tag === 'BR' ? breaks + 1 : 2); return; }
    if (tag === 'IMG') { append(node.getAttribute('alt') ?? ''); return; }
    if (tag === 'PRE') {
      lineBreak(2);
      append((node.textContent ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, ''));
      lineBreak(2);
      return;
    }
    if (tag === 'TABLE') {
      lineBreak(2);
      for (const child of node.children) if (child.tagName === 'CAPTION') visit(child);
      const table = parseHtmlTableElement(node);
      if (!table) invalidTable = true;
      else append(clipboardTableText(table.cells));
      lineBreak(2);
      return;
    }
    const gap = tag === 'LI' ? 1 : tag === 'UL' || tag === 'OL' || textBlockTags.test(tag) ? 2 : 0;
    lineBreak(gap);
    for (const child of node.childNodes) visit(child);
    lineBreak(gap);
  };
  for (const node of root.childNodes) visit(node);
  return invalidTable ? null : parts.join('');
}

export function clipboardMarkdownText(markdown: MarkdownIt, text: string, inline = false): string {
  const env = {};
  const blocks = inline ? markdown.parseInline(text, env) : markdown.parse(text, env);
  if (!blocks.some(block => !plainBlockTokens.has(block.type) ||
    block.children?.some(child => !plainInlineTokens.has(child.type)))) return text;

  for (let index = 2; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type !== 'inline' || blocks[index - 1].type !== 'paragraph_open' || blocks[index - 2].type !== 'list_item_open') continue;
    const task = markdownTaskContentPrefix.exec(block.content);
    if (task) block.children = markdown.parseInline(block.content.slice(task[0].length), env)[0].children;
  }
  const root = parseClipboardHtml(markdown.renderer.render(blocks, markdown.options, env));
  return (root && clipboardHtmlText(root)) ?? text;
}
