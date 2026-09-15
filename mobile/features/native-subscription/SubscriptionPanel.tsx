import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Action, Icon } from '../approved-dashboard/DashboardPrimitives';
import { dashboardTheme as t } from '../approved-dashboard/theme';
import { purchaseIsBlocked, type StoreProduct, type VerifiedSubscription, type BillingProvider } from './purchaseCoordinator';

export type SubscriptionPanelProps = {
  role: string;
  subscription: VerifiedSubscription | null;
  product: StoreProduct | null;
  busy: boolean;
  notice?: string;
  error?: string;
  canRestore?: boolean;
  onBack: () => void;
  onBuy: () => void;
  onRestore: () => void;
  onManage: (provider?: BillingProvider) => void;
  onRetry: () => void;
  onTerms: () => void;
  onPrivacy: () => void;
  onSupport?: () => void;
};
const benefits = ['Up to 3 active jobs', 'Unlimited candidate profile viewing', 'Unlimited messaging', 'Smart candidate matches', 'Save baristas for later', 'Full hiring dashboard'];
export function SubscriptionPanel(props: SubscriptionPanelProps) {
  if (props.role !== 'cafe_owner_manager') return null;
  const { subscription, product, busy } = props;
  const providerName = (provider: BillingProvider) => provider === 'apple' ? 'Apple' : provider === 'google' ? 'Google Play' : 'Stripe';
  const providers = subscription?.subscriptions
    ? [...new Set(subscription.subscriptions.filter(row => row.canManage).map(row => row.provider))]
    : subscription?.provider && subscription.canManage ? [subscription.provider] : [];
  const end = subscription?.status === 'grace' ? subscription.gracePeriodEnd : subscription?.currentPeriodEnd;
  const subscribed = subscription?.access === 'pro';
  const canResume = !!product && product.provider === 'apple' && subscription?.access === 'free' && subscription.status === 'pending' && subscription.canResumeAppleCheckout === true && !props.error;
  const canBuy = !!product && !!subscription && !props.error && !purchaseIsBlocked(subscription);
  const periodEnd = end && Number.isFinite(Date.parse(end))
    ? new Date(end).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  return <View style={s.safe}>
    <View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={props.onBack} style={s.back}><Icon name="chevron-back" /></Pressable><Text accessibilityRole="header" style={s.headerTitle}>Café plans</Text></View>
    <ScrollView contentContainerStyle={s.content}>
      <Text style={s.title}>Your next hire starts here.</Text>
      <Text style={s.copy}>Your first job, matching, and interview messaging stay included.</Text>
      {props.error ? <View style={s.feedback}><Text accessibilityRole="alert" style={s.error}>{props.error}</Text><Action label="Try again" disabled={busy} onPress={props.onRetry} /></View> : null}
      {props.notice ? <Text accessibilityLiveRegion="polite" style={s.notice}>{props.notice}</Text> : null}
      {busy && !subscription ? <Text accessibilityLiveRegion="polite" style={s.copy}>Checking your subscription…</Text> : null}
      <View style={s.card}><Text style={s.eyebrow}>FREE</Text><Text style={s.price}>$0</Text><Text style={s.copy}>Post your first job free. View applicants, message your matches, and schedule interviews.</Text><Text style={s.included}>Included with your café account</Text></View>
      <View style={s.card}><Text style={s.eyebrow}>CAFÉ PRO</Text>
        {subscribed ? <Text style={s.current}>Your Pro access is active</Text> : product ? <View style={s.priceRow}><Text style={s.price}>{product.displayPrice}</Text><Text style={s.period}>per month</Text></View> : <Text style={s.copy}>Purchase pricing is not available yet.</Text>}
        <Text style={s.copy}>For cafés that are growing their team.</Text>
        {subscribed && periodEnd ? <Text style={s.copy}>{subscription?.status === 'grace' ? 'Grace access ends' : subscription?.autoRenews ? 'Current period ends' : 'Access ends'} {periodEnd}.</Text> : null}
        {subscription?.status === 'grace' ? <Text style={s.notice}>Your access remains active while the store retries your payment. Open subscription management to review your payment method.</Text> : null}
        {subscription?.status === 'payment_required' ? <Text style={s.notice}>Your subscription needs payment attention. Open management before purchasing again.</Text> : null}
        <View style={s.benefits}>{benefits.map(benefit => <View style={s.benefit} key={benefit}><Icon name="checkmark-circle-outline" color={t.accent} size={21} /><Text style={s.benefitText}>{benefit}</Text></View>)}</View>
        {canBuy ? <><Action primary label={busy ? 'Checking purchase…' : `Subscribe for ${product!.displayPrice}/month`} disabled={busy} onPress={props.onBuy} /><Text style={s.fine}>Renews automatically each month unless canceled in your {product!.provider === 'apple' ? 'Apple' : 'Google Play'} subscription settings. The store confirms the price and terms before you purchase.</Text></>
          : canResume ? <><Text style={s.notice}>Apple has not confirmed this checkout. Continue to check existing purchases first. Use the same Apple Account you used when starting it.</Text><Action primary label={busy ? 'Checking purchase…' : `Continue Apple checkout · ${product!.displayPrice}/month`} disabled={busy} onPress={props.onBuy} /><Text style={s.fine}>If no completed purchase is found, Apple may ask you to confirm the monthly subscription again. It renews automatically unless canceled in Apple subscription settings.</Text></>
          : subscription?.status === 'pending' ? <Text style={s.notice}>A purchase is pending. Restore purchases to check for a completed purchase. Contact support if it remains pending.</Text>
            : !subscription?.canManage ? <Text style={s.notice}>Purchases will be available after your account and store pricing are confirmed.</Text> : null}
        {providers.map(provider => <View style={s.management} key={provider}><Text style={s.copy}>Review your {providerName(provider)} subscription and its renewal settings.</Text><Action label={`Manage ${providerName(provider)} subscription`} onPress={() => props.onManage(provider)} disabled={busy} /></View>)}
        <Text style={s.fine}>Existing subscriptions keep their current billing terms. Your subscription follows the same BaristaMatch account on the app and website.</Text>
      </View>
      {props.canRestore !== false ? <Action label={busy ? 'Checking purchases…' : 'Restore purchases'} disabled={busy} onPress={props.onRestore} /> : null}
      <Text style={s.fine}>Restore purchases made with your current store account. Access is confirmed securely for the BaristaMatch account that originally purchased it.</Text>
      {props.onSupport ? <Action label="Contact subscription support" onPress={props.onSupport} /> : null}
      <View style={s.links}><Action label="Terms of use" onPress={props.onTerms} /><Action label="Privacy policy" onPress={props.onPrivacy} /></View>
    </ScrollView>
  </View>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: t.background }, header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.border }, back: { minWidth: 48, minHeight: 48, justifyContent: 'center' }, headerTitle: { flex: 1, fontSize: 20, fontWeight: '600', color: t.ink },
  content: { padding: 18, gap: 14, maxWidth: 680, width: '100%', alignSelf: 'center' }, title: { fontFamily: t.headingFont, fontSize: 31, fontWeight: '700', color: t.ink }, copy: { fontSize: 16, lineHeight: 23, color: t.muted }, card: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.statBorder, borderRadius: 18, padding: 18, gap: 12 },
  eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 1.1, color: t.accent }, priceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 9 }, price: { fontSize: 35, fontWeight: '700', color: t.ink }, period: { fontSize: 16, color: t.muted }, included: { color: t.success, fontSize: 15, padding: 12, borderRadius: 12, backgroundColor: t.successBackground },
  management: { gap: 10 }, benefits: { gap: 12, marginVertical: 6 }, benefit: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' }, benefitText: { flex: 1, minWidth: 0, fontSize: 15, color: t.ink }, fine: { fontSize: 13, lineHeight: 20, color: t.muted }, links: { gap: 8 }, feedback: { gap: 10 }, error: { color: t.error, fontSize: 15, lineHeight: 22 }, notice: { backgroundColor: t.soft, color: t.ink, fontSize: 15, lineHeight: 22, padding: 14, borderRadius: 12 }, current: { fontSize: 21, color: t.success, fontWeight: '600' },
});
