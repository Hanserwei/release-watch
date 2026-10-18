import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Check, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, ShieldCheck,
  Sparkles, Trash2, TriangleAlert,
} from 'lucide-react';
import type { DeepSeekSettings as DeepSeekConfig, DeepSeekSettingsInput } from '../shared/types';
import { api, ApiRequestError } from './api';

type Pending = 'save' | 'toggle' | 'clear' | null;

/**
 * DeepSeek 中文摘要设置。
 *
 * 只通过共享 API 读写状态：保存与清除都走 PATCH /api/settings/deepseek，
 * 密钥仅存在于服务端，既不写入浏览器存储，也不会在保存后被回显。
 */
export default function DeepSeekSettings({ token, signal, isSessionCurrent, onError }: {
  token: string;
  signal: AbortSignal;
  isSessionCurrent: (session: string) => boolean;
  onError: (error: unknown) => string;
}) {
  const [status, setStatus] = useState<DeepSeekConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [formError, setFormError] = useState('');
  const [formNotice, setFormNotice] = useState('');
  const mounted = useRef(true);
  const lock = useRef(false);
  const loadController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; loadController.current?.abort(); };
  }, []);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    try {
      const next = await api.deepSeekSettings(token, controller.signal);
      if (controller.signal.aborted || !mounted.current || !isSessionCurrent(token)) return;
      setStatus(next); setLoadError('');
    } catch (error) {
      if (controller.signal.aborted || !mounted.current || !isSessionCurrent(token)) return;
      if (error instanceof ApiRequestError && error.status === 401) { onError(error); return; }
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLoadError(onError(error));
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }, [token, isSessionCurrent, onError]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(
    input: DeepSeekSettingsInput,
    kind: Exclude<Pending, null>,
    success: string | ((next: DeepSeekConfig) => string),
  ): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true;
    setPending(kind); setFormError(''); setFormNotice('');
    try {
      const next = await api.saveDeepSeekSettings(token, input, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
      if (!mounted.current || !isSessionCurrent(token)) return false;
      setStatus(next); setFormNotice(typeof success === 'string' ? success : success(next));
      return true;
    } catch (error) {
      if (!mounted.current || !isSessionCurrent(token)) return false;
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      if (error instanceof ApiRequestError && error.status === 401) { onError(error); return false; }
      setFormError(onError(error));
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function saveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    const key = apiKey.trim();
    if (!key) { setFormError('请输入新的 DeepSeek API Key。'); return; }
    if (key.length < 20 || /\s/.test(key)) { setFormError('DeepSeek 密钥应为不含空格的完整字符串，请重新复制。'); return; }
    const saved = await mutate(
      { apiKey: key }, 'save',
      status?.configured ? '密钥已更新，摘要将继续使用 deepseek-chat。' : '密钥已保存，摘要将使用 deepseek-chat。',
    );
    if (saved && mounted.current) { setApiKey(''); setVisible(false); }
  }

  async function toggleEnabled() {
    if (!status || lock.current || !status.configured) return;
    const enabled = !status.enabled;
    await mutate(
      { enabled }, 'toggle',
      enabled ? '已启用中文摘要，新版本通知将附带中文要点。' : '已暂停中文摘要，通知将直接附上发布说明原文。',
    );
  }

  async function clearKey() {
    if (!status?.configured || lock.current) return;
    const cleared = await mutate(
      { apiKey: '' }, 'clear',
      // 清除只删除后台保存的值；环境变量密钥仍可用时如实说明。
      next => next.configured
        ? '已清除后台保存的密钥，当前改用服务环境变量中的 DeepSeek 密钥。'
        : '已清除 DeepSeek 密钥，通知将直接附上发布说明原文。',
    );
    if (cleared && mounted.current) { setApiKey(''); setVisible(false); }
  }

  const busy = pending !== null;
  const configured = status?.configured ?? false;
  const badge = !configured
    ? { tone: 'neutral' as const, label: '未配置密钥' }
    : status?.enabled ? { tone: 'green' as const, label: '摘要已启用' } : { tone: 'amber' as const, label: '已配置 · 已暂停' };
  return <section className="panel deepseek-panel" aria-labelledby="deepseek-title" aria-busy={busy}>
    <div className="deepseek-head">
      <div className="integration-logo deepseek-logo"><Sparkles size={24} /></div>
      <div className="integration-main">
        <div className="integration-heading">
          <h3 id="deepseek-title">DeepSeek 中文摘要</h3>
          <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
        </div>
        <p>使用 <code>deepseek-chat</code> 把 GitHub 发布说明整理成中文要点，随 Telegram 通知一起发送。</p>
        <p className="deepseek-note"><ShieldCheck size={14} /> 摘要只是可选增强：调用失败、额度用尽或返回异常时，通知会直接附上发布说明原文；较长的原文会自动分段发送，内容不会缺失。</p>
      </div>
    </div>

    {loading && !status
      ? <div className="deepseek-loading" role="status"><LoaderCircle size={18} className="spin" />正在读取 DeepSeek 配置…</div>
      : loadError && !status
        ? <div className="inline-error" role="alert">
          <TriangleAlert size={17} /><span>{loadError}</span>
          <button type="button" className="button button-secondary deepseek-retry" disabled={loading} onClick={() => void load()}><RefreshCw size={14} className={loading ? 'spin' : ''} />重新读取</button>
        </div>
        : status && <>
          <dl className="deepseek-status">
            <div><dt>当前状态</dt><dd>{configured ? '已配置密钥' : '尚未配置密钥'}</dd></div>
            <div><dt>摘要模型</dt><dd>deepseek-chat</dd></div>
            <div><dt>密钥来源</dt><dd>{status.source === 'database' ? '后台保存' : status.source === 'environment' ? '服务环境变量' : '暂无'}</dd></div>
            <div><dt>启用状态</dt><dd>{status.enabled ? '已启用' : '已关闭'}</dd></div>
          </dl>

          <div className="deepseek-toggle">
            <div>
              <strong id="deepseek-enabled-label">启用中文摘要</strong>
              <span>{configured ? '关闭后通知只发送发布说明原文。' : '配置密钥后即可启用中文摘要。'}</span>
            </div>
            <button
              type="button" role="switch" aria-checked={status.enabled} aria-labelledby="deepseek-enabled-label"
              className={`switch${status.enabled ? ' switch-on' : ''}`} disabled={busy || !configured}
              onClick={() => void toggleEnabled()}
            >
              <span className="switch-knob">{pending === 'toggle' ? <LoaderCircle size={12} className="spin" /> : null}</span>
            </button>
          </div>

          <form className="deepseek-form" onSubmit={event => void saveKey(event)}>
            <div className="field">
              <label htmlFor="deepseek-key">{configured ? '填写新的 API Key（替换现有密钥）' : 'DeepSeek API Key'}</label>
              <div className="password-input">
                <input
                  id="deepseek-key" name="deepseek-key" type={visible ? 'text' : 'password'} value={apiKey}
                  onChange={event => { setApiKey(event.target.value); setFormError(''); setFormNotice(''); }}
                  placeholder={configured ? '输入新的密钥以替换现有配置' : '粘贴 DeepSeek API Key'}
                  autoComplete="off" spellCheck={false} disabled={busy}
                  aria-describedby="deepseek-key-hint" aria-invalid={!!formError}
                />
                <button type="button" disabled={busy} aria-label={visible ? '隐藏密钥' : '显示密钥'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
              </div>
              <span id="deepseek-key-hint" className="field-hint">密钥保存后不会回显。更换密钥时填写新值即可。</span>
            </div>
            <div className="deepseek-actions">
              <button type="submit" className="button button-primary" disabled={busy || !apiKey.trim()}>
                {pending === 'save' ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}
                {pending === 'save' ? '正在保存…' : '保存密钥'}
              </button>
              {configured && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void clearKey()}>
                {pending === 'clear' ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
                {pending === 'clear' ? '正在清除…' : '清除密钥'}
              </button>}
            </div>
          </form>

          {formError && <div className="inline-error" role="alert"><TriangleAlert size={17} /><span>{formError}</span></div>}
          {formNotice && <p className="deepseek-success" role="status"><Check size={15} />{formNotice}</p>}
        </>}
  </section>;
}
