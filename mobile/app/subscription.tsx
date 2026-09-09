import { dashboardPrism as prism, prismPanel } from '@/lib/dashboardPrism';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useCafeAccess } from '@/lib/useCafeAccess';
import { CafeAccessCheck } from '@/components/CafeAccessCheck';

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
  const access = useCafeAccess();
  if (!access.ready) return <CafeAccessCheck error={access.error} retry={access.retry} appearance="prism" />;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={styles.backButton}>
          <Text allowFontScaling={false} style={styles.back}>‹</Text>
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
  safe: { flex: 1, backgroundColor: prism.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { minHeight: 60, paddingVertical: 8, gap: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: prism.line, backgroundColor: prism.background },
  backButton: { flexShrink: 0, width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center' },
  back: { fontSize: 38, lineHeight: 40, color: prism.ink },
  headerTitle: { flex: 1, minWidth: 0, textAlign: 'center', fontSize: 18, fontWeight: '700', color: prism.ink },
  headerSpacer: { width: 44, flexShrink: 0 },
  wrap: { paddingHorizontal: 18, paddingTop: 26, paddingBottom: 40 },
  hero: { marginBottom: 20 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.7, color: prism.accent },
  title: { marginTop: 8, maxWidth: 330, fontSize: 36, lineHeight: 40, fontWeight: '700', letterSpacing: -0.8, color: prism.ink },
  subtitle: { marginTop: 10, maxWidth: 370, fontSize: 14, lineHeight: 21, color: prism.muted },
  freeCard: { ...prismPanel, marginBottom: 14, padding: 21, borderWidth: 1, borderColor: prism.line, borderRadius: 24, backgroundColor: prism.surface },
  planTop: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  freeLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1.6, color: prism.muted },
  priceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' },
  freePrice: { marginTop: 5, fontSize: 38, lineHeight: 42, fontWeight: '700', color: prism.ink },
  pricePeriod: { marginBottom: 6, fontSize: 12, fontWeight: '700', color: prism.muted },
  currentPill: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, backgroundColor: '#edf3e8' },
  currentText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.7, color: '#4f7445' },
  planDescription: { marginTop: 6, marginBottom: 17, fontSize: 14, lineHeight: 20, color: prism.muted },
  benefits: { gap: 11 },
  benefitRow: { minHeight: 23, flexDirection: 'row', alignItems: 'center' },
  checkCircle: { width: 21, height: 21, marginRight: 10, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#edf3e8' },
  checkCircleDark: { backgroundColor: prism.accentSoft },
  check: { fontSize: 12, fontWeight: '700', color: '#4f7445' },
  checkDark: { color: prism.ink },
  benefitText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '700', color: prism.ink },
  benefitTextDark: { color: prism.ink },
  freeButton: { marginTop: 20, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 13, alignItems: 'center', backgroundColor: prism.soft },
  freeButtonText: { fontSize: 12, fontWeight: '700', color: prism.muted },
  proCard: { ...prismPanel, position: 'relative', marginBottom: 14, padding: 22, borderRadius: 26 },
  glow: { display: 'none' },
  founderPill: { alignSelf: 'flex-start', marginBottom: 17, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: prism.accentSoft },
  founderText: { fontSize: 9, fontWeight: '700', letterSpacing: 1.1, color: prism.accent },
  proLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1.8, color: prism.muted },
  proPrice: { marginTop: 4, fontSize: 38, lineHeight: 42, fontWeight: '700', color: prism.ink },
  proPeriod: { marginBottom: 7, fontSize: 13, fontWeight: '700', color: prism.muted },
  proDescription: { marginTop: 6, fontSize: 14, lineHeight: 20, color: prism.muted },
  proDivider: { height: 1, marginVertical: 18, backgroundColor: prism.line },
  proButton: { marginTop: 22, paddingVertical: 15, borderRadius: 14, alignItems: 'center', backgroundColor: prism.soft },
  proButtonText: { fontSize: 15, fontWeight: '700', color: prism.ink },
  finePrint: { marginTop: 12, fontSize: 10, lineHeight: 15, textAlign: 'center', color: prism.muted },
  baristaNote: { ...prismPanel, flexDirection: 'row', alignItems: 'center', padding: 17, borderWidth: 1, borderColor: prism.line, borderRadius: 20, backgroundColor: prism.surface },
  cup: { width: 44, fontSize: 27 },
  baristaCopy: { flex: 1 },
  baristaTitle: { fontSize: 14, fontWeight: '700', color: prism.ink },
  baristaText: { marginTop: 3, fontSize: 11, lineHeight: 16, color: prism.muted },
  previewNote: { marginTop: 14, textAlign: 'center', fontSize: 10, fontWeight: '700', color: prism.muted },
});
