export interface SubscriptionView {
  id: number; projectId: number; repo: string; coverUrl: string | null; includePrerelease: boolean;
  intervalMinutes: number; paused: boolean; chatId: string | null; createdAt: string;
  latestTag: string | null; latestUrl: string | null; lastCheckedAt: string | null;
  lastSuccessAt: string | null; nextCheckAt: string; error: string | null; errorCount: number;
  initialized: boolean;
}
export interface ReleaseView {
  id: number; projectId: number; repo: string; tag: string; name: string;
  url: string; body: string; prerelease: boolean; publishedAt: string; discoveredAt: string;
  deliveryStatus: 'pending' | 'sending' | 'sent' | 'failed' | null;
}
export interface StatusData {
  githubConfigured: boolean; telegramConfigured: boolean; telegramBound: boolean;
  webhookConfigured: boolean; lastCronAt: string | null; lastDeliveryAt: string | null;
  defaultChatId: string | null; pendingDeliveries: number; failedDeliveries: number;
  sentDeliveries: number; projectCount: number; activeSubscriptions: number;
  errorProjects: number; intervalMinutes: number;
}
export interface DashboardData { subscriptions: SubscriptionView[]; releases: ReleaseView[]; status: StatusData; }
export interface SubscriptionInput {
  repo: string; includePrerelease?: boolean; intervalMinutes?: number; chatId?: string | null;
  coverUrl?: string | null;
}
export interface SubscriptionPatch {
  includePrerelease?: boolean; intervalMinutes?: number; paused?: boolean; coverUrl?: string | null;
}
export interface CheckSummary { checked: number; discovered: number; errors: number; }
export interface DeliverySummary { sent: number; failed: number; }
export interface ApiError { error: string; }

/**
 * DeepSeek 中文摘要配置。只暴露布尔与来源信息，密钥本身永不出现在任何响应中。
 */
export interface DeepSeekSettings {
  configured: boolean;
  enabled: boolean;
  model: 'deepseek-chat';
  source: 'database' | 'environment' | null;
}
export interface DeepSeekSettingsResponse { deepseek: DeepSeekSettings; }
/** `apiKey: ''` 表示删除数据库中的密钥，回退到环境变量。 */
export interface DeepSeekSettingsInput { apiKey?: string; enabled?: boolean; }

export type PublicSubscriptionView = Pick<SubscriptionView,
  'id' | 'projectId' | 'repo' | 'coverUrl' | 'includePrerelease' | 'intervalMinutes' | 'paused' |
  'latestTag' | 'latestUrl' | 'lastCheckedAt' | 'lastSuccessAt' | 'nextCheckAt' | 'initialized'> & {
  error: string | null;
};
export type PublicReleaseView = Omit<ReleaseView, 'deliveryStatus'> & { coverUrl: string | null };
export type PublicStatusData = Pick<StatusData,
  'lastCronAt' | 'projectCount' | 'activeSubscriptions' | 'errorProjects' | 'intervalMinutes'>;
export interface PublicDashboardData {
  subscriptions: PublicSubscriptionView[];
  releases: PublicReleaseView[];
  status: PublicStatusData;
}
