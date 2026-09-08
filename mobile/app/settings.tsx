import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AUTH_STORAGE_KEY, withAuthStorageLock, supabase } from "@/lib/supabase";
import { clearDeletedSession, finishAccountDeletion, type DeletionResponse } from '@/lib/accountDeletion';
import { getCurrentContext, AppRole } from "@/lib/session";
import { registerForPhoneNotifications, unregisterThisDeviceNotifications } from "@/lib/pushNotifications";
import { authenticatedApi, requireAccountSession, updateAccountPassword } from "@/lib/api";

type BillingStatus = {
  status: string;
  plan: "free" | "pro";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  connectedToBilling: boolean;
  canManageBilling: boolean;
  billingPaused: boolean;
};

export default function Settings() {
  const actionBusy = useRef(false);
  const active = useRef(false);
  const generation = useRef(0);
  const account = useRef<string | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [email, setEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [enablingNotifications, setEnablingNotifications] = useState(false);
  const [notificationStatus, setNotificationStatus] = useState('Enable alerts for new messages and matches.');
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [billingError, setBillingError] = useState('');
  const [openingBilling, setOpeningBilling] = useState(false);
  const disabled = loading || !accountId || saving || deleting || loggingOut || openingBilling || enablingNotifications;
  const load = useCallback(async () => {
    if (!active.current) return;
    const run = ++generation.current;
    setLoading(true);
    setLoadError('');
    setBilling(null);
    setBillingError('');
    try {
      const { user, role: savedRole } = await getCurrentContext();
      if (!active.current || run !== generation.current) return;
      if (!user) return router.replace('/login');
      if (!savedRole) return router.replace({ pathname: '/signup', params: { complete: '1' } });
      account.current = user.id;
      setAccountId(user.id);
      setEmail(user.email || 'Email not available');
      setRole(savedRole);
      if (savedRole === 'cafe_owner_manager') {
        try {
          const result = await authenticatedApi<BillingStatus>('/billing-status', {}, 'GET', user.id);
          await requireAccountSession(user.id);
          if (active.current && run === generation.current) setBilling(result);
        } catch (error) {
          if (active.current && run === generation.current) setBillingError(error instanceof Error ? error.message : 'Subscription status is unavailable.');
        }
      }
    } catch (error) {
      if (active.current && run === generation.current) {
        account.current = null;
        setAccountId(null);
        setRole(null);
        setEmail('');
        setLoadError(error instanceof Error ? error.message : 'Could not load your account.');
      }
    } finally {
      if (active.current && run === generation.current) setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => {
    active.current = true;
    void load();
    return () => { active.current = false; ++generation.current; };
  }, [load]));
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && account.current && session?.user.id !== account.current)) {
        ++generation.current;
        account.current = null;
        setAccountId(null);
        setRole(null);
        setEmail('');
        setBilling(null);
        setP1('');
        setP2('');
        setShowPassword(false);
        setShowAdvanced(false);
        if (active.current) setTimeout(() => { void load(); }, 0);
      }
    });
    return () => subscription.unsubscribe();
  }, [load]);

  async function manageSubscription() {
    const expectedUserId = accountId;
    if (!expectedUserId || actionBusy.current || loading) return;
    if (billingError) return load();
    if (!billing) return;
    actionBusy.current = true;
    setOpeningBilling(true);
    try {
      await requireAccountSession(expectedUserId);
      if (!active.current || account.current !== expectedUserId) return;
      if (!billing.canManageBilling) return router.push('/subscription');
      const result = await authenticatedApi<{ url: string }>('/create-portal-session', { channel: 'mobile' }, 'POST', expectedUserId);
      await requireAccountSession(expectedUserId);
      if (!active.current || account.current !== expectedUserId) return;
      if (!result.url || new URL(result.url).origin !== 'https://billing.stripe.com') throw new Error('The billing link is unavailable. Please try again.');
      await WebBrowser.openBrowserAsync(result.url);
      await load();
    } catch (error) {
      if (active.current) Alert.alert('Could not open subscription management', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      actionBusy.current = false;
      setOpeningBilling(false);
    }
  }
  async function changePassword() {
    const expectedUserId = accountId;
    if (!expectedUserId || actionBusy.current || loading) return;
    if (p1 !== p2) return Alert.alert('Passwords do not match');
    if (p1.length < 10) return Alert.alert('Use at least 10 characters.');
    actionBusy.current = true;
    setSaving(true);
    try {
      await updateAccountPassword(expectedUserId, p1);
      if (!active.current || account.current !== expectedUserId) return;
      setP1('');
      setP2('');
      setShowPassword(false);
      Alert.alert('Password updated');
    } catch (error) {
      if (active.current) Alert.alert('Could not change password', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      actionBusy.current = false;
      setSaving(false);
    }
  }
  async function logout() {
    const expectedUserId = accountId;
    if (!expectedUserId || actionBusy.current || loading) return;
    actionBusy.current = true;
    setLoggingOut(true);
    try {
      await requireAccountSession(expectedUserId);
      await unregisterThisDeviceNotifications(expectedUserId);
      await requireAccountSession(expectedUserId);
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      router.replace('/login');
    } catch (error) {
      if (active.current) Alert.alert('Could not log out', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      actionBusy.current = false;
      setLoggingOut(false);
    }
  }
  function requestAccountDeletion() {
    const expectedUserId = accountId;
    if (!expectedUserId || actionBusy.current || loading) return;
    Alert.alert(
      'Delete your account?',
      'This permanently removes your profile, jobs, matches, messages, and uploaded media. If this account has an active Pro subscription, deletion cancels it immediately. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', style: 'destructive', onPress: () => confirmAccountDeletion(expectedUserId) },
      ],
    );
  }
  function confirmAccountDeletion(expectedUserId: string) {
    if (account.current !== expectedUserId) return Alert.alert('Account changed', 'Please review the signed-in account before deleting.');
    Alert.alert(
      'Final confirmation',
      'Delete your BaristaMatch account now? Any active Pro subscription will be canceled immediately; deletion does not issue a refund. Limited records may be retained as described in the Privacy Policy. If you used Sign in with Apple, we will show how to disconnect Apple after deletion.',
      [
        { text: 'Keep my account', style: 'cancel' },
        { text: 'Delete permanently', style: 'destructive', onPress: () => { void deleteAccount(expectedUserId); } },
      ],
    );
  }
  async function deleteAccount(expectedUserId: string) {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setDeleting(true);
    try {
      await requireAccountSession(expectedUserId);
      await finishAccountDeletion(
        () => authenticatedApi<DeletionResponse>('/delete-account', { confirmation: 'DELETE' }, 'POST', expectedUserId),
        () => clearDeletedSession(supabase.auth, AsyncStorage, AUTH_STORAGE_KEY, expectedUserId, withAuthStorageLock),
      );
      router.replace('/account-deleted');
    } catch (error) {
      Alert.alert('Could not delete account', error instanceof Error ? error.message : 'Please try again.');
    } finally { actionBusy.current = false; setDeleting(false); }
  }
  async function enableNotifications() {
    const expectedUserId = accountId;
    if (!expectedUserId || actionBusy.current || loading) return;
    actionBusy.current = true;
    setEnablingNotifications(true);
    try {
      await requireAccountSession(expectedUserId);
      const result = await registerForPhoneNotifications({ requestPermission: true });
      if (!active.current || account.current !== expectedUserId) return;
      if (result.status === 'enabled') setNotificationStatus('Message and match alerts are enabled on this device.');
      else if (result.status === 'denied') {
        setNotificationStatus('Alerts are disabled. You can enable them in your device settings.');
        if (result.canAskAgain === false) Alert.alert('Enable notifications in Settings', 'Allow notifications for BaristaMatch to receive message and match alerts.', [{text:'Cancel',style:'cancel'}, {text:'Open Settings',onPress:() => { Linking.openSettings().catch(() => Alert.alert('Open your device settings', 'Choose BaristaMatch, then Notifications.')); }}]);
      } else setNotificationStatus(result.status === 'no-session' ? 'Please sign in again to enable alerts.' : 'Notifications require an installed app on a supported device.');
    } catch (error) {
      if (active.current) setNotificationStatus(error instanceof Error ? error.message : 'Could not enable notifications. Please try again.');
    } finally {
      actionBusy.current = false;
      setEnablingNotifications(false);
    }
  }
  function openHelp(url: string) {
    Linking.openURL(url).catch(() => Alert.alert('Could not open this page', 'Check your connection and try again.'));
  }
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" style={s.backButton} onPress={() => router.back()}>
          <Text allowFontScaling={false} style={s.back}>‹</Text>
        </Pressable>
        <Text style={s.title}>Account Settings</Text>
        <View style={s.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={s.wrap}>
        {loadError ? <Card title="Account unavailable" copy={loadError} action="Try again" onPress={() => { void load(); }} /> : <Card title="Account email" copy={loading ? 'Loading your account…' : email} />}
        {role === "cafe_owner_manager" ? <SubscriptionCard billing={billing} error={billingError} opening={openingBilling || loading} onPress={manageSubscription} /> : null}
        <View style={s.card}>
          <Text style={s.cardTitle}>Notifications</Text>
          <Text accessibilityLiveRegion="polite" style={s.copy}>{notificationStatus}</Text>
          <Pressable accessibilityRole="button" disabled={disabled} style={[s.secondary, disabled && s.disabled]} onPress={enableNotifications}><Text style={s.secondaryText}>{enablingNotifications ? 'Enabling…' : 'Enable notifications'}</Text></Pressable>
        </View>
        <View style={s.card}>
          <Pressable accessibilityRole="button" disabled={disabled} style={s.row} onPress={() => setShowPassword((x) => !x)}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Change password</Text>
              <Text style={s.copy}>
                Update your BaristaMatch login password.
              </Text>
            </View>
            <Text style={s.chev}>{showPassword ? "⌄" : "›"}</Text>
          </Pressable>
          {showPassword ? (
            <View style={s.password}>
              <TextInput
                secureTextEntry
                editable={!disabled}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                placeholder="New password"
                value={p1}
                onChangeText={setP1}
                style={s.input}
              />
              <TextInput
                secureTextEntry
                editable={!disabled}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                placeholder="Confirm new password"
                value={p2}
                onChangeText={setP2}
                style={s.input}
              />
              <Pressable
                onPress={changePassword}
                disabled={disabled}
                style={s.primary}
              >
                <Text style={s.primaryText}>
                  {saving ? "Saving…" : "Save new password"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <View style={s.card}>
          <Text style={s.cardTitle}>Help & Support</Text>
          <Text style={s.copy}>
            Ask a question or report something that is not working.
          </Text>
          <View style={s.help}>
            <Pressable
              style={s.secondary}
              onPress={() =>
                openHelp(
                  "https://www.baristajobmatch.com/support.html?type=question",
                )
              }
            >
              <Text style={s.secondaryText}>Ask a question</Text>
            </Pressable>
            <Pressable
              style={s.primarySmall}
              onPress={() =>
                openHelp(
                  "https://www.baristajobmatch.com/support.html?type=bug",
                )
              }
            >
              <Text style={s.primaryText}>Report a problem</Text>
            </Pressable>
          </View>
        </View>
        <View style={s.card}>
          <Text style={s.cardTitle}>Account</Text>
          <Text style={s.copy}>Sign out of BaristaMatch on this device.</Text>
          <Pressable accessibilityRole="button" disabled={disabled} style={[s.secondary, disabled && s.disabled]} onPress={logout}>
            <Text style={s.secondaryText}>{loggingOut ? "Logging out…" : "Log out"}</Text>
          </Pressable>
        </View>
        <Pressable
          style={s.advanced}
          onPress={() =>
            openHelp("https://www.baristajobmatch.com/privacy.html")
          }
        >
          <Text style={s.advancedText}>Privacy & account data</Text>
        </Pressable>
        <Pressable
          style={s.advanced}
          onPress={() => openHelp("https://www.baristajobmatch.com/terms.html")}
        >
          <Text style={s.advancedText}>Terms of Service</Text>
        </Pressable>
        <View style={s.card}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showAdvanced }}
            style={s.row}
            onPress={() => setShowAdvanced((value) => !value)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Advanced settings</Text>
              <Text style={s.copy}>Sensitive account controls.</Text>
            </View>
            <Text style={s.chev}>{showAdvanced ? "⌄" : "›"}</Text>
          </Pressable>
          {showAdvanced ? (
            <View style={s.dangerZone}>
              <Text style={s.dangerTitle}>Delete my account</Text>
              <Text style={s.copy}>
                Permanently removes your profile, jobs, matches, messages, and uploaded media. Any active Pro subscription is canceled immediately. This cannot be undone.
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={disabled}
                style={[s.dangerButton, deleting && s.disabled]}
                onPress={requestAccountDeletion}
              >
                <Text style={s.dangerButtonText}>{deleting ? "Deleting…" : "Delete my account"}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <Text style={s.legalOperator}>Operated by BaristaMatch LLC</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SubscriptionCard({ billing, error, opening, onPress }: { billing: BillingStatus | null; error: string; opening: boolean; onPress: () => void }) {
  const paying = billing?.plan === "pro" && billing.connectedToBilling;
  const needsPayment = Boolean(billing?.connectedToBilling && ["past_due", "unpaid", "incomplete"].includes(billing.status));
  const date = billing?.currentPeriodEnd ? new Date(billing.currentPeriodEnd).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "";
  const statusLabel = String(billing?.status || "").replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
  let detail = "Checking your café plan…";
  if (error) detail = error;
  else if (paying && billing?.cancelAtPeriodEnd && date) detail = `Canceled · Pro access ends ${date}`;
  else if (paying && date && ["active", "trialing"].includes(billing?.status || "")) detail = `Next billing date: ${date}`;
  else if (needsPayment) detail = "Payment needs attention. Update your payment method.";
  else if (paying) detail = "Your Pro subscription is connected to Stripe.";
  else if (billing) detail = "Your first job, matches, and interview messaging are included. A second job requires Pro.";
  const action = error ? "Retry subscription status" : billing?.canManageBilling ? "Manage subscription" : "View Free and Pro plans";
  return <View style={s.card}>
    <View style={s.subscriptionHead}><View style={s.subscriptionIcon}><Text style={s.subscriptionIconText}>$</Text></View><View style={s.subscriptionCopy}><Text style={s.cardTitle}>Subscription</Text><Text style={s.subscriptionPlan}>{!billing ? (error ? "Status unavailable" : "Checking plan…") : paying ? `Pro · ${statusLabel || "Active"} · $9.99/month` : needsPayment ? `Pro · ${statusLabel || "Payment issue"}` : "Free · Active · $0"}</Text><Text style={[s.copy, error ? s.errorText : undefined]}>{detail}</Text></View></View>
    <Pressable accessibilityRole="button" disabled={(!billing && !error) || opening} onPress={onPress} style={[s.secondary, ((!billing && !error) || opening) && s.disabled]}><Text style={s.secondaryText}>{opening ? "Opening…" : action}</Text></Pressable>
  </View>;
}

function Card({
  title,
  copy,
  action,
  onPress,
}: {
  title: string;
  copy: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      <Text style={s.copy}>{copy}</Text>
      {action ? (
        <Pressable onPress={onPress} style={s.secondary}>
          <Text style={s.secondaryText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fbf7f1" },
  header: {
    minHeight: 66,
    paddingVertical: 10,
    gap: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#eadfd5",
    backgroundColor: "#fff",
  },
  backButton: { width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  headerSpacer: { width: 44, flexShrink: 0 },
  back: { fontSize: 34, color: "#321708" },
  title: { flex: 1, minWidth: 0, textAlign: "center", fontSize: 19, fontWeight: "900", color: "#321708" },
  wrap: { padding: 18, paddingBottom: 40 },
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eadfd5",
    borderRadius: 18,
    padding: 18,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 17, fontWeight: "900", color: "#321708" },
  copy: { fontSize: 13, lineHeight: 19, color: "#746a61", marginTop: 6 },
  row: { flexDirection: "row", alignItems: "center" },
  chev: { fontSize: 28, color: "#a95820" },
  password: {
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: "#eee4da",
    marginTop: 15,
    paddingTop: 15,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd0c6",
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
  },
  primary: {
    backgroundColor: "#321708",
    borderRadius: 13,
    padding: 13,
    alignItems: "center",
  },
  primarySmall: {
    backgroundColor: "#321708",
    borderRadius: 12,
    paddingHorizontal: 15,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryText: { color: "#fff", fontWeight: "900" },
  secondary: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#c9ad99",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 15,
    paddingVertical: 11,
    marginTop: 14,
  },
  secondaryText: { color: "#321708", fontWeight: "900" },
  dangerZone: { borderTopWidth: 1, borderTopColor: "#f0d4d4", marginTop: 16, paddingTop: 16 },
  dangerTitle: { color: "#8f2020", fontSize: 15, fontWeight: "900" },
  dangerButton: { alignSelf: "flex-start", borderWidth: 1, borderColor: "#b43b3b", backgroundColor: "#fff7f7", borderRadius: 12, paddingHorizontal: 15, paddingVertical: 11, marginTop: 14 },
  dangerButtonText: { color: "#9c2626", fontWeight: "900" },
  help: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "center",
  },
  advanced: { padding: 16, alignItems: "center" },
  advancedText: { color: "#8b7769", fontWeight: "700", fontSize: 13 },
  legalOperator: { textAlign: "center", color: "#8a7e75", fontSize: 12, marginTop: 8 },
  subscriptionHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  subscriptionIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#f3e6dc", alignItems: "center", justifyContent: "center" },
  subscriptionIconText: { fontSize: 20, fontWeight: "900", color: "#321708" },
  subscriptionCopy: { flex: 1 },
  subscriptionPlan: { marginTop: 6, fontSize: 13, lineHeight: 19, fontWeight: "900", color: "#321708" },
  errorText: { color: "#a32727" },
  disabled: { opacity: 0.55 },
});
