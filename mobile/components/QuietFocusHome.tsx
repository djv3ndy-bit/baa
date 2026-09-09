import { router } from 'expo-router';
import {
  Image,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { AppBottomNav } from '@/components/AppBottomNav';
import { getTimeGreeting } from '@/lib/timeGreeting';
import type { DashboardCounts } from '@/lib/homeSummary';

type Role = 'barista' | 'cafe_owner_manager';

type QuietFocusHomeProps = {
  role: Role;
  firstName: string;
  location?: string | null;
  profileProgress: number;
  counts: DashboardCounts;
  refreshing: boolean;
  cafePlanCopy: string;
  error?: string;
  onRefresh: () => void;
  onOpenSettings: () => void;
};

const CAFE_IMAGE = require('../assets/editorial-latte-v3.jpg');
const BRAND_IMAGE = require('../assets/website-favicon.png');
const prism = {
  background: '#ffffff',
  surface: '#ffffff',
  soft: '#f7f7f7',
  ink: '#292521',
  muted: '#706b66',
  line: '#e9e7e5',
  accent: '#a94716',
};

const floatingSurface = {
  backgroundColor: prism.surface,
  borderWidth: 1,
  borderColor: prism.line,
  shadowColor: '#25211d',
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.035,
  shadowRadius: 12,
  elevation: 1,
};

export function QuietFocusHome({
  role,
  firstName,
  location,
  profileProgress,
  counts,
  refreshing,
  cafePlanCopy,
  error,
  onRefresh,
  onOpenSettings,
}: QuietFocusHomeProps) {
  const isCafe = role === 'cafe_owner_manager';
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale > 1.3;
  const place = location?.trim() || 'your saved work area';
  const activity = isCafe
    ? [
        { icon: '▣', value: counts.jobs, label: 'Active jobs', path: '/jobs' },
        { icon: '♙', value: counts.candidates, label: 'Candidates', path: '/candidates' },
        { icon: '♡', value: counts.matches, label: 'Matches', path: '/matches' },
        { icon: '◌', value: counts.messages, label: 'Unread messages', path: '/messages' },
      ]
    : [
        { icon: '⌕', value: counts.jobs, label: 'Open jobs', path: '/discover' },
        { icon: '♡', value: counts.matches, label: 'Matches', path: '/matches' },
        { icon: '◌', value: counts.messages, label: 'Unread messages', path: '/messages' },
      ];

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={prism.accent} />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brandRow}>
          <View style={styles.brandLockup}><Image source={BRAND_IMAGE} style={styles.brandImage} accessibilityIgnoresInvertColors /><Text style={styles.brand}>Barista<Text style={styles.brandAccent}>Match</Text></Text></View>
          <Pressable
            accessibilityLabel="Open settings"
            accessibilityRole="button"
            hitSlop={8}
            onPress={onOpenSettings}
            style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
          >
            <Text allowFontScaling={false} style={styles.settingsIcon}>⚙</Text>
          </Pressable>
        </View>

        {error ? <View style={styles.refreshError}><Text accessibilityRole="alert" style={styles.refreshErrorText}>Showing your last loaded details. {error}</Text><Pressable accessibilityRole="button" onPress={onRefresh}><Text style={styles.refreshRetry}>Try again</Text></Pressable></View> : null}

        {isCafe ? <Text style={styles.eyebrow}>GOOD TO SEE YOU</Text> : null}
        <Text style={[styles.greeting, !isCafe && styles.guidedGreeting]}>{getTimeGreeting()}, {firstName}.</Text>
        <Text style={[styles.subtitle, !isCafe && styles.guidedSubtitle]}>{isCafe ? 'Meet your next great barista.' : 'Find your next shift.'}</Text>

        <View style={[styles.searchStack, !isCafe && !largeText && styles.guidedSearch]}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/discover')}
            style={({ pressed }) => [styles.searchField, !isCafe && !largeText && styles.guidedSearchField, pressed && styles.pressed]}
          >
            <Text style={styles.searchIcon}>⌕</Text>
            <Text style={styles.searchText}>{isCafe ? 'Find local baristas' : 'Search jobs'}</Text>
            <Text style={styles.arrow}>›</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/profile')}
            style={({ pressed }) => [styles.searchField, !isCafe && !largeText && styles.guidedSearchField, pressed && styles.pressed]}
          >
            <Text style={styles.locationPin}>●</Text>
            <Text numberOfLines={1} style={styles.searchText}>{place}</Text>
            <Text style={styles.arrow}>›</Text>
          </Pressable>
        </View>

        <View style={styles.feature}>
          <Image source={CAFE_IMAGE} style={[styles.featureImage, largeText && styles.featureImageFlow]} resizeMode="cover" accessibilityLabel="Latte in a warm café" />
          <View style={styles.featureBody}>
          <View style={[styles.featureCopy, largeText && styles.featureCopyFull]}>
            <Text style={styles.featureEyebrow}>{isCafe ? 'BUILD YOUR TEAM' : 'LOCAL OPPORTUNITIES'}</Text>
            <Text style={styles.featureTitle}>{isCafe ? 'Find your next great barista' : 'Discover local cafés'}</Text>
            <Text style={styles.featureSubtitle}>
              {isCafe ? 'Connect with people who fit your café.' : `Explore open roles around ${place}.`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/discover')}
            style={({ pressed }) => [styles.featureButton, pressed && styles.pressed]}
          >
            <Text style={styles.featureButtonText}>{isCafe ? 'Discover talent' : 'Explore jobs'}  →</Text>
          </Pressable>
        </View>
        </View>

        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>Your activity</Text>

        </View>
        {isCafe ? <View style={styles.activityRow}>
          {activity.map((item) => (
            <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={`${item.value} ${item.label}`} onPress={() => router.push(item.path as never)} style={[styles.activityCard, largeText && styles.activityCardWide]}>
              <Text allowFontScaling={false} style={styles.activityIcon}>{item.icon}</Text>
              <View style={styles.activityMetric}>
                <Text style={styles.activityValue}>{item.value}</Text>
                <Text style={styles.activityLabel}>{item.label}</Text>
              </View>
            </Pressable>
          ))}
        </View> : <View style={styles.guidedActivity}>
          <ActionRow label="Open jobs" detail={`${counts.jobs} roles in your saved work area`} onPress={() => router.push('/discover')} />
          <ActionRow label="Applications & interests" detail={`${counts.applications} sent · Track your progress`} onPress={() => router.push('/discover?tab=sent' as never)} />
          <ActionRow label="Matches" detail={`${counts.matches} connections`} onPress={() => router.push('/matches')} />
          <ActionRow label="Messages" detail={counts.messages ? `${counts.messages} unread messages` : 'Open your conversations'} onPress={() => router.push('/messages')} />
          <ActionRow label="My Profile" detail="Manage your information" onPress={() => router.push('/profile')} />
        </View>}

        {isCafe ? (
          <>
            <Pressable
              accessibilityLabel="View café plans"
              accessibilityRole="button"
              onPress={() => router.push('/subscription')}
              style={({ pressed }) => [styles.planCard, pressed && styles.pressed]}
            >
              <View style={styles.planBadge}><Text style={styles.planBadgeText}>1</Text></View>
              <View style={styles.planBody}>
                <Text style={styles.planEyebrow}>YOUR CAFÉ PLAN</Text>
                <View style={styles.planNameRow}>
                  <Text style={styles.planName}>Café plan</Text>
                  <Text style={styles.activePill}>DETAILS</Text>
                </View>
                <Text style={styles.planCopy}>{cafePlanCopy}</Text>
              </View>
              <Text style={styles.planArrow}>›</Text>
            </Pressable>
            <ActionRow
              detail="Create, edit, and close café roles"
              label="Manage job posts"
              onPress={() => router.push('/jobs')}
            />
            <ActionRow
              detail="Publish an opportunity for local baristas"
              label="Post a new job"
              onPress={() => router.push('/post-job')}
            />
          </>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/profile')}
              style={({ pressed }) => [styles.profileCard, pressed && styles.pressed]}
            >
              <View style={styles.profileTop}>
                <View style={styles.profileHeading}>
                  <Text style={styles.profileEyebrow}>YOUR PROFILE</Text>
                  <Text style={styles.profileTitle}>{profileProgress}% complete</Text>
                </View>
                <Text style={styles.leaf}>♧</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${profileProgress}%` }]} />
              </View>
              <Text style={styles.profileCopy}>Keep your experience, skills, and availability current.</Text>
            </Pressable>

          </>
        )}
      </ScrollView>
      <AppBottomNav active="home" role={role} />
    </SafeAreaView>
  );
}

function ActionRow({ label, detail, onPress }: { label: string; detail: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}>
      <View style={styles.actionRowCopy}>
        <Text style={styles.actionRowTitle}>{label}</Text>
        <Text style={styles.actionRowDetail}>{detail}</Text>
      </View>
      <Text style={styles.actionRowArrow}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  refreshError: { padding: 16, borderRadius: 18, borderWidth: 1, borderColor: '#ead8ce', backgroundColor: '#fffaf7', marginBottom: 18 },
  refreshErrorText: { fontSize: 13, color: '#84341f', lineHeight: 19 },
  refreshRetry: { fontSize: 14, color: prism.ink, fontWeight: '600', paddingTop: 12, minHeight: 44 },
  guidedGreeting: { fontSize: 28, lineHeight: 34, marginTop: 0 },
  guidedSubtitle: { fontSize: 16, lineHeight: 23, marginBottom: 23 },
  guidedSearch: { flexDirection: 'row', gap: 10 },
  guidedSearchField: { flex: 1, minWidth: 0, paddingHorizontal: 11 },
  guidedActivity: { marginBottom: 10 },
  safe: { flex: 1, backgroundColor: prism.background },
  content: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 30 },
  pressed: { opacity: 0.78 },
  brandRow: { gap: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 26 },
  brandLockup: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 },
  brandImage: { flexShrink: 0, width: 32, height: 32, resizeMode: 'contain' },
  brand: { flexShrink: 1, minWidth: 0, color: prism.ink, fontSize: 19, fontWeight: '600', letterSpacing: -0.5 },
  brandAccent: { color: prism.accent },
  settingsButton: { ...floatingSurface, flexShrink: 0, width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { color: prism.ink, fontSize: 20 },
  eyebrow: { color: prism.muted, fontSize: 10, fontWeight: '500', letterSpacing: 1.3 },
  greeting: { color: prism.ink, fontSize: 29, lineHeight: 35, fontWeight: '500', letterSpacing: -0.9, marginTop: 8 },
  subtitle: { color: prism.muted, fontSize: 17, lineHeight: 24, marginTop: 4, marginBottom: 23 },
  searchStack: { gap: 10, marginBottom: 18 },
  searchField: { ...floatingSurface, minHeight: 50, flexDirection: 'row', alignItems: 'center', borderRadius: 17, paddingHorizontal: 15, paddingVertical: 8 },
  searchIcon: { color: prism.accent, fontSize: 23, marginRight: 10, lineHeight: 26 },
  locationPin: { color: prism.accent, fontSize: 10, marginRight: 12 },
  searchText: { flex: 1, minWidth: 0, color: prism.ink, fontSize: 13, lineHeight: 19 },
  arrow: { color: prism.muted, fontSize: 23, marginLeft: 7 },
  feature: { ...floatingSurface, borderRadius: 24, marginBottom: 24, padding: 21 },
  featureImage: { position: 'absolute', top: 21, right: 21, width: 68, height: 76, borderRadius: 17 },
  featureImageFlow: { position: 'relative', top: 0, right: 0, marginBottom: 17 },
  featureBody: { minWidth: 0 },
  featureCopy: { paddingRight: 85, minHeight: 90, marginBottom: 18 },
  featureCopyFull: { paddingRight: 0, minHeight: 0 },
  featureEyebrow: { color: prism.accent, fontSize: 10, lineHeight: 14, fontWeight: '500', letterSpacing: 0.9, marginBottom: 9 },
  featureTitle: { color: prism.ink, fontSize: 24, lineHeight: 28, fontWeight: '500', letterSpacing: -0.6 },
  featureSubtitle: { color: prism.muted, fontSize: 12, lineHeight: 18, marginTop: 9 },
  featureButton: { paddingHorizontal: 14, paddingVertical: 13, minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: prism.ink },
  featureButtonText: { textAlign: 'center', flexShrink: 1, color: prism.surface, fontSize: 14, lineHeight: 20, fontWeight: '500' },
  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 13 },
  sectionTitle: { color: prism.ink, fontSize: 18, fontWeight: '500', letterSpacing: -0.3 },
  activityRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  activityCard: { ...floatingSurface, flex: 1, minWidth: '44%', minHeight: 88, flexDirection: 'row', alignItems: 'center', gap: 11, borderRadius: 18, padding: 14 },
  activityCardWide: { minWidth: '100%' },
  activityIcon: { flexShrink: 0, width: 21, color: prism.accent, fontSize: 21, lineHeight: 26, textAlign: 'center' },
  activityMetric: { flex: 1, minWidth: 0 },
  activityValue: { color: prism.ink, fontSize: 23, lineHeight: 28, fontWeight: '500', letterSpacing: -0.5 },
  activityLabel: { color: prism.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  planCard: { ...floatingSurface, minHeight: 116, flexDirection: 'row', alignItems: 'center', borderRadius: 24, padding: 18, marginBottom: 12 },
  planBadge: { flexShrink: 0, width: 42, minHeight: 42, paddingVertical: 7, borderRadius: 14, backgroundColor: prism.soft, alignItems: 'center', justifyContent: 'center' },
  planBadgeText: { color: prism.accent, fontSize: 22, fontWeight: '500' },
  planBody: { flex: 1, minWidth: 0, paddingHorizontal: 12 },
  planEyebrow: { color: prism.muted, fontSize: 10, lineHeight: 15, fontWeight: '500', letterSpacing: 0.8 },
  planNameRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginTop: 5 },
  planName: { color: prism.ink, fontSize: 20, lineHeight: 26, fontWeight: '500' },
  activePill: { overflow: 'hidden', color: prism.muted, backgroundColor: prism.soft, borderRadius: 8, fontSize: 9, fontWeight: '500', paddingHorizontal: 7, paddingVertical: 4 },
  planCopy: { color: prism.muted, fontSize: 12, lineHeight: 18, marginTop: 7 },
  planArrow: { color: prism.muted, fontSize: 26 },
  actionRow: { ...floatingSurface, minHeight: 76, flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 17, paddingVertical: 14, marginBottom: 11 },
  actionRowCopy: { flex: 1, minWidth: 0 },
  actionRowTitle: { color: prism.ink, fontSize: 15, lineHeight: 21, fontWeight: '500' },
  actionRowDetail: { color: prism.muted, fontSize: 12, lineHeight: 18, marginTop: 5 },
  actionRowArrow: { flexShrink: 0, color: prism.accent, fontSize: 25, marginLeft: 12 },
  profileCard: { ...floatingSurface, borderRadius: 24, padding: 21, marginBottom: 12 },
  profileHeading: { flex: 1, minWidth: 0 },
  profileTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  profileEyebrow: { color: prism.muted, fontSize: 10, fontWeight: '500', letterSpacing: 1 },
  profileTitle: { color: prism.ink, fontSize: 23, lineHeight: 29, fontWeight: '500', letterSpacing: -0.4, marginTop: 7 },
  leaf: { flexShrink: 0, color: prism.accent, fontSize: 27 },
  progressTrack: { height: 6, borderRadius: 6, overflow: 'hidden', backgroundColor: prism.line, marginTop: 19 },
  progressFill: { height: '100%', borderRadius: 6, backgroundColor: prism.ink },
  profileCopy: { color: prism.muted, fontSize: 12, lineHeight: 18, marginTop: 14 },
});
