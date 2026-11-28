// 把仓库里的 Markdown 转成 Notion API 的块。只处理仓库文档里常见的写法：
// 标题、段落、列表、待办、引用、代码块、表格、分隔线，以及行内的粗体、斜体、行内代码和链接。
// 其余写法（HTML、图片、脚注）退化成纯文本或链接，保证内容不丢。

const TEXT_LIMIT = 2000; // Notion 每段富文本最多 2000 个字符
const RICH_TEXT_ITEMS = 100; // 每个块最多 100 段富文本

const CODE_LANGUAGES = new Map(Object.entries({
  sh: 'shell', bash: 'bash', zsh: 'shell', shell: 'shell', console: 'shell',
  js: 'javascript', mjs: 'javascript', javascript: 'javascript', jsx: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  py: 'python', python: 'python', cpp: 'c++', 'c++': 'c++', cc: 'c++', c: 'c',
  html: 'html', css: 'css', astro: 'html', svelte: 'html', xml: 'xml',
  md: 'markdown', markdown: 'markdown', sql: 'sql', diff: 'diff', dockerfile: 'docker',
  docker: 'docker', ini: 'plain text', text: 'plain text', txt: 'plain text',
  mermaid: 'mermaid', applescript: 'plain text', go: 'go', rust: 'rust', java: 'java',
  beancount: 'plain text', caddyfile: 'plain text', http: 'plain text',
}));

/** 去掉开头的 YAML 头信息，返回正文和其中的 title。 */
export function splitFrontmatter(markdown) {
  const text = String(markdown ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { body: text, title: null };
  const title = /^title:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') ?? null;
  return { body: text.slice(match[0].length), title };
}

/**
 * @param {string} markdown
 * @param {{ resolveLink?: (href: string) => string | null }} [options]
 *   resolveLink 把相对链接换成绝对地址；返回 null 时只保留文字。
 */
export function markdownToBlocks(markdown, options = {}) {
  const resolve = options.resolveLink ?? ((href) => (isAbsolute(href) ? href : null));
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];

  const flush = () => {
    if (!paragraph.length) return;
    blocks.push(textBlock('paragraph', paragraph.join('\n'), resolve));
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      flush();
      const marker = fence[2];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      blocks.push(codeBlock(body.join('\n'), fence[3]));
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*<!--/.test(line)) {
      flush();
      while (i < lines.length && !lines[i].includes('-->')) i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length, 3);
      blocks.push(textBlock(`heading_${level}`, heading[2], resolve));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ object: 'block', type: 'divider', divider: {} }); continue; }
    if (isTableStart(lines, i)) {
      flush();
      const rows = [];
      rows.push(splitRow(lines[i]));
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      i--;
      // Notion 的表格一次最多 100 行，长表按 99 行一段拆开并重复表头。
      const body = rows.slice(1);
      for (let start = 0; start === 0 || start < body.length; start += 99) {
        blocks.push(tableBlock([rows[0], ...body.slice(start, start + 99)], resolve));
      }
      continue;
    }
    const todo = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) {
      flush();
      const block = textBlock('to_do', todo[2], resolve);
      block.to_do.checked = todo[1] !== ' ';
      blocks.push(block);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) { flush(); blocks.push(textBlock('bulleted_list_item', bullet[1], resolve)); continue; }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) { flush(); blocks.push(textBlock('numbered_list_item', numbered[1], resolve)); continue; }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) body.push(lines[++i].replace(/^\s*>\s?/, ''));
      blocks.push(textBlock('quote', body.join('\n').replace(/^\[!(\w+)\]\s*/, '$1：'), resolve));
      continue;
    }
    if (paragraph.length === 0 && /^\s{4,}\S/.test(line)) {
      // 缩进代码块之外的缩进行多半是列表的续行，接到上一块里。
      const last = blocks.at(-1);
      if (last && /list_item|to_do/.test(last.type)) {
        appendText(last, '\n' + line.trim(), resolve);
        continue;
      }
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** 把行内 Markdown 转成富文本数组。 */
export function richText(text, resolve = (href) => (isAbsolute(href) ? href : null)) {
  const items = [];
  const source = stripHtml(String(text ?? ''));
  const pattern = /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<!\w)_([^_\n]+)_(?!\w)|(https?:\/\/[^\s<>()　-〿＀-￯]+[^\s<>().,;:!?'"　-〿＀-￯])/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) push(items, unescape(source.slice(last, match.index)));
    if (match[1]) push(items, match[2], { code: true });
    else if (match[3] !== undefined) {
      const href = match[4] ? resolve(match[4]) : null;
      push(items, unescape(match[3]) || match[4], {}, href && isAbsolute(href) ? href : null);
    } else if (match[5] ?? match[6]) push(items, unescape(match[5] ?? match[6]), { bold: true });
    else if (match[7] ?? match[8]) push(items, unescape(match[7] ?? match[8]), { italic: true });
    else if (match[9]) push(items, match[9], {}, match[9]);
    last = match.index + match[0].length;
  }
  if (last < source.length) push(items, unescape(source.slice(last)));
  return limitItems(items);
}

function push(items, content, annotations = {}, url = null) {
  if (!content) return;
  for (let start = 0; start < content.length; start += TEXT_LIMIT) {
    const item = { type: 'text', text: { content: content.slice(start, start + TEXT_LIMIT) } };
    if (url) item.text.link = { url };
    if (Object.keys(annotations).length) item.annotations = annotations;
    items.push(item);
  }
}

function limitItems(items) {
  if (items.length <= RICH_TEXT_ITEMS) return items;
  // 超过 100 段时把后面的合并成纯文本，宁可丢格式也不丢字。
  const head = items.slice(0, RICH_TEXT_ITEMS - 1);
  const rest = items.slice(RICH_TEXT_ITEMS - 1).map((item) => item.text.content).join('');
  return [...head, { type: 'text', text: { content: rest.slice(0, TEXT_LIMIT) } }];
}

function textBlock(type, text, resolve) {
  return { object: 'block', type, [type]: { rich_text: richText(text, resolve) } };
}

function appendText(block, text, resolve) {
  const data = block[block.type];
  data.rich_text = limitItems([...data.rich_text, ...richText(text, resolve)]);
}

function codeBlock(code, language) {
  const items = [];
  push(items, code || ' ');
  const key = String(language || '').toLowerCase();
  return {
    object: 'block',
    type: 'code',
    code: { rich_text: limitItems(items), language: CODE_LANGUAGES.get(key) ?? 'plain text' },
  };
}

function isTableStart(lines, i) {
  return /^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '');
}

function splitRow(line) {
  const cells = [];
  let current = '';
  let code = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\' && body[i + 1] === '|') { current += '|'; i++; continue; }
    if (char === '`') code = !code;
    if (char === '|' && !code) { cells.push(current.trim()); current = ''; continue; }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function tableBlock(rows, resolve) {
  const width = Math.max(...rows.map((row) => row.length));
  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: rows.map((row) => ({
        object: 'block',
        type: 'table_row',
        table_row: { cells: Array.from({ length: width }, (_, index) => richText(row[index] ?? '', resolve)) },
      })),
    },
  };
}

function stripHtml(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<\/?(?:p|div|span|picture|source|img|sup|sub|details|summary|kbd|b|strong|i|em|code|center|small)\b[^>]*>/gi, '');
}

function unescape(text) {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1');
}

function isAbsolute(href) {
  return /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
}
