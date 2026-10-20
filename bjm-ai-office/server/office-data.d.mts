type Count = number | null;
type Availability = 'available' | 'partial' | 'unavailable' | 'configuration_required' | 'authentication_required';
type Metadata = { source: string; configured: boolean; availability: Availability; reason: string | null; generated_at: string | null };
type Billing = Metadata & { subscriptions: { total: Count; active: Count; past_due: Count; canceling: Count }; payments: { recent: Count; failed: Count; refunded: Count }; window_days: number };
type Decision = { agent: string; severity: string; title: string; summary: string; protected: boolean };
type Health = { source: string; overall: 'healthy' | 'attention' | 'unavailable'; checks: Array<{ service: string; ok: boolean; status: string | number }> };
type Options = { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number; snapshotLoader?: () => Promise<unknown> };
export function createOfficeProviders(accessToken?: string, options?: Options): Readonly<{
  getLiveOverview(): Promise<Metadata & { metrics: { profiles: Count; cafes: Count; baristas: Count; jobs: Count; applications: Count; subscriptions: Count; payments: Count }; status: string }>;
  getSupportSummary(): Promise<Metadata & { total_recent: Count; open: Count; window_days: number }>;
  getBillingSummary(): Promise<Billing>;
  getSystemHealth(): Promise<Health>;
  getDecisionSignals(): Promise<Decision[]>;
}>;
