import { useEffect, useState } from "react";
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
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "@/lib/supabase";
import { getCurrentContext, AppRole } from "@/lib/session";
import { unregisterThisDeviceNotifications } from "@/lib/pushNotifications";
import { authenticatedApi } from "@/lib/api";

type BillingStatus = {
  status: string;
  plan: "free" | "pro";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  connectedToBilling: boolean;
  billingPaused: boolean;
};

export default function Settings() {
  const [role, setRole] = useState<AppRole>("barista"),
    [email, setEmail] = useState(""),
    [showPassword, setShowPassword] = useState(false),
    [p1, setP1] = useState(""),
    [p2, setP2] = useState(""),
    [saving, setSaving] = useState(false),
    [deleting, setDeleting] = useState(false),
    [billing, setBilling] = useState<BillingStatus | null>(null),
    [billingError, setBillingError] = useState(""),
    [openingBilling, setOpeningBilling] = useState(false);
  useEffect(() => {
    load();
  }, []);
  async function load() {
    const { user, role: r } = await getCurrentContext();
    if (!user) return router.replace("/login");
    setEmail(user.email || "");
    setRole(r || "barista");
    if (r === "cafe_owner_manager") {
      setBillingError("");
      try {
        setBilling(await authenticatedApi<BillingStatus>("/billing-status", {}, "GET"));
      } catch (error) {
        setBillingError(error instanceof Error ? error.message : "Subscription status is unavailable.");
      }
    }
  }

  async function manageSubscription() {
    if (!billing?.connectedToBilling) return router.push("/subscription");
    setOpeningBilling(true);
    try {
      const result = await authenticatedApi<{ url: string }>("/create-portal-session", { channel: "mobile" });
      await WebBrowser.openBrowserAsync(result.url);
      await load();
    } catch (error) {
      Alert.alert("Could not open subscription management", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setOpeningBilling(false);
    }
  }
  async function changePassword() {
    if (p1 !== p2) return Alert.alert("Passwords do not match");
    if (p1.length < 10) return Alert.alert("Use at least 10 characters.");
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: p1 });
    setSaving(false);
    if (error) return Alert.alert("Could not change password", error.message);
    setP1("");
    setP2("");
    setShowPassword(false);
    Alert.alert("Password updated");
  }
  async function logout() {
    await unregisterThisDeviceNotifications().catch((error) =>
      console.warn("Could not remove notification token", error?.message || error),
    );
    await supabase.auth.signOut();
    router.replace("/login");
  }
  function requestAccountDeletion() {
    Alert.alert(
      "Delete your account?",
      "This permanently removes your profile, jobs, matches, messages, and uploaded media. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Continue", style: "destructive", onPress: confirmAccountDeletion },
      ],
    );
  }
  function confirmAccountDeletion() {
    Alert.alert(
      "Final confirmation",
      "Delete your BaristaMatch account and all account data now?",
      [
        { text: "Keep my account", style: "cancel" },
        { text: "Delete permanently", style: "destructive", onPress: deleteAccount },
      ],
    );
  }
  async function deleteAccount() {
    setDeleting(true);
    try {
      await authenticatedApi<{ success: boolean }>("/delete-account", { confirmation: "DELETE" });
      await unregisterThisDeviceNotifications().catch(() => undefined);
      await supabase.auth.signOut();
      router.replace("/login");
    } catch (error) {
      Alert.alert("Could not delete account", error instanceof Error ? error.message : "Please try again.");
    } finally { setDeleting(false); }
  }
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={s.back}>‹</Text>
        </Pressable>
        <Text style={s.title}>Account Settings</Text>
        <View style={{ width: 32 }} />
      </View>
      <ScrollView contentContainerStyle={s.wrap}>
        <Card title="Account email" copy={email} />
        {role === "cafe_owner_manager" ? <SubscriptionCard billing={billing} error={billingError} opening={openingBilling} onPress={manageSubscription} /> : null}
        <Card
          title="Notifications"
          copy="Message and match alerts are connected to your BaristaMatch account."
        />
        <View style={s.card}>
          <Pressable style={s.row} onPress={() => setShowPassword((x) => !x)}>
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
                placeholder="New password"
                value={p1}
                onChangeText={setP1}
                style={s.input}
              />
              <TextInput
                secureTextEntry
                placeholder="Confirm new password"
                value={p2}
                onChangeText={setP2}
                style={s.input}
              />
              <Pressable
                onPress={changePassword}
                disabled={saving}
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
                Linking.openURL(
                  "https://www.baristajobmatch.com/support.html?type=question",
                )
              }
            >
              <Text style={s.secondaryText}>Ask a question</Text>
            </Pressable>
            <Pressable
              style={s.primarySmall}
              onPress={() =>
                Linking.openURL(
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
          <Text style={s.copy}>Sign out securely or permanently delete your account and data.</Text>
          <Pressable style={s.secondary} onPress={logout}>
            <Text style={s.secondaryText}>Log out</Text>
          </Pressable>
          <Pressable disabled={deleting} style={s.danger} onPress={requestAccountDeletion}>
            <Text style={s.dangerText}>{deleting ? "Deleting…" : "Delete account"}</Text>
          </Pressable>
        </View>
        <Pressable
          style={s.advanced}
          onPress={() =>
            Linking.openURL("https://www.baristajobmatch.com/privacy.html")
          }
        >
          <Text style={s.advancedText}>Privacy & account data</Text>
        </Pressable>
        <Pressable
          style={s.advanced}
          onPress={() => Linking.openURL("https://www.baristajobmatch.com/terms.html")}
        >
          <Text style={s.advancedText}>Terms of Service</Text>
        </Pressable>
        <Text style={s.legalOperator}>Operated by BaristaMatch LLC</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SubscriptionCard({ billing, error, opening, onPress }: { billing: BillingStatus | null; error: string; opening: boolean; onPress: () => void }) {
  const paying = billing?.plan === "pro" && billing.connectedToBilling;
  const date = billing?.currentPeriodEnd ? new Date(billing.currentPeriodEnd).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "";
  const statusLabel = String(billing?.status || "").replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
  let detail = "Checking your café plan…";
  if (error) detail = error;
  else if (paying && billing?.cancelAtPeriodEnd && date) detail = `Canceled · Pro access ends ${date}`;
  else if (paying && date && ["active", "trialing"].includes(billing?.status || "")) detail = `Next billing date: ${date}`;
  else if (paying && ["past_due", "unpaid"].includes(billing?.status || "")) detail = "Payment needs attention. Update your payment method.";
  else if (paying) detail = "Your Pro subscription is connected to Stripe.";
  else if (billing) detail = "Your first job and first hire are included. No upcoming charge.";
  const action = billing?.connectedToBilling ? "Manage subscription" : "View Free and Pro plans";
  return <View style={s.card}>
    <View style={s.subscriptionHead}><View style={s.subscriptionIcon}><Text style={s.subscriptionIconText}>$</Text></View><View style={s.subscriptionCopy}><Text style={s.cardTitle}>Subscription</Text><Text style={s.subscriptionPlan}>{paying ? `Pro · ${statusLabel || "Active"} · $9.99/month` : "Free · Active · $0"}</Text><Text style={[s.copy, error ? s.errorText : undefined]}>{detail}</Text></View></View>
    <Pressable disabled={!billing || opening} onPress={onPress} style={[s.secondary, (!billing || opening) && s.disabled]}><Text style={s.secondaryText}>{opening ? "Opening…" : action}</Text></Pressable>
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
    height: 66,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#eadfd5",
    backgroundColor: "#fff",
  },
  back: { fontSize: 34, color: "#321708" },
  title: { fontSize: 19, fontWeight: "900", color: "#321708" },
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
  danger: {
    alignSelf: "flex-start",
    paddingHorizontal: 2,
    paddingVertical: 12,
    marginTop: 6,
  },
  dangerText: { color: "#a32727", fontWeight: "900" },
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
