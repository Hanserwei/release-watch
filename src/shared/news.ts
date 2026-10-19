export const NEWS_CATEGORIES = {
  tool: '编程工具', model: 'AI 模型', security: '安全风险', insight: '行业洞察', opensource: '开源项目', practice: '开发实践',
} as const;
export type NewsCategory = keyof typeof NEWS_CATEGORIES;
export interface NewsArticle {
  title: string; url: string; summary: string; source: string; publishedAt: string;
  category: NewsCategory; importance: 'major' | 'normal';
}
export type NewsPhase = 'collecting' | 'filtering' | 'deduplicating' | 'ready' | 'sent' | 'empty';
export interface NewsDigestView {
  date: string; phase: NewsPhase; failed: boolean; error: string | null;
  sourceOffset: number; sourceFailures: number; candidateCount: number; filteredCount: number;
  scheduledAt: string; sentAt: string | null; articles: NewsArticle[];
}
export interface NewsDashboard {
  enabled: boolean; deepseekReady: boolean; telegramReady: boolean;
  time: '08:30'; timezone: 'Asia/Shanghai'; sourceCount: number;
  latest: NewsDigestView | null;
}
