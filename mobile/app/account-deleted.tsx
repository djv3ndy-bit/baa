import { useState } from 'react';
import { Alert, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { APPLE_DISCONNECT_HELP, clearDeletionReceipt, getDeletionReceipt } from '@/lib/accountDeletion';

export default function AccountDeleted() {
  // Never accept success or provider state from a deep link/query parameter.
  const [receipt] = useState(getDeletionReceipt);
  const apple = receipt?.appleDisconnectRequired ?? true;
  async function openAppleGuide() {
    try { await Linking.openURL(APPLE_DISCONNECT_HELP); }
    catch { Alert.alert('Apple guide unavailable', 'Open Settings, tap your name, choose Sign in with Apple, then select BaristaMatch and stop using Sign in with Apple. You can also manage this at account.apple.com.'); }
  }
  function finish() { clearDeletionReceipt(); router.replace('/login'); }
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}>
    <Text accessibilityRole="header" style={styles.title}>{receipt ? 'Account deleted' : 'Account deletion information'}</Text>
    <Text style={styles.copy}>{receipt ? 'Your BaristaMatch account has been deleted. Limited records may be retained as described in our Privacy Policy.' : 'This page does not submit or confirm a deletion request. To delete an account, sign in and open Account Settings.'}</Text>
    {receipt && !receipt.localSignOutComplete ? <View style={styles.warning}><Text style={styles.copy}>Account deletion succeeded, but local sign-out could not be confirmed. This can happen if the signed-in account changed or device storage is unavailable. Close the app and review your sign-in before continuing.</Text></View> : null}
    {apple ? <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.subtitle}>Disconnect Sign in with Apple</Text>
      <Text style={styles.copy}>{receipt ? 'We do not have a saved Apple authorization token for this account, so Apple access was not automatically revoked. Your BaristaMatch account deletion is complete; this separate step disconnects Apple.' : 'If you used Sign in with Apple, deleting the BaristaMatch account and disconnecting Apple are separate actions.'}</Text>
      <Text style={styles.copy}>On iPhone or iPad, open Settings, tap your name, choose Sign in with Apple, then select BaristaMatch (or its developer) and follow the option to stop using it.</Text>
      <Text style={styles.copy}>On Android or a computer, sign in at account.apple.com, open Sign-In &amp; Security, then Sign in with Apple. Select BaristaMatch and follow the instructions. If it is not listed, it may already be disconnected.</Text>
      <Pressable accessibilityRole="link" onPress={openAppleGuide} style={styles.secondary}><Text style={styles.link}>Open Apple's instructions</Text></Pressable>
    </View> : null}
    <Pressable accessibilityRole="button" onPress={finish} style={styles.primary}><Text style={styles.primaryText}>Return to sign in</Text></Pressable>
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fbf7f1' }, content: { padding: 24, paddingBottom: 50 },
  title: { fontSize: 29, fontWeight: '800', color: '#321708', marginBottom: 12 },
  subtitle: { fontSize: 21, fontWeight: '700', color: '#321708' },
  copy: { fontSize: 16, lineHeight: 25, color: '#53463e', marginTop: 12 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 20, marginVertical: 24 },
  warning: { backgroundColor: '#fff0d9', padding: 16, borderRadius: 12, marginTop: 16 },
  secondary: { paddingVertical: 16 }, link: { color: '#854017', fontSize: 16, fontWeight: '700' },
  primary: { backgroundColor: '#321708', padding: 16, borderRadius: 12, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
