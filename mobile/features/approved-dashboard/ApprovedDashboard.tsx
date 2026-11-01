import { Image, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatJobPay } from '../../lib/marketplace';
import { Action, Avatar, EmptyCard, Icon, Section } from './DashboardPrimitives';
import { ApprovedBottomNav } from './ApprovedBottomNav';
import { countLabel, dashboardLinks, jobDestination, matchDestination, unreadLabel, type DashboardData, type Destination } from './model';
import { dashboardTheme as t, softGlassSurface } from './theme';

export type ApprovedDashboardProps = { data: DashboardData; refreshing: boolean; error?: string; onRefresh: () => void; navigate: (destination: Destination) => void };
export function ApprovedDashboard({ data, refreshing, error, onRefresh, navigate }: ApprovedDashboardProps) {
  const { width, fontScale } = useWindowDimensions();
  const wideText = fontScale > 1.5 || width < 350;
  const maximumText = fontScale > 2.5;
  const { counts, role } = data;
  const cafe = role === 'cafe_owner_manager';
  const links = dashboardLinks(role);
  const stats = [
    { label: cafe ? 'Active jobs' : 'Interests sent', value: cafe ? counts.jobs : counts.applications, destination: cafe ? links.jobs : links.sent },
    { label: 'Matches', value: counts.matches, destination: links.matches },
    { label: 'Unread messages', value: counts.messages, destination: links.messages },
  ];
  return <SafeAreaView style={s.safe} edges={Platform.OS === 'android' ? [] : ['top', 'left', 'right', 'bottom']}>
    <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.accent} />}>
      <View style={s.brandRow}>
        <View style={[s.brand, fontScale > 1.5 && s.brandLarge]}><Image source={require('../../assets/website-favicon.png')} style={s.logo} resizeMode="contain" accessible={false} />
          <View style={s.brandName}><Text style={s.brandText}>Barista</Text><Text style={[s.brandText, s.brandAccent]}>Match</Text></View></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Notifications${counts.alerts ? `, ${counts.alerts} unread` : ''}`} onPress={() => navigate({ pathname: '/notifications' })} style={[s.bell, maximumText && s.bellMaximum]}>
          <Icon name="notifications-outline" size={28} />{counts.alerts > 0 ? <View style={s.dot} /> : null}
        </Pressable>
      </View>
      {error ? <View style={s.error}><Text accessibilityRole="alert" style={s.errorText}>Showing your last loaded details. {error}</Text><Action softGlass label="Try again" onPress={onRefresh} disabled={refreshing} /></View> : null}
      <Text accessibilityRole="header" style={[s.title, fontScale > 1.5 && s.largeTitle, maximumText && s.maximumTitle]}>Dashboard</Text>
      <Text style={s.subtitle}>{cafe ? 'Your hiring, at a glance.' : 'Your job search, at a glance.'}</Text>
      <Action softGlass primary label={cafe ? 'Post a job' : 'Find barista jobs'} icon={cafe ? 'add' : 'search-outline'} onPress={() => navigate(links.primary)} />
      <View style={[s.stats, wideText && s.statsWrap]}>{stats.map(stat => <Pressable key={stat.label} accessibilityRole="button"
        accessibilityLabel={`${stat.value} ${stat.label.toLowerCase()}`} onPress={() => navigate(stat.destination)} style={[s.stat, wideText && s.statWide, maximumText && s.statMaximum]}>
        <Text style={s.count}>{countLabel(stat.value)}</Text><Text style={s.statLabel}>{stat.label}</Text>
      </Pressable>)}</View>
      <Pressable accessibilityRole="button" accessibilityLabel={counts.messages ? unreadLabel(counts.messages) : 'Open messages'} onPress={() => navigate(links.messages)} style={s.messageNotice}>
        <Icon name="chatbubble-outline" color={t.accent} /><Text style={s.noticeText}>{counts.messages ? unreadLabel(counts.messages) : 'You have no unread messages'}</Text><Icon name="chevron-forward" size={20} />
      </Pressable>
      <Section softGlass title={cafe ? 'Your jobs' : data.location ? `Jobs in ${data.location}` : 'Jobs near you'} action="View all" onPress={() => navigate(links.jobs)}>
        {data.jobs.length ? data.jobs.map(job => <View key={job.id} style={s.card}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${cafe ? 'Manage job' : 'Open details'}: ${job.title}`} onPress={() => navigate(jobDestination(role, job.id))} style={[s.jobRow, maximumText && s.verticalCard]}><View style={s.cup}><Icon name="cafe-outline" size={31} color={t.accent} /></View><View style={[s.cardBody, maximumText && s.maximumCardBody]}>
            <Text style={s.cardTitle}>{job.title || 'Untitled role'}</Text>
            {!cafe ? <Text style={s.meta}>{job.owner?.cafe_name || 'Café name unavailable'}</Text> : null}
            <Text style={s.meta}>{job.location || [job.city, job.state].filter(Boolean).join(', ') || 'Location not listed'} · {job.schedule || 'Schedule not listed'}</Text>
          </View></Pressable>
          <View style={s.jobFooter}>{cafe ? <Text style={s.status}>{job.active ? 'Active' : 'Paused'}</Text> : null}
            <Text style={[s.meta, !cafe && s.pay]}>{formatJobPay(job)}</Text>
            {!cafe ? <Pressable accessibilityRole="button" accessibilityLabel={`View job: ${job.title}`} style={s.cardAction} onPress={() => navigate(jobDestination(role, job.id))}>
              <Text style={s.link}>View job</Text><Icon name="arrow-forward" size={20} color={t.accent} />
            </Pressable> : null}
            {cafe ? <Pressable accessibilityRole="button" accessibilityLabel={`View matches for ${job.title}`} style={s.cardAction} onPress={() => navigate({ pathname: '/matches', params: { jobId: job.id } })}>
              <Text style={s.link}>View matches</Text><Icon name="arrow-forward" size={20} color={t.accent} />
            </Pressable> : null}
          </View>
        </View>) : <EmptyCard softGlass title={cafe ? 'No active jobs yet' : 'No jobs in your saved area yet'} body={cafe ? 'Post your first role, or open Jobs to manage paused posts.' : 'Check back for new roles, or update your preferred work area in Profile.'} />}
      </Section>
      <Section softGlass title="Your matches" action="View all" onPress={() => navigate(links.matches)}>
        {data.matches.length ? <View style={s.matchCard}>{data.matches.map((match, index) => <Pressable key={`${match.kind}:${match.id}`} accessibilityRole="button"
          accessibilityLabel={`Open conversation with ${match.name}, ${match.detail}`} onPress={() => navigate(matchDestination(match))} style={[s.match, maximumText && s.verticalCard, index > 0 && s.matchDivider]}>
          <Avatar uri={match.avatarUrl} name={match.name} cafe={!cafe} /><View style={[s.cardBody, maximumText && s.maximumCardBody]}><Text style={s.cardTitle}>{match.name}</Text><Text style={s.meta}>{match.detail}</Text></View><Icon name="chevron-forward" size={20} color={t.muted} />
        </Pressable>)}</View> : <EmptyCard softGlass title="No mutual matches yet" body={cafe ? 'Review applicants and incoming interests to make a match.' : 'A sent interest becomes a match when both sides agree.'} />}
      </Section>
      <Section softGlass title="Your account">
        <View style={s.tools}>
          {cafe ? <><Action softGlass label="Find baristas" onPress={() => navigate({ pathname: '/discover' })} /><Action softGlass label={`Review applicants (${counts.candidates})`} onPress={() => navigate({ pathname: '/candidates' })} /></> : <Action softGlass label="Applications and interests" onPress={() => navigate(links.sent)} />}
          <Action softGlass label={`Profile ${data.profileProgress}% complete`} onPress={() => navigate({ pathname: '/profile' })} />
          <Action softGlass label="Account settings" onPress={() => navigate({ pathname: '/settings' })} />
        </View>
      </Section>
    </ScrollView>
    <ApprovedBottomNav softGlass active="home" role={role} unread={counts.messages} />
  </SafeAreaView>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: t.background }, scroll: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, maxWidth: 680, width: '100%', alignSelf: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }, brand: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 },
  logo: { width: 35, height: 39, flexShrink: 0 }, brandLarge: { flexDirection: 'column', alignItems: 'flex-start' }, brandName: { flex: 1, minWidth: 0, maxWidth: '100%', flexDirection: 'row', flexWrap: 'wrap' }, brandText: { color: t.ink, fontFamily: t.headingFont, fontSize: 25, fontWeight: '700', flexShrink: 1, maxWidth: '100%' }, brandAccent: { color: t.accent },
  bell: { ...softGlassSurface, borderRadius: 24, minHeight: 48, width: 48, alignItems: 'center', justifyContent: 'center', flexShrink: 0, shadowOpacity: 0.04, shadowRadius: 8 }, dot: { position: 'absolute', top: 7, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent },
  bellMaximum: { position: 'absolute', top: 0, right: 0 }, maximumTitle: { fontSize: 18 }, statMaximum: { flexBasis: '100%' },
  title: { fontFamily: t.interfaceFont, fontSize: 32, letterSpacing: -0.7, fontWeight: '700', color: t.ink }, largeTitle: { fontSize: 22 }, subtitle: { color: t.muted, fontSize: 16, lineHeight: 22, marginTop: 4, marginBottom: 16 },
  stats: { flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 12 }, statsWrap: { flexWrap: 'wrap' }, stat: { ...softGlassSurface, flex: 1, minWidth: 0, minHeight: 86, borderRadius: 20, paddingHorizontal: 6, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' }, statWide: { flexBasis: '45%', flexGrow: 1 },
  count: { fontSize: 28, fontWeight: '700', color: t.ink, textAlign: 'center', fontVariant: ['tabular-nums'] }, statLabel: { fontSize: 13, color: t.muted, textAlign: 'center', marginTop: 4 },
  messageNotice: { ...softGlassSurface, minHeight: 52, backgroundColor: t.soft, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, shadowOpacity: 0.04 }, noticeText: { flex: 1, color: t.ink, fontSize: 15, fontWeight: '500' },
  card: { ...softGlassSurface, padding: 16, marginBottom: 10 }, jobRow: { minHeight: 48, flexDirection: 'row', alignItems: 'flex-start', gap: 13 }, cup: { width: 48, height: 48, borderRadius: 16, backgroundColor: t.soft, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  verticalCard: { flexDirection: 'column', alignItems: 'flex-start' }, maximumCardBody: { flex: 0, width: '100%' },
  cardBody: { flex: 1, minWidth: 0 }, cardTitle: { color: t.ink, fontSize: 19, fontWeight: '600' }, meta: { fontSize: 14, lineHeight: 20, color: t.muted, marginTop: 3 },
  jobFooter: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 4 }, status: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 13, backgroundColor: t.successBackground, color: t.success, fontSize: 13, marginRight: 'auto' },
  pay: { marginRight: 'auto' }, cardAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 3 }, link: { fontSize: 14, color: t.accent, fontWeight: '500' },
  matchCard: { ...softGlassSurface, paddingHorizontal: 16 }, match: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 10 }, matchDivider: { borderTopWidth: 1, borderTopColor: t.border },
  tools: { gap: 10 }, error: { gap: 10, borderWidth: 1, borderColor: t.statBorder, padding: 16, borderRadius: 22, marginBottom: 14 }, errorText: { color: t.error, fontSize: 15, lineHeight: 22 },
});
