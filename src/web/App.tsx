import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, Bell, BellRing, Check,
  CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, ExternalLink,
  Eye, EyeOff, FolderGit2, Github, Image as ImageIcon, KeyRound, Layers3, LoaderCircle, LogOut,
  Menu, Pause, Play, Plus, Radio, RefreshCw, Search, Send, Settings2, ShieldCheck,
  Sparkles, Tag, Trash2, TriangleAlert, X,
} from 'lucide-react';
import type { DashboardData, PublicDashboardData, PublicReleaseView, PublicStatusData, PublicSubscriptionView, ReleaseView, StatusData, SubscriptionInput, SubscriptionPatch, SubscriptionView } from '../shared/types';
import { defaultCoverForRepo } from '../shared/covers';
import { api, ApiRequestError, githubUrl } from './api';
import DeepSeekSettings from './DeepSeekSettings';

type Page = 'subscriptions' | 'timeline' | 'status';
type Notice = { kind: 'success' | 'error'; text: string };
type ModalState = { kind: 'add' } | { kind: 'edit' | 'delete'; subscription: SubscriptionView } | null;
const SESSION_KEY = 'release-watch-session';
const intervals = [{ value: 15, label: '每 15 分钟' }, { value: 30, label: '每 30 分钟' }, { value: 60, label: '每小时' }, { value: 360, label: '每 6 小时' }];
const pages = [
  { id: 'subscriptions' as const, label: '订阅管理', icon: FolderGit2, subtitle: '关注每一次，值得关注的更新。' },
  { id: 'timeline' as const, label: '版本时间线', icon: Layers3, subtitle: '开源世界的进展，在这里汇聚。' },
  { id: 'status' as const, label: '运行状态', icon: Activity, subtitle: '从版本检查到消息送达，一目了然。' },
];
const publicPages = pages.map(item => item.id === 'subscriptions'
  ? { ...item, label: '分享项目', subtitle: '发现值得关注的项目，跟进每一次版本更新。' }
  : item.id === 'status' ? { ...item, subtitle: '分享项目的检查进展，一目了然。' } : item);
const deliveryLabels: Record<NonNullable<ReleaseView['deliveryStatus']>, string> = { pending: '等待通知', sending: '发送中', sent: '已通知', failed: '通知失败' };

function formatDate(value: string | null, fallback = '尚无记录'): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间不可用';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

const builtinCoverPath = /^\/covers\/[a-z0-9-]+\.png$/;

/** 只有内置封面或公开 HTTPS 图片可以进入 <img>，其余链接一律忽略。 */
function coverSrc(value: string | null | undefined): string | null {
  if (!value) return null;
  const input = value.trim();
  if (builtinCoverPath.test(input)) return input;
  if (!/^https:\/\//i.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.hostname.endsWith('.localhost')) return null;
    return url.hostname.includes('.') ? url.href : null;
  } catch {
    return null;
  }
}

/** 把表单里的封面输入校验成后端接受的地址；空输入返回 null 表示无自定义封面。 */
function normalizeCoverInput(value: string): { cover: string | null; error: string } {
  const input = value.trim();
  if (!input) return { cover: null, error: '' };
  if (/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/.test(input)) return { cover: null, error: '封面地址不能包含空格或控制字符。' };
  if (input.length > 500) return { cover: null, error: '封面地址过长，请使用更短的图片链接。' };
  if (builtinCoverPath.test(input)) return { cover: input, error: '' };
  if (!/^https:\/\//i.test(input)) return { cover: null, error: '请输入内置封面路径（如 /covers/halo.png）或 https:// 开头的图片链接。' };
  if (!coverSrc(input)) return { cover: null, error: '封面链接格式不正确，需为不含凭据与片段的公开 HTTPS 地址。' };
  return { cover: input, error: '' };
}

/**
 * 卡片封面：加载成功后淡入；加载失败先淡出再隐藏，让卡片回到无封面的排版。
 * 传入 fallback 时（如表单预览）失败后显示占位图，避免布局跳动。
 */
function CoverPicture({ src, className, alt = '', fallback }: { src: string | null | undefined; className: string; alt?: string; fallback?: ReactNode }) {
  const safeSrc = coverSrc(src);
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'hidden'>('loading');
  useEffect(() => { setState('loading'); }, [safeSrc]);
  useEffect(() => {
    if (state !== 'failed') return;
    const timeout = window.setTimeout(() => setState('hidden'), 220);
    return () => window.clearTimeout(timeout);
  }, [state]);
  if (!safeSrc || state === 'hidden') return fallback ? <div className={`${className} ${className}-empty`}>{fallback}</div> : null;
  return <div className={`${className}${state === 'ready' ? ' is-ready' : ''}`}>
    <img src={safeSrc} alt={alt} loading="lazy" decoding="async" onLoad={() => setState('ready')} onError={() => setState('failed')} />
  </div>;
}

function Brand({ light = false }: { light?: boolean }) {
  return <div className={`brand${light ? ' brand-light' : ''}`}><span className="brand-symbol"><Radio size={24} strokeWidth={1.8} /></span><span>Release<span className="brand-watch">Watch</span><small>让更新，不再错过</small></span></div>;
}

function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: 'green' | 'neutral' | 'amber' | 'red' | 'purple'; dot?: boolean }) {
  return <span className={`badge badge-${tone}`}>{dot && <span className="badge-dot" />}{children}</span>;
}

function EmptyState({ icon: Icon = FolderGit2, title, description, children }: { icon?: typeof FolderGit2; title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={28} strokeWidth={1.5} /></div><h3>{title}</h3><p>{description}</p>{children}</div>;
}

function Dialog({ title, description, children, busy, returnFocusTo, onClose }: { title: string; description: string; children: ReactNode; busy: boolean; returnFocusTo: HTMLElement | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (returnFocusTo?.isConnected && !returnFocusTo.hasAttribute('disabled')) returnFocusTo.focus();
      else document.getElementById('main-content')?.focus();
    };
  }, [returnFocusTo]);
  return <dialog
    ref={ref} className="dialog" aria-labelledby="dialog-title" aria-describedby="dialog-description" aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => {
      if (busy || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}
  >
    <div className="dialog-heading">
      <div className="dialog-icon"><FolderGit2 size={23} /></div>
      <button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭对话框"><X size={20} /></button>
    </div>
    <h2 id="dialog-title">{title}</h2><p id="dialog-description" className="muted">{description}</p>{children}
  </dialog>;
}

function SubscriptionForm({ subscription, busy, error, onSave, onClose }: { subscription?: SubscriptionView; busy: boolean; error: string; onSave: (input: SubscriptionInput) => void; onClose: () => void }) {
  const [repo, setRepo] = useState(subscription?.repo ?? '');
  const [cover, setCover] = useState(subscription?.coverUrl ?? '');
  const [coverError, setCoverError] = useState('');
  const [prerelease, setPrerelease] = useState(subscription?.includePrerelease ?? false);
  const [interval, setIntervalValue] = useState(subscription?.intervalMinutes ?? 15);
  const [validation, setValidation] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let normalized = repo.trim().replace(/\/$/, '').replace(/\.git$/, '');
    if (/^https?:\/\//i.test(normalized)) {
      const url = githubUrl(normalized);
      if (!url) { setValidation('请输入 github.com 上的仓库地址。'); return; }
      normalized = new URL(url).pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_.-]+$/.test(normalized)) {
      setValidation('请输入有效仓库，格式为 owner/repo 或完整 GitHub 仓库地址。');
      return;
    }
    const { cover: parsed, error } = normalizeCoverInput(cover);
    if (error) { setCoverError(error); return; }
    setValidation(''); setCoverError('');
    // 新建时留空自动套用内置封面；编辑时留空表示移除自定义封面。
    onSave({ repo: normalized, includePrerelease: prerelease, intervalMinutes: interval, coverUrl: parsed ?? (subscription ? null : defaultCoverForRepo(normalized)) });
  }
  // 预览与保存共用同一校验结果：非法链接不渲染图片，空缺时展示实际会保存的封面。
  const fallbackCover = subscription ? null : defaultCoverForRepo(repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, ''));
  const previewCover = normalizeCoverInput(cover).cover ?? fallbackCover;
  return <form onSubmit={submit} className="subscription-form">
    <div className="field"><label htmlFor="repo">GitHub 仓库 <span className="required">*</span></label><div className="input-icon"><Github size={18} /><input id="repo" name="repo" autoFocus required disabled={!!subscription || busy} value={repo} onChange={event => { setRepo(event.target.value); setValidation(''); }} placeholder="例如：vuejs/core" autoComplete="off" aria-describedby="repo-hint repo-error" aria-invalid={!!validation} /></div><span id="repo-hint" className="field-hint">支持 owner/repo 或 https://github.com/owner/repo</span>{validation && <span id="repo-error" className="field-error" role="alert">{validation}</span>}</div>
    <div className="field cover-field">
      <label htmlFor="cover-url">封面图片</label>
      <div className="cover-input-row">
        <CoverPicture
          src={previewCover} className="cover-thumb" alt={previewCover ? `${repo || '项目'} 的封面预览` : ''}
          fallback={<ImageIcon size={18} aria-hidden="true" />}
        />
        <div className="cover-input-main">
          <div className="input-icon"><ImageIcon size={18} /><input id="cover-url" name="cover-url" value={cover} disabled={busy} onChange={event => { setCover(event.target.value); setCoverError(''); }} placeholder="/covers/halo.png 或 https://…/cover.png" autoComplete="off" spellCheck={false} aria-describedby="cover-hint cover-error" aria-invalid={!!coverError} /></div>
          <div className="cover-input-actions">
            <span id="cover-hint" className="field-hint">{cover ? '预览会随输入实时更新。' : subscription ? '留空并保存将移除封面，通知恢复为纯文字。' : '留空将自动使用内置封面（若该项目有）。'}</span>
            {cover && <button type="button" className="button button-quiet cover-clear" disabled={busy} onClick={() => { setCover(''); setCoverError(''); }} aria-label="清除封面地址"><X size={14} />清除</button>}
          </div>
        </div>
      </div>
      {coverError && <span id="cover-error" className="field-error" role="alert">{coverError}</span>}
    </div>
    <fieldset className="release-options" disabled={busy}><legend>关注的版本</legend><label className={`radio-card${!prerelease ? ' selected' : ''}`}><input type="radio" name="release-type" checked={!prerelease} onChange={() => setPrerelease(false)} /><div><strong>仅正式版本</strong><span>稳定发布，适合日常使用</span></div><ShieldCheck size={20} /></label><label className={`radio-card${prerelease ? ' selected' : ''}`}><input type="radio" name="release-type" checked={prerelease} onChange={() => setPrerelease(true)} /><div><strong>包含预发布</strong><span>同时关注 Beta、RC 等尝鲜版本</span></div><Sparkles size={20} /></label></fieldset>
    <div className="field">
      <label htmlFor="interval">检查频率</label>
      <div className="select-wrap">
        <Clock3 size={18} />
        <select id="interval" value={interval} disabled={busy} onChange={event => setIntervalValue(Number(event.target.value))}>
          {!intervals.some(item => item.value === interval) && <option value={interval}>每 {interval} 分钟（当前值）</option>}
          {intervals.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <ChevronDown size={16} />
      </div>
    </div>
    <div className="info-note"><Bell size={17} /><p>新版本会发送至已绑定的 Telegram 会话。首次成功读取最新一页后建立基线，历史版本会在后台逐步补齐，订阅前已发布的历史版本不补发通知。</p></div>
    {error && <div className="inline-error" role="alert"><TriangleAlert size={17} />{error}</div>}
    <div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : subscription ? <Check size={16} /> : <Plus size={16} />}{busy ? '正在保存…' : subscription ? '保存设置' : '添加订阅'}</button></div>
  </form>;
}

function Login({ message, onLogin, onBrowse }: { message: string; onLogin: (token: string) => Promise<void>; onBrowse: () => void }) {
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true); setError('');
    try { await onLogin(token.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <div className="login-layout">
    <section className="login-story">
      <Brand light />
      <div className="login-story-body">
        <div className="eyebrow light"><span className="live-dot" /> YOUR OPEN SOURCE RADAR</div>
        <h1>好项目，<br />每一步都值得关注。</h1>
        <p>连接你关心的 GitHub 仓库，<br />让每一次重要更新，及时抵达。</p>
        <div className="orbit-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="orbit-center"><Radio size={50} strokeWidth={1.2} /></div>
          <span className="orbit-node node-one"><Github size={25} /></span>
          <span className="orbit-node node-two"><Tag size={22} /></span>
          <span className="orbit-node node-three"><Send size={22} /></span>
        </div>
      </div>
      <div className="login-story-footer"><ShieldCheck size={16} /> 私有控制台 · 安心关注开源</div>
    </section>
    <main className="login-main">
      <div className="login-mobile-brand"><Brand /></div>
      <div className="login-form-wrap">
        <div className="login-key"><KeyRound size={25} strokeWidth={1.6} /></div>
        <span className="eyebrow">WELCOME TO RELEASE WATCH</span>
        <h2>欢迎回来</h2>
        <p className="login-intro">输入管理访问口令，管理订阅与通知。</p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="access-token">管理访问口令</label>
            <div className="password-input">
              <input id="access-token" name="access-token" type={visible ? 'text' : 'password'} value={token} onChange={event => setToken(event.target.value)} placeholder="请输入管理访问口令" autoComplete="current-password" required autoFocus disabled={busy} aria-describedby={`token-hint${error || message ? ' login-error' : ''}`} />
              <button type="button" aria-label={visible ? '隐藏口令' : '显示口令'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
            </div>
            <span id="token-hint" className="field-hint">口令仅保存在当前标签页的会话中。</span>
          </div>
          {(error || message) && <div id="login-error" className="inline-error" role="alert"><TriangleAlert size={17} />{error || message}</div>}
          <button className="button button-primary login-submit" type="submit" disabled={busy || !token.trim()}>
            {busy && <LoaderCircle size={18} className="spin" />}{busy ? '正在验证…' : '进入控制台'}{!busy && <ArrowRight size={18} />}
          </button>
        </form>
        <button type="button" className="button button-secondary browse-return" onClick={onBrowse}>返回公开浏览<ArrowRight size={16} /></button>
        <div className="login-help"><CircleHelp size={16} /><span>尚未获得管理访问口令？请联系服务管理员。</span></div>
      </div>
      <div className="login-footer">Release Watch <span>·</span> 让开源更新，井然有序</div>
    </main>
  </div>;
}

function SubscriptionCard({ subscription: sub, actions }: { subscription: PublicSubscriptionView; actions?: { busy: boolean; onEdit: () => void; onDelete: () => void; onToggle: () => void; onCheck: () => void } }) {
  const releaseUrl = githubUrl(sub.latestUrl);
  const repoUrl = githubUrl(`https://github.com/${sub.repo}`);
  const [owner, repo] = sub.repo.split('/');
  return <article className={`subscription-card${sub.paused ? ' is-paused' : ''}`}>
    <CoverPicture src={sub.coverUrl} className="card-cover" />
    <div className="subscription-card-top"><div className="repo-avatar" aria-hidden="true">{owner.slice(0, 2).toUpperCase()}</div><div className="repo-title"><span className="repo-owner">{owner}</span><h3>{repoUrl ? <a href={repoUrl} target="_blank" rel="noopener noreferrer">{repo}<ArrowUpRight size={14} /></a> : repo}</h3></div><Badge dot tone={sub.paused ? 'neutral' : sub.error ? 'red' : !sub.initialized ? 'amber' : 'green'}>{sub.paused ? '已暂停' : sub.error ? '检查异常' : !sub.initialized ? '待建基线' : '订阅中'}</Badge></div>
    <div className="latest-release"><span>最新版本</span>{sub.latestTag ? <div><Tag size={15} />{releaseUrl ? <a href={releaseUrl} target="_blank" rel="noopener noreferrer">{sub.latestTag}<ArrowUpRight size={13} /></a> : <strong>{sub.latestTag}</strong>}</div> : <strong className="no-release">{sub.initialized ? '暂无可用版本' : '等待首次检查'}</strong>}</div>
    <div className="subscription-meta"><span><Clock3 size={14} />{intervals.find(item => item.value === sub.intervalMinutes)?.label ?? `每 ${sub.intervalMinutes} 分钟`}</span><span><Layers3 size={14} />{sub.includePrerelease ? '含预发布' : '仅正式版'}</span></div>
    <div className="checked-time"><span>最后检查</span><time dateTime={sub.lastCheckedAt ?? undefined}>{formatDate(sub.lastCheckedAt, '尚未检查')}</time></div>
    {sub.error ? <div className="card-notice card-error"><TriangleAlert size={14} /><span>{actions ? sub.error : '检查暂时异常，请稍后查看'}</span></div> : !sub.initialized ? <div className="card-notice"><CircleHelp size={14} /><span>{actions ? '首次成功读取最新版本后建立基线' : '正在等待首次版本记录'}</span></div> : <div className="card-notice card-next"><span className="small-dot" /><span>{sub.paused ? '恢复后将继续检查更新' : `下次检查 ${formatDate(sub.nextCheckAt)}`}</span></div>}
    {actions && <div className="card-actions"><button className="button button-quiet check-button" disabled={actions.busy} onClick={actions.onCheck} aria-label={`立即检查 ${sub.repo}`}><RefreshCw size={15} className={actions.busy ? 'spin' : ''} />{actions.busy ? '处理中…' : '立即检查'}</button><div><button className="icon-button" onClick={actions.onToggle} disabled={actions.busy} aria-label={`${sub.paused ? '恢复' : '暂停'} ${sub.repo}`} title={sub.paused ? '恢复订阅' : '暂停订阅'}>{sub.paused ? <Play size={16} /> : <Pause size={16} />}</button><button className="icon-button" onClick={actions.onEdit} disabled={actions.busy} aria-label={`设置 ${sub.repo}`} title="订阅设置"><Settings2 size={16} /></button><button className="icon-button danger-icon" onClick={actions.onDelete} disabled={actions.busy} aria-label={`删除 ${sub.repo}`} title="删除订阅"><Trash2 size={16} /></button></div></div>}
  </article>;
}

function Timeline({ releases, publicView = false }: { releases: (PublicReleaseView | ReleaseView)[]; publicView?: boolean }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const filtered = releases.filter(release => `${release.repo} ${release.tag} ${release.name}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'stable' ? !release.prerelease : release.prerelease)));
  return <><div className="section-toolbar"><div className="search-input"><Search size={18} /><input aria-label="搜索版本或仓库" placeholder="搜索仓库、版本号…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="清除搜索"><X size={15} /></button>}</div><div className="filter-tabs" aria-label="版本类型">{[{ id: 'all', label: '全部版本' }, { id: 'stable', label: '正式版' }, { id: 'pre', label: '预发布' }].map(item => <button key={item.id} className={filter === item.id ? 'selected' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div></div>
    <div className="timeline-caption"><span>最近发现的版本</span><span>共 {filtered.length} 条记录</span></div>
    {!filtered.length ? <div className="panel"><EmptyState icon={Layers3} title={releases.length ? '没有匹配的版本' : '静候下一次发布'} description={releases.length ? '试试其他关键词，或切换版本筛选。' : publicView ? '分享项目的版本记录会陆续出现在这里。' : '订阅建立基线后，新发现的 GitHub 版本会出现在这里。'} /></div> : <div className="timeline">{filtered.map(release => { const url = githubUrl(release.url); const deliveryStatus = !publicView && 'deliveryStatus' in release ? release.deliveryStatus : undefined; return <article key={release.id} className="timeline-item"><div className="timeline-marker"><Tag size={17} /></div><div className="timeline-card"><div className="release-header"><span className="release-repo"><Github size={16} />{release.repo}</span><time dateTime={release.publishedAt}>{formatDate(release.publishedAt)}</time></div><div className="release-title"><h3>{release.name || release.tag}</h3><Badge tone={release.prerelease ? 'purple' : 'green'}>{release.prerelease ? '预发布' : '正式版'}</Badge></div><div className="release-tag"><Tag size={14} />{release.tag}</div>{release.body ? <details className="release-body"><summary>查看发布说明<ChevronDown size={15} /></summary><pre>{release.body}</pre></details> : <p className="release-no-body">此版本未提供发布说明。</p>}<div className="release-footer">{deliveryStatus !== undefined && <Badge tone={deliveryStatus === 'sent' ? 'green' : deliveryStatus === 'failed' ? 'red' : 'neutral'}>{deliveryStatus === 'sent' ? <Check size={13} /> : <Bell size={13} />}{deliveryStatus ? deliveryLabels[deliveryStatus] : '无需通知'}</Badge>}<span className="discovered-time">发现于 {formatDate(release.discoveredAt)}</span>{url && <a className="text-link" href={url} target="_blank" rel="noopener noreferrer">在 GitHub 查看<ExternalLink size={13} /></a>}</div></div></article>; })}</div>}
    <p className="page-footnote"><ShieldCheck size={14} /> 发布说明以纯文本展示，链接仅支持 GitHub。</p>
  </>;
}

function StatusPage({ status, health, retrying, onRetry, token, signal, isSessionCurrent, onError }: { status: StatusData; health: 'checking' | 'online' | 'offline'; retrying: boolean; onRetry: () => void; token: string; signal: AbortSignal; isSessionCurrent: (session: string) => boolean; onError: (error: unknown) => string }) {
  return <><div className="status-summary panel"><div className={`status-summary-icon${health === 'offline' ? ' warning' : ''}`}><Activity size={25} /></div><div><h2>{health === 'online' ? '服务连接正常' : health === 'checking' ? '正在确认服务状态' : '服务暂时无法连接'}</h2><p>{health === 'offline' ? '请检查网络，页面会自动尝试重新连接。' : '此页展示最近一次获取的实际运行记录。'}</p></div><Badge dot tone={health === 'online' ? 'green' : 'amber'}>{health === 'online' ? '在线' : health === 'checking' ? '检测中' : '连接异常'}</Badge></div>
    <div className="status-grid"><section className="panel status-panel"><div className="panel-heading"><span className="section-icon"><RefreshCw size={18} /></span><h2>版本检查</h2></div><dl className="status-list"><div><dt>最近调度</dt><dd>{formatDate(status.lastCronAt, '等待首次调度')}</dd></div><div><dt>运行中的订阅</dt><dd>{status.activeSubscriptions} <span className="muted">个</span></dd></div><div><dt>关注的项目</dt><dd>{status.projectCount} <span className="muted">个</span></dd></div><div><dt>默认检查间隔</dt><dd>{status.intervalMinutes} 分钟</dd></div><div><dt>检查异常的项目</dt><dd><Badge tone={status.errorProjects ? 'red' : 'green'}>{status.errorProjects} 个</Badge></dd></div></dl></section>
    <section className="panel status-panel"><div className="panel-heading"><span className="section-icon"><Send size={18} /></span><h2>通知发送</h2></div><dl className="status-list"><div><dt>最近发送</dt><dd>{formatDate(status.lastDeliveryAt, '尚无发送记录')}</dd></div><div><dt>已发送</dt><dd>{status.sentDeliveries} <span className="muted">条</span></dd></div><div><dt>等待发送</dt><dd>{status.pendingDeliveries} <span className="muted">条</span></dd></div><div><dt>发送失败</dt><dd><Badge tone={status.failedDeliveries ? 'red' : 'neutral'}>{status.failedDeliveries} 条</Badge></dd></div></dl><button className="button button-secondary retry-button" disabled={retrying || !status.failedDeliveries || !status.telegramConfigured || !status.telegramBound} onClick={onRetry}><RefreshCw size={15} className={retrying ? 'spin' : ''} />{retrying ? '正在提交…' : '重试失败通知'}</button>{!!status.failedDeliveries && (!status.telegramConfigured || !status.telegramBound) && <p className="field-hint">请先完成 Telegram 接入和绑定。</p>}</section></div>
    <h2 className="subheading">接入服务<span>INTEGRATIONS</span></h2><div className="integrations"><section className="panel integration-card"><div className="integration-logo github-logo"><Github size={27} /></div><div className="integration-main"><div className="integration-heading"><h3>GitHub</h3><Badge dot tone={status.githubConfigured ? 'green' : 'amber'}>{status.githubConfigured ? '已配置' : '未配置访问令牌'}</Badge></div><p>从 GitHub Releases 获取你关注的版本更新。</p><div className="integration-note">{status.githubConfigured ? '已配置访问令牌，检查任务将使用认证请求。' : '配置 GitHub 访问令牌后即可开始检查。公开项目只需读取权限，请联系服务管理员完成配置。'}</div></div></section>
    <section className="panel integration-card"><div className="integration-logo telegram-logo"><Send size={25} /></div><div className="integration-main"><div className="integration-heading"><h3>Telegram</h3><Badge dot tone={status.telegramConfigured && status.telegramBound && status.webhookConfigured ? 'green' : 'amber'}>{!status.telegramConfigured ? '未配置' : !status.telegramBound ? '待绑定' : !status.webhookConfigured ? '待接入' : '已就绪'}</Badge></div><p>新版本发布时，向已绑定会话发送通知。</p><div className="integration-checks"><span><span className={`check-dot${status.telegramConfigured ? ' complete' : ''}`} />机器人配置{status.telegramConfigured ? '完成' : '待完成'}</span><span><span className={`check-dot${status.webhookConfigured ? ' complete' : ''}`} />消息接入{status.webhookConfigured ? '完成' : '待完成'}</span><span><span className={`check-dot${status.telegramBound ? ' complete' : ''}`} />通知目标{status.telegramBound ? '已绑定' : '待绑定'}</span></div></div></section></div>
    <h2 className="subheading">中文摘要<span>DEEPSEEK</span></h2>
    <DeepSeekSettings token={token} signal={signal} isSessionCurrent={isSessionCurrent} onError={onError} />
    <section className="binding-guide">
      <div className="guide-icon"><CircleHelp size={22} /></div>
      <div>
        <h3>如何接收 Telegram 通知？</h3>
        <p>在 Telegram 中打开你的机器人，使用管理员允许的账户，在私聊中发送 <code>/start</code>。收到绑定成功的回复后，刷新本页即可查看绑定状态。此服务仅支持单管理员私聊，不支持群组。</p>
        <p>绑定后，新建订阅会自动使用该会话，无需在网页填写会话编号。如果机器人尚未接入，请联系管理员完成机器人配置。管理访问口令仅用于网页登录。</p>
      </div>
    </section>
  </>;
}

function PublicStatusPage({ status, health }: { status: PublicStatusData; health: 'checking' | 'online' | 'offline' }) {
  return <>
    <div className="status-summary panel"><div className={`status-summary-icon${health === 'offline' ? ' warning' : ''}`}><Activity size={25} /></div><div><h2>{health === 'online' ? '服务连接正常' : health === 'checking' ? '正在确认服务状态' : '服务暂时无法连接'}</h2><p>{health === 'offline' ? '当前展示上次成功获取的记录，页面会自动尝试重新连接。' : '这里展示分享项目最近一次获取的检查记录。'}</p></div><Badge dot tone={health === 'online' ? 'green' : 'amber'}>{health === 'online' ? '在线' : health === 'checking' ? '检测中' : '连接异常'}</Badge></div>
    <section className="panel status-panel public-status-panel"><div className="panel-heading"><span className="section-icon"><RefreshCw size={18} /></span><h2>项目检查概览</h2></div><dl className="status-list"><div><dt>最近调度</dt><dd>{formatDate(status.lastCronAt, '等待首次调度')}</dd></div><div><dt>分享项目</dt><dd>{status.projectCount} 个</dd></div><div><dt>正在关注</dt><dd>{status.activeSubscriptions} 个</dd></div><div><dt>默认检查间隔</dt><dd>{status.intervalMinutes} 分钟</dd></div><div><dt>检查异常的项目</dt><dd><Badge tone={status.errorProjects ? 'amber' : 'green'}>{status.errorProjects} 个</Badge></dd></div></dl></section>
    <div className="subscription-tip public-note"><span><Eye size={18} /></span><p>这里公开展示项目与版本检查进展，内容会定期更新。</p></div>
  </>;
}

function PublicBrowser({ onManage }: { onManage: () => void }) {
  const [data, setData] = useState<PublicDashboardData | null>(null);
  const [page, setPage] = useState<Page>('subscriptions');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (controller.current && !controller.current.signal.aborted) return;
    const requestController = new AbortController();
    controller.current = requestController;
    const requestSequence = ++sequence.current;
    setLoading(true);
    try {
      const dashboard = await api.publicDashboard(requestController.signal);
      if (requestController.signal.aborted || requestSequence !== sequence.current) return;
      setData(dashboard); setError(''); setHealth('online'); setLastRefreshed(new Date());
    } catch (cause) {
      if (requestController.signal.aborted || requestSequence !== sequence.current) return;
      setHealth('offline');
      setError(cause instanceof ApiRequestError && cause.status !== 401 ? cause.message : '暂时无法获取分享项目，请稍后刷新重试。');
    } finally {
      if (requestSequence === sequence.current) { controller.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => { ++sequence.current; controller.current?.abort(); window.clearInterval(interval); };
  }, [refresh]);
  useEffect(() => {
    setMobileOpen(false);
    document.title = `${publicPages.find(item => item.id === page)?.label ?? ''} · Release Watch`;
  }, [page]);
  const currentPage = publicPages.find(item => item.id === page)!;
  const subscriptions = data?.subscriptions ?? [];
  const filteredSubscriptions = subscriptions.filter(sub => sub.repo.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'active' ? !sub.paused : sub.paused)));
  const activeCount = subscriptions.filter(sub => !sub.paused).length;
  const pendingCount = subscriptions.filter(sub => !sub.initialized).length;
  const issueCount = subscriptions.filter(sub => !!sub.error).length;
  return <div className="app-shell public-shell"><a className="skip-link" href="#main-content">跳转到主要内容</a>
    <aside className="sidebar"><Brand light /><div className="sidebar-label">公开浏览</div><nav aria-label="主要导航">{publicPages.map(item => { const Icon = item.icon; return <button key={item.id} className={`nav-item${page === item.id ? ' active' : ''}`} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined}><Icon size={19} /><span>{item.label}</span>{item.id === 'subscriptions' && data && <span className="nav-count">{subscriptions.length}</span>}{item.id === 'status' && issueCount > 0 && <span className="nav-alert" />}</button>; })}</nav><div className="sidebar-bottom"><div className="sidebar-note"><span className="sidebar-note-icon"><Radio size={21} /></span><strong>一起关注开源进展</strong><p>浏览分享项目，<br />发现值得关注的更新。</p><span>STAY CURIOUS. STAY UPDATED.</span></div><div className="sidebar-footer"><span className={`service-dot${health === 'online' ? ' online' : ''}`} /><span>{health === 'online' ? '服务连接正常' : health === 'offline' ? '连接异常' : '正在连接服务'}</span></div></div></aside>
    <div className="app-body"><header className="topbar"><div className="desktop-breadcrumb"><span>公开浏览</span><ChevronRight size={14} /><strong>{currentPage.label}</strong></div><div className="mobile-brand"><Radio size={23} /><strong>Release Watch</strong></div><div className="topbar-actions"><span className="private-label"><Eye size={14} /> 只读浏览</span><button className="button button-secondary manage-login" onClick={onManage}><KeyRound size={15} />管理员登录</button><button className="icon-button mobile-menu-button" aria-label={mobileOpen ? '关闭导航' : '打开导航'} aria-expanded={mobileOpen} aria-controls="mobile-navigation" onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X size={22} /> : <Menu size={22} />}</button></div></header>
      {mobileOpen && <nav id="mobile-navigation" className="mobile-navigation" aria-label="移动导航" onKeyDown={event => { if (event.key === 'Escape') { setMobileOpen(false); document.querySelector<HTMLButtonElement>('.mobile-menu-button')?.focus(); } }}>{publicPages.map(item => <button key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => { setPage(item.id); setMobileOpen(false); window.requestAnimationFrame(() => document.getElementById('main-content')?.focus()); }}>{item.label}</button>)}</nav>}
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading"><div><div className="eyebrow">{page === 'subscriptions' ? 'OPEN SOURCE RADAR' : page === 'timeline' ? 'RELEASE TIMELINE' : 'SYSTEM OVERVIEW'}</div><h1>{currentPage.label}<span className="heading-dot">.</span></h1><p>{currentPage.subtitle}</p></div><div className="heading-actions"><button className="button button-secondary refresh-button" disabled={loading} onClick={() => void refresh()} aria-label="刷新页面数据"><RefreshCw size={16} className={loading ? 'spin' : ''} /><span>刷新</span></button></div></div>
        {error && <div className="error-banner" role="alert"><TriangleAlert size={18} /><div><strong>数据更新失败</strong><p>{error}{data ? ' 当前展示上次成功获取的数据。' : ''}</p></div><button className="button button-secondary" disabled={loading} onClick={() => void refresh()}>重试</button></div>}
        {!data ? <div className="panel initial-loading" role="status">{loading ? <><LoaderCircle size={27} className="spin" /><h2>正在获取分享项目</h2><p>正在读取项目与版本记录…</p></> : <EmptyState icon={TriangleAlert} title="暂时无法加载数据" description="请确认网络连接，然后点击刷新重试。" />}</div> : <>
          {page === 'subscriptions' && <>
            <section className="stats-grid" aria-label="分享项目概览"><div className="stat-card"><div className="stat-top"><span>分享项目</span><FolderGit2 size={18} /></div><div className="stat-value">{subscriptions.length}<span>个项目</span></div><div className="stat-caption">值得关注的项目，汇聚于此</div></div><div className="stat-card"><div className="stat-top"><span>正在关注</span><Radio size={18} /></div><div className="stat-value">{activeCount}<span>个项目</span></div><div className="stat-caption">{subscriptions.length - activeCount} 个项目已暂停检查</div></div><div className="stat-card"><div className="stat-top"><span>等待首次记录</span><Clock3 size={18} /></div><div className="stat-value">{pendingCount}<span>个项目</span></div><div className="stat-caption">版本记录将在检查后更新</div></div><div className={`stat-card${issueCount ? ' stat-warning' : ''}`}><div className="stat-top"><span>检查异常</span><TriangleAlert size={18} /></div><div className="stat-value">{issueCount}<span>个项目</span></div><div className="stat-caption">{issueCount ? '检查暂时异常，请稍后查看' : '目前没有检查异常'}</div></div></section>
            <section className="subscriptions-section" aria-labelledby="subscriptions-title"><div className="section-title-row"><div><h2 id="subscriptions-title">分享项目<span>{subscriptions.length}</span></h2><p>项目与版本记录公开可见，欢迎随时浏览。</p></div><span className="auto-refresh"><span className="small-dot" />每 30 秒自动更新</span></div><div className="section-toolbar"><div className="search-input"><Search size={18} /><input type="search" aria-label="搜索分享项目" placeholder="搜索仓库名称…" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="filter-tabs" aria-label="项目状态">{[{ id: 'all', label: '全部' }, { id: 'active', label: '关注中' }, { id: 'paused', label: '已暂停' }].map(item => <button key={item.id} className={filter === item.id ? 'selected' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div></div>
              {!filteredSubscriptions.length ? <div className="panel"><EmptyState title={subscriptions.length ? '没有找到匹配的项目' : '暂无分享项目'} description={subscriptions.length ? '调整搜索关键词或切换筛选，看看其他项目。' : '分享项目后，最新版本与发布记录会展示在这里。'} /></div> : <div className="subscription-grid">{filteredSubscriptions.map(sub => <SubscriptionCard key={sub.id} subscription={sub} />)}</div>}
            </section><div className="subscription-tip public-note"><span><Eye size={18} /></span><p><strong>开源进展，一起关注。</strong> 这里展示分享项目的最新版本与发布记录，页面会自动更新。</p></div>
          </>}
          {page === 'timeline' && <Timeline releases={data.releases} publicView />}
          {page === 'status' && <PublicStatusPage status={data.status} health={health} />}
        </>}
        <footer className="content-footer"><span>Release Watch <span className="footer-separator">/</span> 专注每一次有价值的更新</span><span>{lastRefreshed ? `数据更新于 ${lastRefreshed.toLocaleTimeString('zh-CN', { hour12: false })}` : '等待获取数据'}</span></footer>
      </main>
    </div>
  </div>;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } });
  const [showLogin, setShowLogin] = useState(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [page, setPage] = useState<Page>('subscriptions');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [modalError, setModalError] = useState('');
  const [modalBusy, setModalBusy] = useState(false);
  const [busyProjects, setBusyProjects] = useState<Set<number>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const activeToken = useRef(token);
  const sessionVersion = useRef(0);
  const pendingProjects = useRef(new Set<number>());
  const refreshSequence = useRef(0);
  const dashboardController = useRef<AbortController | null>(null);
  const loginController = useRef<AbortController | null>(null);
  const mutationController = useRef(new AbortController());
  const dashboardPending = useRef(false);
  const retryLock = useRef(false);
  const modalTrigger = useRef<HTMLElement | null>(null);
  const modalLock = useRef(false);
  const initialDashboard = useRef<DashboardData | null>(null);
  activeToken.current = token;

  const logout = useCallback((message = '') => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* The in-memory session is also cleared. */ }
    activeToken.current = null;
    ++sessionVersion.current;
    pendingProjects.current.clear();
    retryLock.current = false;
    modalLock.current = false;
    setBusyProjects(new Set()); setRetrying(false); setModalBusy(false);
    dashboardController.current?.abort();
    loginController.current?.abort();
    mutationController.current.abort();
    dashboardPending.current = false;
    ++refreshSequence.current;
    initialDashboard.current = null;
    setShowLogin(false); setPage('subscriptions'); setQuery(''); setFilter('all');
    modalTrigger.current = null;
    setToken(null); setData(null); setLoginMessage(message); setModal(null); setModalError(''); setNotice(null); setRefreshError(''); setMobileOpen(false); setLastRefreshed(null); setLoading(false); setHealth('checking');
  }, []);

  const handleError = useCallback((error: unknown): string => {
    const text = error instanceof Error ? error.message : '操作未完成，请重试。';
    if (error instanceof ApiRequestError && error.status === 401) logout(text);
    return text;
  }, [logout]);

  // 子组件用它丢弃注销、切换会话后才返回的迟到响应，避免写入已失效的界面状态。
  const isSessionCurrent = useCallback((session: string) => activeToken.current === session, []);

  const refresh = useCallback(async (signal?: AbortSignal, force = false) => {
    if (!token || activeToken.current !== token || signal?.aborted) return;
    if (dashboardPending.current && !dashboardController.current?.signal.aborted && !force) return;
    dashboardController.current?.abort();
    const controller = new AbortController();
    dashboardController.current = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const sequence = ++refreshSequence.current;
    const version = sessionVersion.current;
    dashboardPending.current = true;
    setLoading(true);
    try {
      const dashboard = await api.dashboard(token, controller.signal);
      if (activeToken.current !== token || version !== sessionVersion.current || controller.signal.aborted || sequence !== refreshSequence.current) return;
      setData(dashboard); setRefreshError(''); setLastRefreshed(new Date());
    } catch (error) {
      if (controller.signal.aborted || activeToken.current !== token || version !== sessionVersion.current || sequence !== refreshSequence.current) return;
      const text = handleError(error);
      if (!(error instanceof ApiRequestError && error.status === 401)) setRefreshError(text);
    } finally {
      signal?.removeEventListener('abort', abort);
      if (sequence === refreshSequence.current) {
        dashboardPending.current = false;
        if (activeToken.current === token) setLoading(false);
      }
    }
  }, [token, handleError]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const version = sessionVersion.current;
    if (initialDashboard.current) { setData(initialDashboard.current); initialDashboard.current = null; setLoading(false); }
    else void refresh(controller.signal);
    async function checkHealth() {
      try { const response = await api.health(controller.signal); if (!controller.signal.aborted && activeToken.current === token && version === sessionVersion.current) setHealth(response.ok ? 'online' : 'offline'); }
      catch { if (!controller.signal.aborted && activeToken.current === token && version === sessionVersion.current) setHealth('offline'); }
    }
    void checkHealth();
    const interval = window.setInterval(() => { void refresh(controller.signal); void checkHealth(); }, 30_000);
    return () => { controller.abort(); dashboardController.current?.abort(); window.clearInterval(interval); };
  }, [token, refresh]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), notice.kind === 'error' ? 12_000 : 6_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    setMobileOpen(false);
    if (token) document.title = `${pages.find(item => item.id === page)?.label ?? ''} · Release Watch`;
  }, [page, token]);

  async function login(value: string) {
    loginController.current?.abort();
    const controller = new AbortController();
    loginController.current = controller;
    const version = ++sessionVersion.current;
    let dashboard: DashboardData;
    try { dashboard = await api.dashboard(value, controller.signal); }
    catch (error) {
      if (controller.signal.aborted || version !== sessionVersion.current) return;
      throw error;
    }
    if (controller.signal.aborted || version !== sessionVersion.current) return;
    try { sessionStorage.setItem(SESSION_KEY, value); }
    catch { throw new Error('浏览器无法保存会话，请允许此站点使用会话存储后重试。'); }
    mutationController.current = new AbortController();
    activeToken.current = value;
    initialDashboard.current = dashboard;
    setData(dashboard); setLastRefreshed(new Date()); setLoginMessage(''); setRefreshError(''); setShowLogin(false); setToken(value);
  }

  async function projectAction(sub: SubscriptionView, action: 'check' | 'toggle') {
    if (!token || activeToken.current !== token || pendingProjects.current.has(sub.projectId)) return;
    const session = token;
    const version = sessionVersion.current;
    pendingProjects.current.add(sub.projectId); setBusyProjects(new Set(pendingProjects.current));
    try {
      if (action === 'check') {
        const summary = await api.check(session, sub.projectId, mutationController.current.signal);
        if (activeToken.current !== session || version !== sessionVersion.current) return;
        setNotice({ kind: summary.errors ? 'error' : 'success', text: summary.errors ? `检查完成，${summary.errors} 个项目检查失败。请查看订阅错误详情。` : summary.discovered ? `检查完成，发现 ${summary.discovered} 个新版本。` : `已完成 ${summary.checked} 个项目检查，暂无新版本。` });
      } else {
        await api.updateSubscription(session, sub.id, { paused: !sub.paused }, mutationController.current.signal);
        if (activeToken.current !== session || version !== sessionVersion.current) return;
        setNotice({ kind: 'success', text: `${sub.repo} 已${sub.paused ? '恢复' : '暂停'}订阅。` });
      }
      await refresh(undefined, true);
    } catch (error) {
      if (activeToken.current === session && version === sessionVersion.current) {
        const text = handleError(error);
        if (!(error instanceof ApiRequestError && error.status === 401)) setNotice({ kind: 'error', text });
      }
    } finally {
      if (version === sessionVersion.current) {
        pendingProjects.current.delete(sub.projectId); setBusyProjects(new Set(pendingProjects.current));
      }
    }
  }

  function openModal(value: ModalState) {
    if (!activeToken.current) return;
    modalTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setModalError(''); setModal(value);
  }

  async function saveSubscription(input?: SubscriptionInput) {
    if (!token || activeToken.current !== token || !modal || modalLock.current) return;
    const session = token;
    const version = sessionVersion.current;
    modalLock.current = true; setModalBusy(true); setModalError('');
    try {
      let text: string;
      if (modal.kind === 'delete') { await api.deleteSubscription(session, modal.subscription.id, mutationController.current.signal); text = `已删除 ${modal.subscription.repo} 的订阅。`; }
      else if (modal.kind === 'edit' && input) {
        // 封面随保存一并提交：表单留空即 null，后端据此移除自定义封面。
        const patch: SubscriptionPatch = { includePrerelease: input.includePrerelease, intervalMinutes: input.intervalMinutes, coverUrl: input.coverUrl };
        await api.updateSubscription(session, modal.subscription.id, patch, mutationController.current.signal); text = '订阅设置已保存。';
      } else if (input) { await api.addSubscription(session, input, mutationController.current.signal); text = '订阅已添加，首次检查将建立版本基线。'; }
      else return;
      if (activeToken.current !== session || version !== sessionVersion.current) return;
      setModal(null); setNotice({ kind: 'success', text });
      await refresh(undefined, true);
    } catch (error) {
      if (activeToken.current === session && version === sessionVersion.current) {
        const text = handleError(error);
        if (!(error instanceof ApiRequestError && error.status === 401)) setModalError(text);
      }
    } finally {
      if (version === sessionVersion.current) { modalLock.current = false; setModalBusy(false); }
    }
  }

  async function retryDeliveries() {
    if (!token || activeToken.current !== token || retryLock.current) return;
    const session = token;
    const version = sessionVersion.current;
    retryLock.current = true; setRetrying(true);
    try {
      await api.retryDeliveries(session, mutationController.current.signal);
      if (activeToken.current !== session || version !== sessionVersion.current) return;
      setNotice({ kind: 'success', text: '失败通知已加入重试队列，将由后续发送任务处理。' }); await refresh(undefined, true);
    } catch (error) {
      if (activeToken.current === session && version === sessionVersion.current) {
        const text = handleError(error);
        if (!(error instanceof ApiRequestError && error.status === 401)) setNotice({ kind: 'error', text });
      }
    } finally {
      if (version === sessionVersion.current) { retryLock.current = false; setRetrying(false); }
    }
  }

  if (!token) return showLogin
    ? <Login message={loginMessage} onLogin={login} onBrowse={() => logout()} />
    : <PublicBrowser onManage={() => setShowLogin(true)} />;
  const currentPage = pages.find(item => item.id === page)!;
  const subscriptions = data?.subscriptions ?? [];
  const filteredSubscriptions = subscriptions.filter(sub => sub.repo.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'active' ? !sub.paused : sub.paused)));
  const activeCount = subscriptions.filter(sub => !sub.paused).length;
  const pendingCount = subscriptions.filter(sub => !sub.initialized).length;
  const issueCount = subscriptions.filter(sub => !!sub.error).length;

  return <div className="app-shell"><a className="skip-link" href="#main-content">跳转到主要内容</a>
    <aside className="sidebar"><Brand light /><div className="sidebar-label">工作空间</div><nav aria-label="主要导航">{pages.map(item => { const Icon = item.icon; return <button key={item.id} className={`nav-item${page === item.id ? ' active' : ''}`} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined}><Icon size={19} /><span>{item.label}</span>{item.id === 'subscriptions' && data && <span className="nav-count">{subscriptions.length}</span>}{item.id === 'status' && data && (data.status.failedDeliveries > 0 || issueCount > 0) && <span className="nav-alert" />}</button>; })}</nav><div className="sidebar-bottom"><div className="sidebar-note"><span className="sidebar-note-icon"><Radio size={21} /></span><strong>你的开源版本雷达</strong><p>少一点反复查看，<br />多一点专注创造。</p><span>STAY CURIOUS. STAY UPDATED.</span></div><div className="sidebar-footer"><span className={`service-dot${health === 'online' ? ' online' : ''}`} /><span>{health === 'online' ? '服务连接正常' : health === 'offline' ? '连接异常' : '正在连接服务'}</span><button className="sidebar-logout" aria-label="退出登录" title="退出登录" onClick={() => logout()}><LogOut size={17} /></button></div></div></aside>
    <div className="app-body"><header className="topbar"><div className="desktop-breadcrumb"><span>工作空间</span><ChevronRight size={14} /><strong>{currentPage.label}</strong></div><div className="mobile-brand"><Radio size={23} /><strong>Release Watch</strong></div><div className="topbar-actions"><span className="private-label"><ShieldCheck size={14} /> 私有控制台</span><button className="icon-button desktop-logout" title="退出登录" aria-label="退出登录" onClick={() => logout()}><LogOut size={17} /></button><button className="icon-button mobile-menu-button" aria-label={mobileOpen ? '关闭导航' : '打开导航'} aria-expanded={mobileOpen} aria-controls="mobile-navigation" onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X size={22} /> : <Menu size={22} />}</button></div></header>
      {mobileOpen && <nav
        id="mobile-navigation" className="mobile-navigation" aria-label="移动导航"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setMobileOpen(false);
            document.querySelector<HTMLButtonElement>('.mobile-menu-button')?.focus();
          }
        }}
      >
        {pages.map(item => <button
          key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined}
          onClick={() => {
            setPage(item.id); setMobileOpen(false);
            window.requestAnimationFrame(() => document.getElementById('main-content')?.focus());
          }}
        >{item.label}</button>)}
        <button onClick={() => logout()}><LogOut size={15} />退出登录</button>
      </nav>}
      <main id="main-content" className="main-content" tabIndex={-1}><div className="page-heading"><div><div className="eyebrow">{page === 'subscriptions' ? 'YOUR RELEASE RADAR' : page === 'timeline' ? 'RELEASE TIMELINE' : 'SYSTEM OVERVIEW'}</div><h1>{currentPage.label}<span className="heading-dot">.</span></h1><p>{currentPage.subtitle}</p></div><div className="heading-actions"><button className="button button-secondary refresh-button" disabled={loading} onClick={() => void refresh()} aria-label="刷新页面数据"><RefreshCw size={16} className={loading ? 'spin' : ''} /><span>刷新</span></button>{page === 'subscriptions' && <button className="button button-primary" onClick={() => openModal({ kind: 'add' })}><Plus size={17} />添加订阅</button>}</div></div>
      {refreshError && <div className="error-banner" role="alert"><TriangleAlert size={18} /><div><strong>数据更新失败</strong><p>{refreshError}{data ? ' 当前展示上次成功获取的数据。' : ''}</p></div><button className="button button-secondary" disabled={loading} onClick={() => void refresh()}>重试</button></div>}
      {!data ? <div className="panel initial-loading" role="status">{loading ? <><LoaderCircle size={27} className="spin" /><h2>正在连接你的版本雷达</h2><p>正在获取订阅与运行记录…</p></> : <EmptyState icon={TriangleAlert} title="暂时无法加载数据" description="请确认网络连接，然后点击刷新重试。" />}</div> : <>
      {page === 'subscriptions' && <><section className="stats-grid" aria-label="订阅概览"><div className="stat-card"><div className="stat-top"><span>全部订阅</span><FolderGit2 size={18} /></div><div className="stat-value">{subscriptions.length}<span>个项目</span></div><div className="stat-caption">把重要的项目，放在一起</div></div><div className="stat-card"><div className="stat-top"><span>正在关注</span><Radio size={18} /></div><div className="stat-value">{activeCount}<span className="stat-status"><span className="small-dot" />运行中</span></div><div className="stat-caption">{subscriptions.length - activeCount} 个订阅已暂停</div></div><div className="stat-card"><div className="stat-top"><span>待建立基线</span><Clock3 size={18} /></div><div className="stat-value">{pendingCount}<span>个项目</span></div><div className="stat-caption">首次检查后开始追踪更新</div></div><div className={`stat-card${issueCount ? ' stat-warning' : ''}`}><div className="stat-top"><span>需要关注</span><TriangleAlert size={18} /></div><div className="stat-value">{issueCount}<span>个异常</span></div><div className="stat-caption">{issueCount ? '查看订阅卡片中的错误详情' : '目前没有检查异常'}</div></div></section>
      <section className="subscriptions-section" aria-labelledby="subscriptions-title"><div className="section-title-row"><div><h2 id="subscriptions-title">我的订阅<span>{subscriptions.length}</span></h2><p>你关心的项目，每个新版本都有迹可循。</p></div><span className="auto-refresh"><span className="small-dot" />每 30 秒自动更新</span></div><div className="section-toolbar"><div className="search-input"><Search size={18} /><input type="search" aria-label="搜索订阅仓库" placeholder="搜索仓库名称…" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="filter-tabs" aria-label="订阅状态">{[{ id: 'all', label: '全部' }, { id: 'active', label: '订阅中' }, { id: 'paused', label: '已暂停' }].map(item => <button key={item.id} className={filter === item.id ? 'selected' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div></div>
      {!filteredSubscriptions.length ? <div className="panel"><EmptyState title={subscriptions.length ? '没有找到匹配的订阅' : '从一个好项目开始'} description={subscriptions.length ? '调整搜索关键词或切换筛选，找到你关注的项目。' : '添加 GitHub 仓库，让下一次重要发布主动找到你。'}>{!subscriptions.length && <button className="button button-primary" onClick={() => openModal({ kind: 'add' })}><Plus size={17} />添加第一个订阅</button>}</EmptyState></div> : <div className="subscription-grid">{filteredSubscriptions.map(sub => <SubscriptionCard key={sub.id} subscription={sub} actions={{ busy: busyProjects.has(sub.projectId), onEdit: () => openModal({ kind: 'edit', subscription: sub }), onDelete: () => openModal({ kind: 'delete', subscription: sub }), onToggle: () => void projectAction(sub, 'toggle'), onCheck: () => void projectAction(sub, 'check') }} />)}</div>}</section><div className="subscription-tip"><span><BellRing size={18} /></span><p><strong>让更新主动找到你。</strong> 绑定 Telegram 后，新版本通知会自动送达。</p><button className="text-link" onClick={() => setPage('status')}>查看接入状态<ArrowRight size={15} /></button></div></>}
      {page === 'timeline' && <Timeline releases={data.releases} />}
      {page === 'status' && <StatusPage status={data.status} health={health} retrying={retrying} onRetry={() => void retryDeliveries()} token={token} signal={mutationController.current.signal} isSessionCurrent={isSessionCurrent} onError={handleError} />}
      </>}
      <footer className="content-footer"><span>Release Watch <span className="footer-separator">/</span> 专注每一次有价值的更新</span><span>{lastRefreshed ? `数据更新于 ${lastRefreshed.toLocaleTimeString('zh-CN', { hour12: false })}` : '等待获取数据'}</span></footer></main></div>
    <div className="toast-region" aria-live="polite" aria-atomic="true">{notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <CheckCircle2 size={20} /> : <TriangleAlert size={20} />}<span>{notice.text}</span><button className="icon-button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={17} /></button></div>}</div>
    {modal && <Dialog
      title={modal.kind === 'add' ? '添加订阅' : modal.kind === 'edit' ? '订阅设置' : '删除这个订阅？'}
      description={modal.kind === 'add' ? '关注一个项目，让重要更新及时抵达。' : modal.kind === 'edit' ? '按你的节奏，关注项目更新。' : '删除后将停止追踪此仓库。你可以随时重新添加。'}
      busy={modalBusy} returnFocusTo={modalTrigger.current}
      onClose={() => { if (!modalBusy) setModal(null); }}
    >
      {modal.kind === 'delete' ? <div className="delete-dialog">
        <div className="delete-repo"><Github size={20} /><strong>{modal.subscription.repo}</strong></div>
        {modalError && <div className="inline-error" role="alert">{modalError}</div>}
        <div className="dialog-actions">
          <button className="button button-secondary" disabled={modalBusy} autoFocus onClick={() => setModal(null)}>保留订阅</button>
          <button className="button button-danger" disabled={modalBusy} onClick={() => void saveSubscription()}>
            {modalBusy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}{modalBusy ? '正在删除…' : '确认删除'}
          </button>
        </div>
      </div> : <SubscriptionForm
        key={modal.kind === 'edit' ? modal.subscription.id : 'add'}
        subscription={modal.kind === 'edit' ? modal.subscription : undefined}
        busy={modalBusy} error={modalError}
        onSave={input => void saveSubscription(input)} onClose={() => setModal(null)}
      />}
    </Dialog>}
  </div>;
}
