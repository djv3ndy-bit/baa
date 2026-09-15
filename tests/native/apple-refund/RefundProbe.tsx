// Copied only into the disposable device build. Never import from mobile/app.
import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Store from 'expo-iap';
import { getCurrentContext } from '../../lib/session';
import { authenticatedApi } from '../../lib/api';
import { assertRefundTestContext, assertSandboxRefundPurchase, sandboxRefundAccount, sandboxRefundProduct } from './guard';

export default function RefundProbe() {
  const busy = useRef(false);
  const [message, setMessage] = useState('Sandbox refund test. No real charge or refund.');
  const [running, setRunning] = useState(false);
  const checkAccount = async () => {
    const context = await getCurrentContext();
    assertRefundTestContext({ platform: Platform.OS,
      flag: process.env.EXPO_PUBLIC_TEST_REFUND_PROBE,
      api: process.env.EXPO_PUBLIC_API_BASE_URL,
      database: process.env.EXPO_PUBLIC_SUPABASE_URL,
      accountId: context.user?.id, role: context.role ?? undefined });
  };
  const open = async () => {
    if (busy.current) return;
    busy.current = true; setRunning(true);
    let stage = 'test account';
    try {
      await checkAccount();
      stage = 'Apple connection';
      await Store.initConnection();
      await Store.fetchProducts({ skus: [sandboxRefundProduct], type: 'subs' });
      stage = 'Sandbox transaction';
      const all = await Store.getAvailablePurchases({ onlyIncludeActiveItemsIOS: false, alsoPublishToEventListenerIOS: false });
      const purchase = all.filter(p => p.store === 'apple' && p.productId === sandboxRefundProduct)
        .sort((a, b) => b.transactionDate - a.transactionDate)[0];
      if (!purchase) throw new Error('No test purchase');
      assertSandboxRefundPurchase(purchase);
      stage = 'server ownership verification';
      const result = await authenticatedApi<{ verified: boolean; accountId: string; purchase: { provider: string } }>(
        '/native-purchases', { provider: 'apple', proof: purchase.purchaseToken }, 'POST', sandboxRefundAccount);
      if (!result.verified || result.accountId !== sandboxRefundAccount || result.purchase?.provider !== 'apple') throw new Error('Unconfirmed owner');
      await checkAccount();
      stage = 'Apple refund sheet';
      setMessage('Verified Sandbox purchase. Opening Apple’s test refund sheet.');
      const outcome = await Store.beginRefundRequestIOS(sandboxRefundProduct);
      setMessage(outcome === 'success' ? 'Refund request submitted to Apple Sandbox. Access still requires server confirmation.'
        : outcome === 'userCancelled' ? 'Sandbox refund request canceled.' : 'Apple returned no final refund result. Check verified status.');
    } catch {
      setMessage(`Refund test stopped at ${stage}. No access was granted or removed by this test screen.`);
    } finally { busy.current = false; setRunning(false); }
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#fffaf4' }}>
    <ScrollView contentContainerStyle={{ padding: 24, gap: 24 }}>
      <Text style={{ fontSize: 27, color: '#3e2010', fontWeight: '700' }}>Apple Sandbox refund test</Text>
      <Text accessibilityLiveRegion="polite" style={{ fontSize: 18, lineHeight: 27 }}>{message}</Text>
      <Pressable accessibilityRole="button" disabled={running} onPress={() => { void open(); }} style={{ padding: 18, backgroundColor: '#a44d0c', borderRadius: 12 }}>
        <Text style={{ color: 'white', fontSize: 18 }}>{running ? 'Checking test purchase…' : 'Open Sandbox refund sheet'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={running} onPress={() => router.replace('/subscription')} style={{ padding: 18 }}>
        <Text style={{ fontSize: 18, color: '#743d18' }}>Return to Café plans</Text>
      </Pressable>
    </ScrollView>
  </SafeAreaView>;
}
