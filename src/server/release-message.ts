import { markdownToTelegram, updateEmoji } from './telegram-markdown';
import { safeTelegramLink, TelegramTextBuilder, type TelegramText } from './telegram-text';

export interface ReleaseMessageInput {
  repo: string; tag: string; name: string; url: string; prerelease: number | boolean; published_at: string;
}

export function formatReleaseMessage(release: ReleaseMessageInput, changelog: string): TelegramText {
  const out = new TelegramTextBuilder();
  const icon = release.prerelease ? '🧪' : updateEmoji(changelog, '🚀');
  out.append(`${icon} ${release.prerelease ? '预发布更新' : '版本更新'}\n`, { type: 'bold' });
  const repoLink = safeTelegramLink(`https://github.com/${release.repo}`);
  out.append('📦 ').append(release.repo, repoLink ? { type: 'text_link', url: repoLink } : undefined).append('\n');
  out.append('🏷️ ').append(release.tag, { type: 'code' });
  if (release.name.trim() && release.name !== release.tag) out.append(` · ${release.name}`);
  out.append('\n');
  const published = Date.parse(release.published_at);
  if (Number.isFinite(published)) {
    const beijing = new Date(published + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
    out.append(`🕒 ${beijing} · 北京时间\n`);
  }
  const releaseLink = safeTelegramLink(release.url);
  out.append('🔗 ').append('查看发布详情', releaseLink ? { type: 'text_link', url: releaseLink } : undefined);
  if (changelog.trim()) {
    const summaryPrefix = '中文更新摘要（DeepSeek）\n';
    const summarized = changelog.startsWith(summaryPrefix);
    out.append('\n\n').append(summarized ? '📝 中文更新摘要 · DeepSeek' : '📝 更新日志', { type: 'bold' }).append('\n\n');
    out.append(markdownToTelegram(summarized ? changelog.slice(summaryPrefix.length) : changelog));
  }
  return out.build();
}
