import { router } from 'expo-router';
import {
  Image,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AppBottomNav } from '@/components/AppBottomNav';
import { getTimeGreeting } from '@/lib/timeGreeting';

type Role = 'barista' | 'cafe_owner_manager';
type DashboardCounts = { jobs: number; matches: number; alerts: number; candidates: number };

type QuietFocusHomeProps = {
  role: Role;
  firstName: string;
  location?: string | null;
  profileProgress: number;
  counts: DashboardCounts;
  refreshing: boolean;
  cafePlanCopy: string;
  onRefresh: () => void;
  onOpenSettings: () => void;
};

const CAFE_IMAGE = require('../assets/editorial-latte-v3.jpg');
const BRAND_IMAGE = require('../assets/website-favicon.png');

export function QuietFocusHome({
  role,
  firstName,
  location,
  profileProgress,
  counts,
  refreshing,
  cafePlanCopy,
  onRefresh,
  onOpenSettings,
}: QuietFocusHomeProps) {
  const isCafe = role === 'cafe_owner_manager';
  const place = location?.trim() || 'your saved work area';
  const activity = isCafe
    ? [
        { icon: '▣', value: counts.jobs, label: 'Active jobs' },
        { icon: '♙', value: counts.candidates, label: 'Candidates' },
        { icon: '♡', value: counts.matches, label: 'Matches' },
      ]
    : [
        { icon: '⌕', value: counts.jobs, label: 'Open jobs' },
        { icon: '♡', value: counts.matches, label: 'Matches' },
        { icon: '●', value: counts.alerts, label: 'Alerts' },
      ];

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#b76022" />
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
            <Text style={styles.settingsIcon}>⚙</Text>
          </Pressable>
        </View>

        <Text style={styles.eyebrow}>GOOD TO SEE YOU</Text>
        <Text style={styles.greeting}>{getTimeGreeting()}, {firstName}.</Text>
        <Text style={styles.subtitle}>{isCafe ? 'Meet your next great barista.' : 'Find your next shift.'}</Text>

        <View style={styles.searchStack}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/discover')}
            style={({ pressed }) => [styles.searchField, pressed && styles.pressed]}
          >
            <Text style={styles.searchIcon}>⌕</Text>
            <Text style={styles.searchText}>{isCafe ? 'Find local baristas' : 'Find your next shift'}</Text>
            <Text style={styles.arrow}>›</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/profile')}
            style={({ pressed }) => [styles.searchField, pressed && styles.pressed]}
          >
            <Text style={styles.locationPin}>●</Text>
            <Text numberOfLines={1} style={styles.searchText}>{place}</Text>
            <Text style={styles.arrow}>›</Text>
          </Pressable>
        </View>

        <View style={styles.feature}>
          <Image source={CAFE_IMAGE} style={styles.featureImage} resizeMode="cover" accessibilityLabel="Latte in a warm café" />
          <View style={styles.featureBody}>
          <View style={styles.featureCopy}>
            <Text style={styles.featureEyebrow}>{isCafe ? 'BUILD YOUR TEAM' : 'LOCAL OPPORTUNITIES'}</Text>
            <Text style={styles.featureTitle}>{isCafe ? 'Find your next great barista' : 'Discover local cafés'}</Text>
            <Text numberOfLines={2} style={styles.featureSubtitle}>
              {isCafe ? 'Connect with people who fit your café.' : `Explore open roles around ${place}.`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/discover')}
            style={({ pressed }) => [styles.featureButton, pressed && styles.pressed]}
          >
            <Text style={styles.featureButtonText}>{isCafe ? 'Discover talent' : 'Find jobs'}  →</Text>
          </Pressable>
        </View>
        </View>

        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>Your activity</Text>

        </View>
        <View style={styles.activityRow}>
          {activity.map((item) => (
            <View key={item.label} style={styles.activityCard}>
              <Text style={styles.activityIcon}>{item.icon}</Text>
              <Text style={styles.activityValue}>{item.value}</Text>
              <Text numberOfLines={1} style={styles.activityLabel}>{item.label}</Text>
            </View>
          ))}
        </View>

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
                  <Text style={styles.planName}>Free</Text>
                  <Text style={styles.activePill}>ACTIVE</Text>
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
                <View>
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
            <View style={styles.actionGrid}>
              <ActionTile icon="♡" label="Matches" detail="See connections" onPress={() => router.push('/matches')} />
              <ActionTile icon="✉" label="Messages" detail="Start a conversation" onPress={() => router.push('/messages')} />
            </View>
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

function ActionTile({ icon, label, detail, onPress }: { icon: string; label: string; detail: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.actionTile, pressed && styles.pressed]}>
      <Text style={styles.actionTileIcon}>{icon}</Text>
      <Text style={styles.actionTileTitle}>{label}</Text>
      <Text style={styles.actionTileDetail}>{detail}</Text>
    </Pressable>
  );
}

const editorialFont = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fffdf9' },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 30 },
  pressed: { opacity: 0.78 },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  brandLockup: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  brandImage: { width: 33, height: 33, resizeMode: 'contain' },
  brand: { color: '#17110d', fontSize: 18, fontWeight: '900', letterSpacing: -0.5 },
  brandAccent: { color: '#b76022' },
  settingsButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { color: '#321708', fontSize: 20 },
  eyebrow: { color: '#71665f', fontSize: 9, fontWeight: '800', letterSpacing: 2.2 },
  greeting: { color: '#17110d', fontFamily: editorialFont, fontSize: 33, lineHeight: 38, fontWeight: '700', letterSpacing: -1.3, marginTop: 7 },
  subtitle: { color: '#71665f', fontFamily: editorialFont, fontSize: 23, lineHeight: 28, marginTop: 1, marginBottom: 17 },
  searchStack: { gap: 9, marginBottom: 13 },
  searchField: { minHeight: 47, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#eee7df', borderRadius: 17, paddingHorizontal: 15, backgroundColor: '#fff' },
  searchIcon: { color: '#b76022', fontSize: 25, marginRight: 11, lineHeight: 26 },
  locationPin: { color: '#b76022', fontSize: 12, marginRight: 14 },
  searchText: { flex: 1, color: '#3b312b', fontSize: 14 },
  arrow: { color: '#321708', fontSize: 24, marginLeft: 8 },
  feature: { borderRadius: 15, overflow: 'hidden', marginBottom: 19, backgroundColor: '#fffdfa', borderWidth: 1, borderColor: '#eee7df' },
  featureImage: { width: '100%', height: 195 },
  featureBody: { padding: 13 },
  featureCopy: { marginBottom: 12 },
  featureEyebrow: { display: 'none' },
  featureTitle: { color: '#17110d', fontFamily: editorialFont, fontSize: 24, lineHeight: 28, fontWeight: '700' },
  featureSubtitle: { color: '#71665f', fontSize: 12, lineHeight: 16, marginTop: 5 },
  featureButton: { minHeight: 43, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#b95214' },
  featureButtonText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { color: '#17110d', fontFamily: editorialFont, fontSize: 20, fontWeight: '700' },
  sectionHint: { color: '#8b7e75', fontSize: 9 },
  activityRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  activityCard: { flex: 1, minWidth: 0, minHeight: 85, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#eee7df', borderRadius: 13, backgroundColor: '#fffdfa', paddingHorizontal: 5 },
  activityIcon: { color: '#b76022', fontSize: 19, lineHeight: 23 },
  activityValue: { color: '#17110d', fontFamily: editorialFont, fontSize: 17, fontWeight: '700', marginTop: 2 },
  activityLabel: { color: '#4f443d', fontSize: 11, marginTop: 1, maxWidth: '100%' },
  planCard: { minHeight: 116, flexDirection: 'row', alignItems: 'center', backgroundColor: '#321708', borderRadius: 19, padding: 15, marginBottom: 10 },
  planBadge: { width: 46, height: 46, borderRadius: 23, borderWidth: 2, borderColor: '#b76022', alignItems: 'center', justifyContent: 'center' },
  planBadgeText: { color: '#e88a4a', fontFamily: editorialFont, fontSize: 21, fontWeight: '700' },
  planBody: { flex: 1, paddingHorizontal: 13 },
  planEyebrow: { color: '#d9c9bc', fontSize: 8, fontWeight: '800', letterSpacing: 1.4 },
  planNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
  planName: { color: '#fffdf9', fontFamily: editorialFont, fontSize: 21, fontWeight: '700' },
  activePill: { overflow: 'hidden', color: '#fff', backgroundColor: '#2d7444', borderRadius: 20, fontSize: 8, fontWeight: '900', paddingHorizontal: 8, paddingVertical: 4 },
  planCopy: { color: '#eadfd5', fontSize: 10, lineHeight: 14, marginTop: 4 },
  planArrow: { color: '#e88a4a', fontSize: 28 },
  actionRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#eadfd5', borderRadius: 16, backgroundColor: '#fff', paddingHorizontal: 15, marginBottom: 9 },
  actionRowCopy: { flex: 1 },
  actionRowTitle: { color: '#17110d', fontFamily: editorialFont, fontSize: 16, fontWeight: '700' },
  actionRowDetail: { color: '#71665f', fontSize: 10, marginTop: 3 },
  actionRowArrow: { color: '#b76022', fontSize: 25 },
  profileCard: { borderWidth: 1, borderColor: '#eadfd5', borderRadius: 19, backgroundColor: '#fff', padding: 16, marginBottom: 12 },
  profileTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  profileEyebrow: { color: '#2d7444', fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  profileTitle: { color: '#17110d', fontFamily: editorialFont, fontSize: 21, fontWeight: '700', marginTop: 3 },
  leaf: { color: '#2d7444', fontSize: 29 },
  progressTrack: { height: 7, borderRadius: 7, overflow: 'hidden', backgroundColor: '#eadfd5', marginTop: 14 },
  progressFill: { height: '100%', borderRadius: 7, backgroundColor: '#2d7444' },
  profileCopy: { color: '#71665f', fontSize: 10, lineHeight: 14, marginTop: 11 },
  actionGrid: { flexDirection: 'row', gap: 9 },
  actionTile: { flex: 1, minHeight: 96, borderWidth: 1, borderColor: '#eadfd5', borderRadius: 16, backgroundColor: '#fff', padding: 13 },
  actionTileIcon: { color: '#b76022', fontSize: 21 },
  actionTileTitle: { color: '#17110d', fontFamily: editorialFont, fontSize: 15, fontWeight: '700', marginTop: 7 },
  actionTileDetail: { color: '#71665f', fontSize: 9, marginTop: 2 },
});
