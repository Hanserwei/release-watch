import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

export interface NewsCandidate {
  title: string; url: string; summary: string; source: string; publishedAt: string;
}
export const NEWS_SOURCES = [
  { name: 'Hacker News AI Coding', url: 'https://hnrss.org/newest?q=AI+coding' },
  { name: 'Reddit Programming', url: 'https://www.reddit.com/r/programming/.rss' },
  { name: 'Lobsters', url: 'https://lobste.rs/rss' },
  { name: 'Dev.to AI', url: 'https://dev.to/feed/tag/ai' },
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
  { name: 'VentureBeat AI', url: 'https://feeds.feedburner.com/venturebeat/SZYF' },
  { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed' },
  { name: 'OpenAI', url: 'https://openai.com/blog/rss.xml' },
  { name: 'Google AI', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/' },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'GitHub Blog', url: 'https://github.blog/feed/' },
  { name: 'arXiv AI', url: 'https://rss.arxiv.org/rss/cs.AI' },
  { name: 'InfoQ 中文', url: 'https://www.infoq.cn/feed' },
  { name: '36氪', url: 'https://36kr.com/feed' },
  { name: '机器之心', url: 'https://www.jiqizhixin.com/rss' },
  { name: '量子位', url: 'https://www.qbitai.com/feed' },
  { name: '少数派', url: 'https://sspai.com/feed' },
  { name: 'Cursor Releases', url: 'https://github.com/cursor/cursor/releases.atom' },
  { name: 'Continue Releases', url: 'https://github.com/continuedev/continue/releases.atom' },
  { name: 'Ollama Releases', url: 'https://github.com/ollama/ollama/releases.atom' },
  { name: 'LangChain Releases', url: 'https://github.com/langchain-ai/langchain/releases.atom' },
  { name: 'Open WebUI Releases', url: 'https://github.com/open-webui/open-webui/releases.atom' },
  { name: 'GitHub Trending', url: 'https://github.com/trending?since=daily', trending: true },
] as const;

// Bounds keep a cron invocation within Workers memory, CPU and request limits.
export const MAX_NEWS_CANDIDATES = 120;
const MAX_SOURCE_BYTES = 2_000_000;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: true });
const xmlRecord = z.record(z.string(), z.unknown());

function scalar(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in value) return scalar(value['#text']);
  return '';
}

export function plainText(value: unknown, limit: number): string {
  return scalar(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
      const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const hex = entity.toLowerCase().startsWith('&#x');
      const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function canonicalNewsUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 1500) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

export function parseNewsFeed(xml: string, source: string, baseUrl: string, cutoff: number, observedAt = cutoff): NewsCandidate[] {
  // Reject DTDs/entities rather than allowing untrusted feeds to expand them.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('news_source_invalid');
  const doc = xmlRecord.parse(parser.parse(xml));
  const rss = xmlRecord.parse(doc.rss ?? {});
  const root = xmlRecord.parse(rss.channel ?? doc.feed ?? doc.RDF ?? {});
  if (!doc.rss && !doc.feed && !doc.RDF) throw new Error('news_source_invalid');
  const rawEntries = root.item ?? root.entry;
  const entries = z.array(xmlRecord).parse(rawEntries == null ? [] : Array.isArray(rawEntries) ? rawEntries : [rawEntries]);
  const articles: NewsCandidate[] = [];
  for (const entry of entries.slice(0, 60)) {
    const links: unknown[] = entry.link == null ? [] : Array.isArray(entry.link) ? entry.link : [entry.link];
    const link = links.find((item): item is Record<string, unknown> => item !== null && typeof item === 'object'
      && '@_href' in item && typeof item['@_href'] === 'string' && (!('@_rel' in item) || item['@_rel'] === 'alternate'));
    const rawUrl = link ? scalar(link['@_href']) : scalar(entry.link) || scalar(entry.guid);
    const url = canonicalNewsUrl(rawUrl, baseUrl);
    const title = plainText(entry.title, 240);
    const published = Date.parse(scalar(entry.pubDate ?? entry.published ?? entry.date ?? entry.updated));
    // Unknown dates are skipped: old undated content must not masquerade as today's news.
    if (!url || !rawUrl || !title || !Number.isFinite(published) || published < cutoff - 86_400_000 || published > Math.min(cutoff, observedAt)) continue;
    articles.push({ title, url, source, publishedAt: new Date(published).toISOString(), summary: plainText(entry.description ?? entry.summary ?? entry.encoded ?? entry.content, 700) });
  }
  return articles.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 6);
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('news_source_empty');
  const decoder = new TextDecoder();
  let size = 0; let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SOURCE_BYTES) throw new Error('news_source_too_large');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchNewsSource(index: number, cutoff: number, observedAt = cutoff): Promise<NewsCandidate[]> {
  const source = NEWS_SOURCES[index];
  if (!source) return [];
  const response = await fetch(source.url, {
    headers: { 'User-Agent': 'ReleaseWatch-News/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/html' },
    signal: AbortSignal.timeout(10_000), redirect: 'follow',
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('news_source_unavailable'); }
  const text = await boundedText(response);
  if (!('trending' in source)) return parseNewsFeed(text, source.name, source.url, cutoff, observedAt);
  const articles: NewsCandidate[] = [];
  let current: NewsCandidate | null = null;
  await new HTMLRewriter().on('article.Box-row', { element() { current = null; } })
    .on('article.Box-row h2 a', { element(element) {
      const url = canonicalNewsUrl(element.getAttribute('href') ?? '', 'https://github.com');
      if (!url || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url)) return;
      current = { title: new URL(url).pathname.slice(1), url, summary: '', source: source.name, publishedAt: new Date(Math.min(cutoff, observedAt)).toISOString() };
      articles.push(current);
    } }).on('article.Box-row p', { text(chunk) { if (current) current.summary = (current.summary + chunk.text).slice(0, 700); } })
    .transform(new Response(text)).text();
  // Trending is a discovery timestamp, not a claimed project release date.
  return articles.slice(0, 6).map(article => ({ ...article, summary: plainText(article.summary, 650) + '（今日 GitHub Trending 发现，非项目发布日期）' }));
}

export function mergeNewsCandidates(existing: NewsCandidate[], incoming: NewsCandidate[], sentUrls: Set<string>): NewsCandidate[] {
  const urls = new Set(existing.map(item => item.url));
  const titles = new Set(existing.map(item => item.title.toLocaleLowerCase().replace(/\s+/g, '')));
  const result = [...existing];
  for (const item of incoming) {
    const title = item.title.toLocaleLowerCase().replace(/\s+/g, '');
    if (urls.has(item.url) || titles.has(title) || sentUrls.has(item.url)) continue;
    urls.add(item.url); titles.add(title); result.push(item);
  }
  return result.slice(0, MAX_NEWS_CANDIDATES);
}
