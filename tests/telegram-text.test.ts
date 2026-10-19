import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '../src/server/env';
import type { NewsArticle } from '../src/shared/news';
import { formatNewsDigest } from '../src/server/news';
import { markdownToTelegram, updateEmoji } from '../src/server/telegram-markdown';
import { formatReleaseMessage } from '../src/server/release-message';
import { sendTelegramMessage, sendTelegramPhoto } from '../src/server/telegram-client';
import { safeTelegramLink, sliceTelegramText, TelegramTextBuilder, telegramEntitiesSchema, type TelegramText } from '../src/server/telegram-text';

const bindings = env as unknown as Env;
const messageSchema = z.object({ text: z.string(), entities: telegramEntitiesSchema.optional() });
const release = { repo: 'owner/ai_tool', tag: 'v1.2.0-beta.1', name: 'Release [one] *two*', url: 'https://github.com/owner/ai_tool/releases/tag/v1.2.0-beta.1', prerelease: false, published_at: '2026-10-19T00:30:00Z' };

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, result: { message_id: 42 } })); });
afterEach(() => vi.restoreAllMocks());

function entityText(doc: TelegramText, type: string): string[] {
  return doc.entities.filter(entity => entity.type === type).map(entity => doc.text.slice(entity.offset, entity.offset + entity.length));
}

describe('Markdown to Telegram entities', () => {
  it('renders headings, nested bold/italic, inline code, strikeout and links without visible Markdown syntax', () => {
    const doc = markdownToTelegram('## Features\n- Add **search _quickly_** with `foo_bar()` and ~~old~~ [docs](https://docs.example/a_(b)?x=1&y=2)');
    expect(doc.text).toContain('✨ Features');
    expect(doc.text).toContain('✨ Add search quickly with foo_bar() and old docs');
    expect(entityText(doc, 'bold')).toContain('Features');
    expect(entityText(doc, 'bold')).toContain('search quickly');
    expect(entityText(doc, 'italic')).toContain('quickly');
    expect(entityText(doc, 'code')).toEqual(['foo_bar()']);
    expect(entityText(doc, 'strikethrough')).toEqual(['old']);
    expect(doc.entities.find(entity => entity.type === 'text_link')).toMatchObject({ url: 'https://docs.example/a_(b)?x=1&y=2' });
    expect(doc.text).not.toContain('**');
    expect(doc.text).not.toContain('##');
  });
  it('preserves code content and language, task lists, quoted text and table data', () => {
    const doc = markdownToTelegram('```ts\nconst x = "<tag> & **literal**";\n```\n\n> **Upgrade** now\n\n- [x] Done\n- [ ] Pending\n\n| Name | Value |\n| --- | --- |\n| a | b |');
    expect(entityText(doc, 'pre')).toContain('const x = "<tag> & **literal**";');
    expect(doc.entities.find(entity => entity.type === 'pre')).toMatchObject({ language: 'ts' });
    expect(entityText(doc, 'blockquote')[0]).toContain('Upgrade now');
    expect(doc.text).toContain('☑️ Done'); expect(doc.text).toContain('☐ Pending');
    expect(entityText(doc, 'pre')).toContain('Name | Value\na | b');
  });
  it('handles special characters and HTML as literal text, and disallows unsafe links', () => {
    const doc = markdownToTelegram('A &amp; B _italic_ <b>literal</b> [unsafe](javascript:alert) [credentials](https://user:pass@example.com)');
    expect(doc.text).toContain('A & B italic <b>literal</b> unsafe credentials');
    expect(doc.entities.filter(entity => entity.type === 'text_link')).toHaveLength(0);
    expect(safeTelegramLink('data:text/html,boom')).toBeNull();
  });
  it('does not apply a bold wrapper over inline code or nest blockquote entities', () => {
    const doc = markdownToTelegram('**Before `literal` after**\n\n> outer\n>> inner');
    expect(entityText(doc, 'bold')).toContain('Before ');
    expect(entityText(doc, 'bold')).toContain(' after');
    expect(entityText(doc, 'code')).toEqual(['literal']);
    expect(doc.entities.filter(entity => entity.type === 'blockquote')).toHaveLength(1);
  });
  it.each([
    ['BREAKING: migrate config', '⚠️'], ['Fix security vulnerability CVE-2026', '🛡️'], ['Bug fixes', '🐛'],
    ['Performance optimization', '⚡'], ['新增搜索功能', '✨'], ['Documentation', '📚'], ['Update dependencies', '📦'], ['Refactor API', '🔧'],
  ])('selects a relevant emoji for %s', (text, emoji) => { expect(updateEmoji(text)).toBe(emoji); });
});

describe('rich text chunking and Telegram transport', () => {
  it('preserves every visible character and reopens styles across UTF-16 boundaries', () => {
    const doc = new TelegramTextBuilder().append('x'.repeat(1023)).append('🚀'.repeat(1000), { type: 'bold' }).build();
    const parts: TelegramText[] = [];
    let offset = 0;
    while (offset < doc.text.length) {
      const part = sliceTelegramText(doc, offset, 1024);
      expect(part.text).not.toMatch(/[\uD800-\uDBFF]$/);
      for (const entity of part.entities) expect(entity.offset + entity.length).toBeLessThanOrEqual(part.text.length);
      parts.push(part); offset += part.text.length;
    }
    expect(parts.map(part => part.text).join('')).toBe(doc.text);
    expect(parts[1].entities[0]).toMatchObject({ type: 'bold', offset: 0 });
  });
  it('keeps long code blocks formatted independently in every continuation', () => {
    const doc = markdownToTelegram('```json\n' + '"x_y": 123,\n'.repeat(900) + '```');
    const first = sliceTelegramText(doc, 0, 4000);
    const second = sliceTelegramText(doc, first.text.length, 4000);
    expect(first.entities[0]).toMatchObject({ type: 'pre', offset: 0, length: 4000, language: 'json' });
    expect(second.entities[0]).toMatchObject({ type: 'pre', offset: 0, length: 4000, language: 'json' });
  });
  it('limits overly dense formatting without truncating message content', () => {
    const doc = markdownToTelegram(Array.from({ length: 120 }, (_, index) => `**${index}**`).join(' '));
    const part = sliceTelegramText(doc, 0, 4000);
    expect(part.text).toBe(doc.text); expect(part.entities).toHaveLength(90);
  });
  it('sends text entities and both JSON/multipart caption entities', async () => {
    const doc = markdownToTelegram('**Title** and `v1.0`');
    await sendTelegramMessage(bindings, '-100123', doc);
    const request = messageSchema.parse(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)));
    expect(request.text).toBe('Title and v1.0');
    expect(request.entities).toHaveLength(2);
    await sendTelegramPhoto(bindings, '-100123', doc, 'https://images.example/cover.png');
    const caption = z.object({ caption: z.string(), caption_entities: telegramEntitiesSchema }).parse(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)));
    expect(caption.caption_entities).toEqual(request.entities);
    const assets = { fetch: vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })) };
    // This lightweight fetcher implements the only ASSETS operation exercised by the upload path.
    const runtime = { ...bindings, ASSETS: assets as unknown as Fetcher };
    await sendTelegramPhoto(runtime, '-100123', doc, '/covers/halo.png');
    const form = vi.mocked(fetch).mock.calls[2][1]?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error('expected multipart photo');
    expect(form.get('caption')).toBe(doc.text);
    expect(telegramEntitiesSchema.parse(JSON.parse(String(form.get('caption_entities'))))).toEqual(request.entities);
  });
  it('leaves plain-text command replies and legacy notifications literal', async () => {
    await sendTelegramMessage(bindings, '12345', 'literal *stars* and owner/repo_name');
    const request = messageSchema.parse(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)));
    expect(request).toEqual({ text: 'literal *stars* and owner/repo_name' });
  });
});

describe('news and release message presentation', () => {
  it('formats the digest with linked bold titles, semantic category icons and highlighted major news', () => {
    const article: NewsArticle = { title: 'Model *literal* [A]', url: 'https://news.example/a_(b)', source: 'InfoQ & Example', summary: '事实摘要 <不解析 HTML>。', category: 'model', importance: 'major', publishedAt: '2026-10-19T00:00:00Z' };
    const digest = formatNewsDigest('2026-10-19', [article, { ...article, title: '安全公告', category: 'security', importance: 'normal', url: 'https://news.example/security' }]);
    expect(entityText(digest, 'bold')).toContain('🗞️ AI 开发早报');
    expect(entityText(digest, 'bold')).toContain(article.title);
    expect(digest.text).toContain('🧠 AI 模型'); expect(digest.text).toContain('🛡️ 安全风险');
    expect(digest.text).toContain('🔥 ' + article.title); expect(digest.text).toContain('✨ 2 条精选');
    expect(digest.text).not.toContain(article.url);
    expect(digest.entities.some(entity => entity.type === 'text_link' && entity.url === article.url)).toBe(true);
    expect(digest.text).toContain('事实摘要 <不解析 HTML>。');
  });
  it('makes prereleases, upgrade warnings, tags and changelog headings visually distinct', () => {
    const doc = formatReleaseMessage(release, '## Breaking changes\n- Migrate `config_key`\n\n## Fixes\n- Fix a bug');
    expect(doc.text).toContain('⚠️ 版本更新');
    expect(doc.text).toContain('🕒 2026-10-19 08:30 · 北京时间');
    expect(entityText(doc, 'code')).toContain(release.tag);
    expect(entityText(doc, 'code')).toContain('config_key');
    expect(entityText(doc, 'bold')).toContain('Fixes');
    expect(formatReleaseMessage({ ...release, prerelease: true }, 'Fix bug').text).toContain('🧪 预发布更新');
    expect(formatReleaseMessage(release, 'Add new feature').text).toContain('✨ 版本更新');
  });
});
