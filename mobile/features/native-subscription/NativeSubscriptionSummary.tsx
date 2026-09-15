import { Pressable, StyleSheet, Text, View } from 'react-native';
import { dashboardTheme as t } from '../approved-dashboard/theme';
import type { VerifiedSubscription } from './purchaseCoordinator';

/** Settings summary for the account-checked, server-verified billing response. */
export function NativeSubscriptionSummary({ subscription, error, opening, onPress }: {
  subscription: VerifiedSubscription; error: string; opening: boolean; onPress: () => void;
}) {
  const provider = subscription.provider === 'apple' ? 'Apple' : subscription.provider === 'google' ? 'Google Play' : 'Stripe';
  const paid = subscription.access === 'pro';
  const heading = subscription.status === 'pending' ? 'Purchase pending' : paid ? 'Pro · Active' : 'Free · Active · $0';
  let detail = paid ? `Your Pro access is verified through ${provider}.` : 'Your first job, matches, and interview messaging are included. A second job requires Pro.';
  if (subscription.status === 'grace') detail = `Your Pro access remains active while ${provider} retries payment. Review your payment method.`;
  if (subscription.status === 'payment_required') detail = 'Your subscription needs payment attention. Review your existing subscription before purchasing again.';
  if (subscription.status === 'pending') detail = 'A purchase is still being confirmed. Open Café plans to restore purchases or contact support.';
  return <View style={s.card}>
    <Text style={s.title}>Subscription</Text>
    <Text style={s.plan}>{error ? 'Status unavailable' : heading}</Text>
    <Text style={s.copy} accessibilityLiveRegion="polite">{error || detail}</Text>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: opening }} disabled={opening} onPress={onPress} style={[s.button, opening && s.disabled]}>
      <Text style={s.action}>{opening ? 'Opening…' : error ? 'Retry subscription status' : 'View plans and manage subscriptions'}</Text>
    </Pressable>
  </View>;
}
const s = StyleSheet.create({
  card: { padding: 18, borderWidth: 1, borderColor: t.border, borderRadius: 18, backgroundColor: t.surface, gap: 10 },
  title: { fontSize: 20, fontWeight: '600', color: t.ink }, plan: { fontSize: 17, fontWeight: '600', color: t.ink },
  copy: { fontSize: 16, lineHeight: 23, color: t.muted }, button: { minHeight: 48, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: t.border },
  action: { fontSize: 16, fontWeight: '600', color: t.accent }, disabled: { opacity: 0.5 },
});
