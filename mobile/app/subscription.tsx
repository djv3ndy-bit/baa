import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { getCurrentContext } from '@/lib/session';

const freeBenefits = [
  'Post your first job free',
  'View applicants and full profiles',
  'Message your matches',
  'Hire your first barista',
];

const proBenefits = [
  'Up to 3 active jobs',
  'Unlimited candidate profile viewing',
  'Unlimited messaging',
  'Smart candidate matches',
  'Save baristas for later',
  'Full hiring dashboard',
];

export default function SubscriptionScreen() {
  const [checkingAccess, setCheckingAccess] = useState(true);

  useEffect(() => {
    let active = true;
    getCurrentContext().then(({ user, role }) => {
      if (!active) return;
      if (!user) return router.replace('/login');
      if (role !== 'cafe_owner_manager') return router.replace('/home');
      setCheckingAccess(false);
    }).catch(() => router.replace('/home'));
    return () => { active = false; };
  }, []);

  if (checkingAccess) return <SafeAreaView style={styles.safe}><View style={styles.loading}><ActivityIndicator size="large" color="#b75a1d" /></View></SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Café plans</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.wrap}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>SIMPLE CAFÉ PRICING</Text>
          <Text style={styles.title}>Make your first hire free.</Text>
          <Text style={styles.subtitle}>Start with everything you need for one successful hire. Upgrade only when your café is ready to hire again.</Text>
        </View>

        <View style={styles.freeCard}>
          <View style={styles.planTop}>
            <View>
              <Text style={styles.freeLabel}>FREE</Text>
              <View style={styles.priceRow}>
                <Text style={styles.freePrice}>$0</Text>
                <Text style={styles.pricePeriod}> forever</Text>
              </View>
            </View>
            <View style={styles.currentPill}><Text style={styles.currentText}>START HERE</Text></View>
          </View>
          <Text style={styles.planDescription}>Your first job and first hire are on us.</Text>
          <View style={styles.benefits}>{freeBenefits.map(item => <Benefit key={item} text={item} dark={false} />)}</View>
          <View style={styles.freeButton}><Text style={styles.freeButtonText}>Included with your café account</Text></View>
        </View>

        <View style={styles.proCard}>
          <View style={styles.glow} />
          <View style={styles.founderPill}><Text style={styles.founderText}>FOUNDER PRICE</Text></View>
          <Text style={styles.proLabel}>PRO</Text>
          <View style={styles.priceRow}>
            <Text style={styles.proPrice}>$9.99</Text>
            <Text style={styles.proPeriod}> / month</Text>
          </View>
          <Text style={styles.proDescription}>For cafés that are growing their team.</Text>
          <View style={styles.proDivider} />
          <View style={styles.benefits}>{proBenefits.map(item => <Benefit key={item} text={item} dark />)}</View>
          <View style={styles.proButton}>
            <Text style={styles.proButtonText}>Pro purchases are not available in this app</Text>
          </View>
          <Text style={styles.finePrint}>Cancel anytime. Founder pricing stays with you while your subscription remains active.</Text>
        </View>

        <View style={styles.baristaNote}>
          <Text style={styles.cup}>☕</Text>
          <View style={styles.baristaCopy}>
            <Text style={styles.baristaTitle}>Baristas stay free.</Text>
            <Text style={styles.baristaText}>BaristaMatch never charges baristas to find work.</Text>
          </View>
        </View>
        <Text style={styles.previewNote}>Existing Pro subscriptions automatically sync when you sign in with the same café account.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Benefit({ text, dark }: { text: string; dark: boolean }) {
  return (
    <View style={styles.benefitRow}>
      <View style={[styles.checkCircle, dark && styles.checkCircleDark]}><Text style={[styles.check, dark && styles.checkDark]}>✓</Text></View>
      <Text style={[styles.benefitText, dark && styles.benefitTextDark]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fffaf3' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { height: 60, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#eadfd5', backgroundColor: '#fffaf3' },
  backButton: { width: 38, height: 42, alignItems: 'flex-start', justifyContent: 'center' },
  back: { fontSize: 38, lineHeight: 40, color: '#321708' },
  headerTitle: { fontSize: 18, fontWeight: '900', color: '#321708' },
  headerSpacer: { width: 38 },
  wrap: { paddingHorizontal: 18, paddingTop: 26, paddingBottom: 40 },
  hero: { marginBottom: 20 },
  eyebrow: { fontSize: 10, fontWeight: '900', letterSpacing: 1.7, color: '#b75a1d' },
  title: { marginTop: 8, maxWidth: 330, fontFamily: 'Georgia', fontSize: 36, lineHeight: 40, fontWeight: '700', letterSpacing: -0.8, color: '#321708' },
  subtitle: { marginTop: 10, maxWidth: 370, fontSize: 14, lineHeight: 21, color: '#746a61' },
  freeCard: { marginBottom: 14, padding: 21, borderWidth: 1, borderColor: '#e3d4c8', borderRadius: 24, backgroundColor: '#fff' },
  planTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  freeLabel: { fontSize: 12, fontWeight: '900', letterSpacing: 1.6, color: '#6f5c50' },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end' },
  freePrice: { marginTop: 5, fontFamily: 'Georgia', fontSize: 38, lineHeight: 42, fontWeight: '700', color: '#321708' },
  pricePeriod: { marginBottom: 6, fontSize: 12, fontWeight: '700', color: '#817269' },
  currentPill: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, backgroundColor: '#edf3e8' },
  currentText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.7, color: '#4f7445' },
  planDescription: { marginTop: 6, marginBottom: 17, fontSize: 14, lineHeight: 20, color: '#66574f' },
  benefits: { gap: 11 },
  benefitRow: { minHeight: 23, flexDirection: 'row', alignItems: 'center' },
  checkCircle: { width: 21, height: 21, marginRight: 10, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#edf3e8' },
  checkCircleDark: { backgroundColor: '#ff9b5b' },
  check: { fontSize: 12, fontWeight: '900', color: '#4f7445' },
  checkDark: { color: '#321708' },
  benefitText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '700', color: '#3c2c23' },
  benefitTextDark: { color: '#fff8f1' },
  freeButton: { marginTop: 20, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 13, alignItems: 'center', backgroundColor: '#f3ece6' },
  freeButtonText: { fontSize: 12, fontWeight: '900', color: '#5c4638' },
  proCard: { position: 'relative', overflow: 'hidden', marginBottom: 14, padding: 22, borderRadius: 26, backgroundColor: '#3b1b0b', shadowColor: '#321708', shadowOpacity: 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 11 }, elevation: 7 },
  glow: { position: 'absolute', right: -78, bottom: -82, width: 230, height: 230, borderRadius: 115, backgroundColor: '#d8641e', opacity: 0.14 },
  founderPill: { alignSelf: 'flex-start', marginBottom: 17, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: '#f8e8dc' },
  founderText: { fontSize: 9, fontWeight: '900', letterSpacing: 1.1, color: '#692f10' },
  proLabel: { fontSize: 12, fontWeight: '900', letterSpacing: 1.8, color: '#e2bd9f' },
  proPrice: { marginTop: 4, fontFamily: 'Georgia', fontSize: 43, lineHeight: 48, fontWeight: '700', color: '#fff' },
  proPeriod: { marginBottom: 7, fontSize: 13, fontWeight: '700', color: '#e4cbb9' },
  proDescription: { marginTop: 6, fontSize: 14, lineHeight: 20, color: '#e8d6c8' },
  proDivider: { height: 1, marginVertical: 18, backgroundColor: '#68412b' },
  proButton: { marginTop: 22, paddingVertical: 15, borderRadius: 14, alignItems: 'center', backgroundColor: '#d8641e' },
  proButtonText: { fontSize: 15, fontWeight: '900', color: '#fff' },
  finePrint: { marginTop: 12, fontSize: 10, lineHeight: 15, textAlign: 'center', color: '#c9ad99' },
  baristaNote: { flexDirection: 'row', alignItems: 'center', padding: 17, borderWidth: 1, borderColor: '#e3d4c8', borderRadius: 20, backgroundColor: '#fff' },
  cup: { width: 44, fontSize: 27 },
  baristaCopy: { flex: 1 },
  baristaTitle: { fontSize: 14, fontWeight: '900', color: '#321708' },
  baristaText: { marginTop: 3, fontSize: 11, lineHeight: 16, color: '#746a61' },
  previewNote: { marginTop: 14, textAlign: 'center', fontSize: 10, fontWeight: '700', color: '#9b8c82' },
});
