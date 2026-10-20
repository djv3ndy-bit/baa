import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { dashboardTheme as t } from '../approved-dashboard/theme';
import type { VerifiedSubscription } from './purchaseCoordinator';
import { reviewerAccess, reviewerExpiryTimer } from './purchaseCoordinator';
import { androidReviewerAccessEnabled, checkedSubscription } from './nativeBillingClient';
import { getAppEnvironment } from '../review-mode/environment';

/** Settings summary for the account-checked, server-verified billing response. */
export function NativeSubscriptionSummary({ subscription, error, opening, onPress }: {
  subscription: VerifiedSubscription; error: string; opening: boolean; onPress: () => void;
}) {
  const reviewEnabled = Platform.OS === 'android' && androidReviewerAccessEnabled(Platform.OS, getAppEnvironment());
  const [, recheckExpiry] = useState(0);
  useEffect(() => {
    if (!reviewEnabled || !subscription.reviewAccess) return;
    return reviewerExpiryTimer(subscription.reviewAccess.expiresAt, () => recheckExpiry(value => value + 1));
  }, [reviewEnabled, subscription.reviewAccess?.expiresAt]);
  let invalidReview = false;
  if (subscription.reviewAccess !== undefined) {
    try { checkedSubscription(subscription, subscription.accountId, reviewEnabled); }
    catch { invalidReview = true; }
  }
  const statusError = error || (invalidReview ? 'Subscription status is unavailable.' : '');
  const review = invalidReview ? null : reviewerAccess(subscription, reviewEnabled);
  const provider = subscription.provider === 'apple' ? 'Apple' : subscription.provider === 'google' ? 'Google Play' : 'Stripe';
  const paid = subscription.access === 'pro';
  const heading = review ? 'Reviewer Pro access' : subscription.status === 'pending' ? 'Purchase pending' : paid ? 'Pro · Active' : 'Free · Active · $0';
  let detail = review ? `Temporary access for app review. No payment is required. Reviewer access ends ${new Date(review.expiresAt).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.`
    : paid ? `Your Pro access is verified through ${provider}.` : 'Your first job is free for 30 days. A second job or reopening an expired post requires Pro. Existing matches and interview messaging stay included.';
  if (!review && subscription.status === 'grace') detail = `Your Pro access remains active while ${provider} retries payment. Review your payment method.`;
  if (!review && subscription.status === 'payment_required') detail = 'Your subscription needs payment attention. Review your existing subscription before purchasing again.';
  if (!review && subscription.status === 'pending') detail = 'A purchase is still being confirmed. Open Café plans to restore purchases or contact support.';
  return <View style={s.card}>
    <Text style={s.title}>Subscription</Text>
    <Text style={s.plan}>{statusError ? 'Status unavailable' : heading}</Text>
    <Text style={s.copy} accessibilityLiveRegion="polite">{statusError || detail}</Text>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: opening }} disabled={opening} onPress={onPress} style={[s.button, opening && s.disabled]}>
      <Text style={s.action}>{opening ? 'Opening…' : statusError ? 'Retry subscription status' : 'View plans and manage subscriptions'}</Text>
    </Pressable>
  </View>;
}
const s = StyleSheet.create({
  card: { padding: 18, borderWidth: 1, borderColor: t.border, borderRadius: 18, backgroundColor: t.surface, gap: 10 },
  title: { fontSize: 20, fontWeight: '600', color: t.ink }, plan: { fontSize: 17, fontWeight: '600', color: t.ink },
  copy: { fontSize: 16, lineHeight: 23, color: t.muted }, button: { minHeight: 48, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: t.border },
  action: { fontSize: 16, fontWeight: '600', color: t.accent }, disabled: { opacity: 0.5 },
});
