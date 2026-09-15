import { useCallback, useRef, useState } from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { CafeAccessCheck } from '../../components/CafeAccessCheck';
import { useCafeAccess } from '../../lib/useCafeAccess';
import { getCurrentContext } from '../../lib/session';
import { authenticatedApi, requireAccountSession } from '../../lib/api';
import { SubscriptionPanel } from './SubscriptionPanel';
import { SubscriptionController, initialSubscriptionState, type SubscriptionStore } from './subscriptionController';
import type { StorePurchase } from './purchaseCoordinator';
import { dashboardTheme } from '../approved-dashboard/theme';

export type CreateSubscriptionStore = (onUnfinished: (purchase: StorePurchase) => void) => SubscriptionStore | null;
export default function NativeSubscriptionScreen({ createStore }: { createStore: CreateSubscriptionStore }) {
  const access = useCafeAccess();
  if (!access.ready || !access.accountId) return <CafeAccessCheck error={access.error} retry={access.retry} />;
  return <AccountSubscription key={access.accountId} accountId={access.accountId} createStore={createStore} />;
}

function AccountSubscription({ accountId, createStore }: { accountId: string; createStore: CreateSubscriptionStore }) {
  const [state, setState] = useState(initialSubscriptionState);
  const [hasStore, setHasStore] = useState(false);
  const controller = useRef<SubscriptionController | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true;
    let store: SubscriptionStore | null = null;
    try { store = createStore(purchase => { if (live) void controller.current?.recover(purchase); }); }
    catch { /* Installed native module not available: status/management still work. */ }
    setHasStore(!!store);
    const current = new SubscriptionController({
      accountId, store, call: authenticatedApi,
      account: async () => {
        const context = await getCurrentContext();
        return live && context.user && context.role ? { id: context.user.id, role: context.role } : null;
      },
      changed: value => { if (live) setState(value); },
      accountChanged: () => { if (live) router.replace('/login'); },
      openManagement: async (provider, expectedAccount) => {
        await requireAccountSession(expectedAccount);
        if (!live) return;
        if (provider === 'stripe') {
          const result = await authenticatedApi<{ url: string }>('/create-portal-session', { channel: 'mobile' }, 'POST', expectedAccount);
          await requireAccountSession(expectedAccount);
          if (!live) return;
          const url = new URL(result.url);
          if (url.origin !== 'https://billing.stripe.com' || url.username || url.password) throw new Error('Billing page unavailable');
          await WebBrowser.openBrowserAsync(url.href);
        } else if (store && ((provider === 'apple' && Platform.OS === 'ios') || (provider === 'google' && Platform.OS === 'android'))) {
          await store.manage();
        } else {
          // These are provider management pages, never disguised native checkout.
          await Linking.openURL(provider === 'apple' ? 'https://apps.apple.com/account/subscriptions' : 'https://play.google.com/store/account/subscriptions');
        }
      },
    });
    controller.current = current;
    void current.load();
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') void current.load(); });
    return () => { live = false; foreground.remove(); current.dispose(); controller.current = null; };
  }, [accountId, createStore]));
  const openLegal = (page: 'terms' | 'privacy') => {
    void Linking.openURL(`https://www.baristajobmatch.com/${page}.html`).catch(() => {
      Alert.alert('Could not open this page', 'Check your connection and try again.');
    });
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: dashboardTheme.background }} edges={Platform.OS === 'android' ? [] : ['top', 'right', 'bottom', 'left']}>
    <SubscriptionPanel role="cafe_owner_manager" {...state} canRestore={hasStore}
      onBack={() => router.canGoBack() ? router.back() : router.replace('/settings')}
      onBuy={() => { void controller.current?.buy(); }} onRestore={() => { void controller.current?.restore(); }}
      onManage={provider => { void controller.current?.manage(provider); }} onRetry={() => { void controller.current?.load(); }}
      onTerms={() => openLegal('terms')} onPrivacy={() => openLegal('privacy')}
      onSupport={() => { void Linking.openURL('mailto:support@baristajobmatch.com').catch(() => Alert.alert('Contact support', 'Email support@baristajobmatch.com for help with your subscription.')); }} />
  </SafeAreaView>;
}
