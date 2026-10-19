import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Newspaper, RefreshCw } from 'lucide-react';
import { NEWS_CATEGORIES, type NewsDashboard, type NewsPhase } from '../shared/news';
import { api } from './api';
import './NewsSettings.css';

const PHASE_LABELS: Record<NewsPhase, string> = {
  collecting: '采集新闻', filtering: '筛选与分类', deduplicating: '合并同事件报道', ready: '等待 08:30 推送', sent: '已推送', empty: '本期无相关资讯',
};

export default function NewsSettings({ token, signal, isSessionCurrent, onError }: {
  token: string; signal: AbortSignal; isSessionCurrent: (session: string) => boolean; onError: (error: unknown) => string;
}) {
  const [news, setNews] = useState<NewsDashboard | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const load = useCallback(async (requestSignal: AbortSignal) => {
    try {
      const next = await api.news(token, requestSignal);
      if (requestSignal.aborted || signal.aborted || !isSessionCurrent(token)) return;
      setNews(next); setError('');
    } catch (cause) {
      if (!requestSignal.aborted && !signal.aborted && isSessionCurrent(token)) setError(onError(cause));
    }
  }, [token, signal, isSessionCurrent, onError]);
  useEffect(() => {
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    void load(requestSignal);
    const timer = setInterval(() => { if (!operation.current) void load(requestSignal); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load, signal]);

  async function mutate(kind: 'toggle' | 'retry') {
    if (!news || operation.current) return;
    operation.current = true; setBusy(true); setError('');
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    try {
      if (kind === 'toggle') {
        const next = await api.saveNewsSettings(token, !news.enabled, requestSignal);
        if (!signal.aborted && isSessionCurrent(token)) setNews(next);
      } else {
        await api.retryNews(token, requestSignal);
        await load(requestSignal);
      }
    } catch (cause) {
      if (!signal.aborted && isSessionCurrent(token)) setError(onError(cause));
    } finally {
      operation.current = false;
      if (!signal.aborted && isSessionCurrent(token)) setBusy(false);
    }
  }

  const latest = news?.latest;
  return <section className="panel deepseek-panel news-panel" aria-labelledby="news-title" aria-busy={busy}>
    <div className="deepseek-head">
      <div className="integration-logo deepseek-logo"><Newspaper size={24} /></div>
      <div className="integration-main">
        <div className="integration-heading"><h3 id="news-title">AI 开发早报</h3>
          {news && <span className={`badge badge-${news.enabled ? 'green' : 'neutral'}`}>{news.enabled ? '已开启' : '已暂停'}</span>}
        </div>
        <p>每天北京时间 08:30，接收截至 08:00 的过去 24 小时 AI 开发新闻。DeepSeek 负责筛选、中文摘要、六类归纳与同事件合并。</p>
        <p className="muted">08:00 开始准备，最多推送 10 条精选内容，发送到已绑定的 Telegram 私聊或群组。</p>
      </div>
    </div>
    {error && <div className="inline-error" role="alert">{error}<button type="button" className="button button-secondary" onClick={() => void load(signal)}>刷新</button></div>}
    {!news && !error && <p role="status"><LoaderCircle size={16} className="spin" /> 正在读取早报状态…</p>}
    {news && <>
      <dl className="deepseek-status">
        <div><dt>推送时间</dt><dd>08:30 · 北京时间</dd></div>
        <div><dt>新闻来源</dt><dd>{news.sourceCount} 个</dd></div>
        <div><dt>DeepSeek</dt><dd>{news.deepseekReady ? '已配置并启用' : '待配置或已暂停'}</dd></div>
        <div><dt>Telegram</dt><dd>{news.telegramReady ? '已就绪' : '待配置或绑定'}</dd></div>
      </dl>
      <div className="deepseek-toggle">
        <div><strong id="news-enabled-label">启用每日早报</strong><span>需要启用 DeepSeek 并绑定 Telegram；服务异常时自动重试。</span></div>
        <button type="button" role="switch" aria-checked={news.enabled} aria-labelledby="news-enabled-label"
          className={`switch${news.enabled ? ' switch-on' : ''}`} disabled={busy} onClick={() => void mutate('toggle')}><span className="switch-knob" /></button>
      </div>
      <div className="news-progress">
        <div><strong>{latest ? `${latest.date} · ${latest.failed ? '处理失败' : PHASE_LABELS[latest.phase]}` : '等待首次定时准备'}</strong>
          {latest && <p className="muted">已采集 {latest.sourceOffset}/{news.sourceCount} 个来源 · {latest.candidateCount} 条候选 · {latest.filteredCount} 条相关{latest.sourceFailures > 0 ? ` · ${latest.sourceFailures} 个来源不可用` : ''}</p>}
          {latest?.error && <p role="status">{latest.error}</p>}
          {latest?.sentAt && <p className="muted">发送于 {new Date(latest.sentAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）</p>}
        </div>
        <div className="news-actions"><button className="button button-secondary" disabled={busy} onClick={() => void load(signal)}><RefreshCw size={14} />刷新状态</button>
          {latest?.failed && <button className="button button-secondary" disabled={busy || !news.enabled} onClick={() => void mutate('retry')}>重试本期</button>}
        </div>
      </div>
      {latest && latest.articles.length > 0 && <div className="news-articles">
        {Object.entries(NEWS_CATEGORIES).map(([category, label]) => {
          const articles = latest.articles.filter(article => article.category === category);
          if (!articles.length) return null;
          return <section key={category}><h4>{label}</h4>{articles.map(article => <article key={article.url}>
            <a href={/^https?:\/\//.test(article.url) ? article.url : undefined} target="_blank" rel="noopener noreferrer">{article.importance === 'major' ? '重点 · ' : ''}{article.title}</a>
            <p>{article.summary}</p><small className="muted">{article.source}</small>
          </article>)}</section>;
        })}
      </div>}
    </>}
  </section>;
}
