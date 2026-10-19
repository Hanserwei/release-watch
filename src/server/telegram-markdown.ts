import { Marked, type MarkedToken, type Token } from 'marked';
import { safeTelegramLink, TelegramTextBuilder, type TelegramText } from './telegram-text';

// This dedicated lexer has no extensions, so its output contains only built-in MarkedToken shapes.
const markdown = new Marked({ gfm: true, breaks: false });

export function updateEmoji(text: string, fallback = '📌'): string {
  if (/breaking|incompatib|破坏性|不兼容|重大变更/i.test(text)) return '⚠️';
  if (/security|vulnerab|\bcve\b|安全|漏洞/i.test(text)) return '🛡️';
  if (/\bfix(?:es|ed)?\b|\bbugs?\b|修复|修正|纠正/i.test(text)) return '🐛';
  if (/\bperf(?:ormance)?\b|optimi[sz]|性能|优化|提速/i.test(text)) return '⚡';
  if (/\bfeat(?:ure)?s?\b|\badd(?:ed)?\b|\bnew\b|新增|新功能|增加/i.test(text)) return '✨';
  if (/\bdocs?\b|documentation|文档|示例/i.test(text)) return '📚';
  if (/\bdeps?\b|dependenc|依赖/i.test(text)) return '📦';
  if (/\bchange[ds]?\b|refactor|调整|变更|重构/i.test(text)) return '🔧';
  return fallback;
}

function decodeText(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()] ?? entity;
    const hex = name[1].toLowerCase() === 'x';
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function renderTokens(tokens: Token[], depth = 0): TelegramText {
  const out = new TelegramTextBuilder();
  for (const rawToken of tokens) {
    // Marked types include extension tokens; this local, extension-free lexer cannot produce them.
    const token = rawToken as unknown as MarkedToken;
    if (depth > 16) { out.append(token.raw); continue; }
    switch (token.type) {
      case 'heading': {
        const icon = /^\p{Extended_Pictographic}/u.test(token.text) ? '' : updateEmoji(token.text) + ' ';
        out.append(icon).append(renderTokens(token.tokens, depth + 1), { type: 'bold' }).append('\n\n');
        break;
      }
      case 'paragraph': out.append(renderTokens(token.tokens, depth + 1)).append('\n\n'); break;
      case 'text': out.append(token.tokens ? renderTokens(token.tokens, depth + 1) : decodeText(token.text)); break;
      case 'escape': out.append(decodeText(token.text)); break;
      case 'strong': out.append(renderTokens(token.tokens, depth + 1), { type: 'bold' }); break;
      case 'em': out.append(renderTokens(token.tokens, depth + 1), { type: 'italic' }); break;
      case 'del': out.append(renderTokens(token.tokens, depth + 1), { type: 'strikethrough' }); break;
      case 'codespan': out.append(token.text, { type: 'code' }); break;
      case 'code': out.append(token.text, { type: 'pre', language: token.lang?.split(/\s/)[0] }).append('\n\n'); break;
      case 'link': {
        const link = safeTelegramLink(token.href);
        out.append(renderTokens(token.tokens, depth + 1), link ? { type: 'text_link', url: link } : undefined);
        break;
      }
      case 'image': {
        const link = safeTelegramLink(token.href);
        out.append(`🖼️ ${decodeText(token.text || '图片')}`, link ? { type: 'text_link', url: link } : undefined);
        break;
      }
      case 'blockquote': out.append(renderTokens(token.tokens, depth + 1), { type: 'blockquote' }); break;
      case 'list': {
        for (let index = 0; index < token.items.length; index++) {
          const item = token.items[index];
          const marker = item.task ? item.checked ? '☑️' : '☐' : token.ordered ? `${Number(token.start) + index}.` : updateEmoji(item.text, '•');
          const rendered = renderTokens(item.tokens, depth + 1);
          out.append(marker + ' ').append(rendered).append(rendered.text.endsWith('\n') ? '' : '\n');
        }
        out.append('\n');
        break;
      }
      case 'list_item': out.append(renderTokens(token.tokens, depth + 1)); break;
      case 'table': {
        const rows = [token.header, ...token.rows];
        out.append(rows.map(row => row.map(cell => decodeText(cell.text)).join(' | ')).join('\n'), { type: 'pre' }).append('\n\n');
        break;
      }
      case 'hr': out.append('──────────\n\n'); break;
      case 'br': out.append('\n'); break;
      case 'space': out.append(token.raw); break;
      case 'html': out.append(token.text); break;
      case 'checkbox': case 'def': break;
    }
  }
  return out.build();
}

/** Render GitHub Markdown without interpreting HTML or accepting unsafe link protocols. */
export function markdownToTelegram(source: string): TelegramText {
  const rendered = renderTokens(markdown.lexer(source));
  // Keep meaningful source characters; remove only the renderer's trailing layout whitespace.
  const text = rendered.text.trimEnd();
  return { text, entities: rendered.entities.flatMap(entity => {
    const length = Math.min(entity.offset + entity.length, text.length) - entity.offset;
    return length > 0 ? [{ ...entity, length }] : [];
  }) };
}
