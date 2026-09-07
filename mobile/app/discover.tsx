import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppBottomNav } from '@/components/AppBottomNav';
import { getCurrentContext, AppRole } from '@/lib/session';
import { sendDiscoveryInterest } from '@/lib/discovery';
import { workAreaLabel } from '@/lib/floridaLocation';
import { applicationStatus, applyToMarketplaceJob, formatJobPay, interestState, loadMarketplace, Marketplace, MarketJob, MarketProfile, profileVideoUrl } from '@/lib/marketplace';

type Tab = 'browse' | 'received' | 'sent';
const emptyData: Marketplace = { jobs: [], candidates: [], applications: [], interests: [], matches: [], profiles: {} };
export default function DiscoverScreen() {
  const params = useLocalSearchParams<{ tab?: string; jobId?: string }>();
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<MarketJob[]>([]);
  const [role, setRole] = useState<AppRole>('barista');
  const [candidates, setCandidates] = useState<MarketProfile[]>([]);
  const [data, setData] = useState<Marketplace>(emptyData);
  const [profile, setProfile] = useState<MarketProfile | null>(null);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('browse');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0), action = useRef(false), focused = useRef(false);
  const load = useCallback(async () => {
    const version = ++request.current;
    setLoading(true); setError('');
    try {
      const context = await getCurrentContext();
      if (version !== request.current) return;
      if (!context.user) { router.replace('/login'); return; }
      if (!context.profile || !context.role) throw new Error('Your account profile could not be loaded. Refresh to try again.');
      const next = await loadMarketplace(context.user.id, context.role, context.profile, params.jobId);
      if (version !== request.current) return;
      setRole(context.role); setUserId(context.user.id); setProfile(context.profile); setData(next); setJobs(next.jobs); setCandidates(next.candidates); if (params.jobId && next.requestedJob) setExpanded(`job:${next.requestedJob.id}`);
    } catch (caught) {
      if (version === request.current) { setError(caught instanceof Error ? caught.message : 'Your results could not load. Please refresh.'); setJobs([]); setCandidates([]); setData(emptyData); }
    } finally { if (version === request.current) setLoading(false); }
  }, [params.jobId]);
  useFocusEffect(useCallback(() => { focused.current = true; if (params.tab === 'received' || params.tab === 'sent') setTab(params.tab); else if (params.tab === 'applications') setTab('sent'); void load(); return () => { focused.current = false; request.current++; }; }, [load, params.tab]));

  async function respond(targetId: string) {
    if (action.current) return;
    if (!profile?.is_discoverable || profile.suspended_at) { Alert.alert('Complete your profile', 'Save every required profile detail before connecting.', [{ text: 'Open profile', onPress: () => router.push('/profile') }, { text: 'Cancel', style: 'cancel' }]); return; }
    action.current = true; setBusy(true);
    try {
      const result = await sendDiscoveryInterest(userId, targetId, role);
      if (focused.current) { await load(); Alert.alert(result.matched ? 'It’s a match!' : 'Interest sent', result.matched ? 'Open Matches to start a conversation.' : 'This profile can now review your interest.'); }
    } catch (caught) { if (focused.current) Alert.alert('Interest not confirmed', caught instanceof Error ? caught.message : 'Please refresh and retry.'); }
    finally { action.current = false; setBusy(false); }
  }
  async function apply(job: MarketJob) {
    if (action.current) return;
    if (!profile?.is_discoverable || profile.suspended_at) { Alert.alert('Complete your profile', 'Save every required profile detail before applying.', [{ text: 'Open profile', onPress: () => router.push('/profile') }, { text: 'Cancel', style: 'cancel' }]); return; }
    action.current = true; setBusy(true);
    try { await applyToMarketplaceJob(job.id, userId); if (focused.current) { await load(); Alert.alert('Application sent', 'Track this role in Sent & applications.'); } }
    catch (caught) { if (focused.current) Alert.alert('Application not confirmed', caught instanceof Error ? caught.message : 'Please refresh and retry.'); }
    finally { action.current = false; setBusy(false); }
  }
  async function viewVideo(path: string) { try { await Linking.openURL(await profileVideoUrl(path)); } catch { Alert.alert('Video unavailable', 'This video could not open. Please refresh and try again.'); } }
  function profileCard(person: MarketProfile | undefined, id: string) {
    if (!person) return <View key={id} style={s.card}><Text style={s.name}>Profile currently unavailable</Text><Text style={s.copy}>This connection may no longer be available. Refresh to check again.</Text></View>;
    const state = interestState(data, userId, id), open = expandedProfile === id;
    return <View key={id} style={s.card}>
      {person.avatar_url ? <Image source={{ uri: person.avatar_url }} style={s.photo} accessibilityLabel={`${person.cafe_name || person.display_name || 'Profile'} photo`} /> : null}
      <Text style={s.name}>{person.cafe_name || person.display_name || 'Profile'}</Text><Text style={s.meta}>{person.location || 'Location not added'}</Text>
      <Text style={s.copy} numberOfLines={open ? undefined : 3}>{person.bio || 'Introduction not added.'}</Text>
      {open ? <View><Detail label="Skills" value={person.skills?.join(' · ')} /><Detail label="Experience" value={person.experience} /><Detail label="Availability" value={person.availability} /><Detail label="Desired pay" value={person.pay_expectation} /><Detail label="Café address" value={person.cafe_address} /><Detail label="Opening hours" value={person.open_hours} /><Detail label="Shop type" value={person.shop_type} /><Detail label="Barista preferences" value={person.barista_preferences?.join(' · ')} />{person.bar_picture_url ? <Image source={{ uri: person.bar_picture_url }} accessibilityLabel="Café coffee bar" style={s.barPhoto} /> : null}{person.video_path ? <Pressable accessibilityRole="button" style={s.secondary} onPress={() => void viewVideo(person.video_path!)}><Text style={s.secondaryText}>Watch coffee showcase</Text></Pressable> : null}</View> : null}
      {person.cafe_name ? <Text style={s.copy}>Connect with this café overall. Apply to a job separately to track that role.</Text> : null}
      <View style={s.actions}><Pressable accessibilityRole="button" style={s.secondary} onPress={() => setExpandedProfile(open ? null : id)}><Text style={s.secondaryText}>{open ? 'Hide profile' : 'View profile'}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy || state.disabled} style={[s.primary, (busy || state.disabled) && s.disabled]} onPress={() => respond(id)}><Text style={s.primaryText}>{state.label}</Text></Pressable></View>
    </View>;
  }
  function jobCard(job: MarketJob) { const application = data.applications.find(row => row.job_id === job.id), open = expanded === `job:${job.id}`; return <View key={job.id} style={s.card}>
          <Text style={s.name}>{job.title}</Text><Text style={s.meta}>{job.owner?.cafe_name || 'Café'} · {job.location}</Text><Text style={s.pay}>{formatJobPay(job)}</Text><Text style={s.copy}>{job.schedule || 'Schedule not listed'}</Text>
          {open ? <><Detail label="Address" value={[job.address_line1, job.address_line2, job.city || job.location, job.state, job.postal_code].filter(Boolean).join(', ')} /><Detail label="About the role" value={job.description || 'Description not added.'} /><Detail label="Required skills" value={job.required_skills?.join(' · ') || 'No specific skills listed'} />{job.owner ? profileCard(job.owner, job.owner_id) : null}</> : <Text numberOfLines={3} style={s.copy}>{job.description}</Text>}
          <View style={s.actions}><Pressable accessibilityRole="button" style={s.secondary} onPress={() => setExpanded(open ? null : `job:${job.id}`)}><Text style={s.secondaryText}>{open ? 'Hide details' : 'Full job details'}</Text></Pressable><Pressable accessibilityRole="button" disabled={busy || !!application} style={[s.primary, (busy || !!application) && s.disabled]} onPress={() => apply(job)}><Text style={s.primaryText}>{application ? applicationStatus(application.status) : 'Apply to this job'}</Text></Pressable></View>
        </View>; }
  const query = search.trim().toLowerCase();
  const visibleJobs = jobs.filter(job => job.id !== data.requestedJob?.id).filter(job => [job.title, job.location, job.owner?.cafe_name, job.description, job.schedule, job.required_skills?.join(' ')].join(' ').toLowerCase().includes(query));
  const visibleCandidates = candidates.filter(person => [person.display_name, person.location, person.bio, person.skills?.join(' '), person.availability].join(' ').toLowerCase().includes(query));
  const received = data.interests.filter(row => row.target_id === userId && !interestState(data, userId, row.sender_id).match);
  const sent = data.interests.filter(row => row.sender_id === userId);
  return <SafeAreaView style={s.safe}>
    <View style={s.header}><View style={s.headerCopy}><Text style={s.title}>{role === 'barista' ? 'Find Jobs' : 'Discover baristas'}</Text><Text style={s.subtitle}>{role === 'barista' ? (profile ? workAreaLabel(profile) : 'Your saved work area') : 'Your café’s saved city or ZIP'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Open account settings" onPress={() => router.push('/settings')} style={s.settings}><Text allowFontScaling={false} style={s.settingsText}>⚙</Text></Pressable></View>
    <View style={s.tabs}>{(['browse', 'received', 'sent'] as Tab[]).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} style={[s.tab, tab === value && s.selectedTab]} onPress={() => setTab(value)}><Text style={s.tabText}>{value === 'browse' ? 'Browse' : value === 'received' ? `Interested in you (${received.length})` : 'Sent & applications'}</Text></Pressable>)}</View>
    <ScrollView contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
      <Pressable accessibilityRole="button" disabled={loading || busy} style={s.secondary} onPress={() => void load()}><Text style={s.secondaryText}>Refresh results</Text></Pressable>
      {loading ? <View style={s.empty}><ActivityIndicator size="large" color="#321708" /><Text style={s.copy}>Loading your current results…</Text></View> : error ? <View style={s.empty}><Text style={s.name}>Results could not load</Text><Text accessibilityRole="alert" style={s.copy}>{error}</Text></View> : tab === 'browse' ? <>
        {params.jobId && role === 'barista' ? <View><Text style={s.sectionTitle}>Requested job</Text>{data.requestedJob ? jobCard(data.requestedJob) : <Text style={s.copy}>This job is no longer available. It may have been paused or removed.</Text>}</View> : null}
        <Text style={s.copy}>Matches use the exact saved city or ZIP. Update your profile to change your search area.</Text><Pressable onPress={() => router.push('/profile')} style={s.secondary}><Text style={s.secondaryText}>Update search area</Text></Pressable>
        <TextInput accessibilityLabel={role === 'barista' ? 'Search jobs' : 'Search baristas'} placeholder={role === 'barista' ? 'Search title, café, skill…' : 'Search name, skill…'} value={search} onChangeText={setSearch} style={s.search} />
        <Text accessibilityLiveRegion="polite" style={s.sectionTitle}>{role === 'barista' ? visibleJobs.length : visibleCandidates.length} {role === 'barista' ? 'jobs' : 'baristas'}</Text>
        {role === 'barista' ? visibleJobs.map(jobCard) : visibleCandidates.map(person => profileCard(person, person.id))}
        {!(role === 'barista' ? visibleJobs.length : visibleCandidates.length) ? <View style={s.empty}><Text style={s.name}>{query ? 'No matching results' : 'No results in your saved area yet'}</Text><Text style={s.copy}>{query ? 'Try another name, title or skill.' : 'New profiles and opportunities will appear here as they become available.'}</Text>{query ? <Pressable style={s.secondary} onPress={() => setSearch('')}><Text style={s.secondaryText}>Clear search</Text></Pressable> : null}</View> : null}
      </> : tab === 'received' ? <><Text style={s.sectionTitle}>Interested in you</Text><Text style={s.copy}>Review these profiles even if they are outside your saved search area or have no current job listing.</Text>{received.map(row => profileCard(data.profiles[row.sender_id], row.sender_id))}{!received.length ? <Text style={s.copy}>No new profile interests yet. Mutual connections are in Matches.</Text> : null}</> : <>
        <Text style={s.sectionTitle}>Sent profile interests</Text>{sent.map(row => profileCard(data.profiles[row.target_id], row.target_id))}{!sent.length ? <Text style={s.copy}>Your profile interests will appear here after you send one.</Text> : null}
        <Text style={s.sectionTitle}>{role === 'barista' ? 'Your applications' : 'Job applicants'}</Text>{data.applications.map(row => <View key={row.id} style={s.card}><Text style={s.name}>{row.job?.title || 'Job no longer available'}</Text><Text style={s.meta}>{role === 'barista' ? data.profiles[row.job?.owner_id || '']?.cafe_name || 'Café' : row.barista?.display_name || 'Barista'}</Text><Text style={s.copy}>{applicationStatus(row.status)}{row.job?.active === false ? ' · Job paused' : ''}</Text>{row.status === 'matched' ? <Pressable style={s.primary} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: row.id, kind: 'application' } })}><Text style={s.primaryText}>Open conversation</Text></Pressable> : null}</View>)}{!data.applications.length ? <Text style={s.copy}>{role === 'barista' ? 'Apply to a specific job to track it here.' : 'Applications to your jobs will appear here.'}</Text> : null}
      </>}
    </ScrollView><AppBottomNav active="discover" role={role} />
  </SafeAreaView>;
}
function Detail({ label, value }: { label: string; value?: string | null }) { return value ? <View style={s.detail}><Text style={s.detailLabel}>{label}</Text><Text style={s.copy}>{value}</Text></View> : null; }
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fbf7f1' }, header: { padding: 18, gap: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff' }, headerCopy: { flex: 1, minWidth: 0 }, title: { fontSize: 24, fontWeight: '900', color: '#321708' }, subtitle: { fontSize: 12, marginTop: 4, color: '#746a61' }, settings: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }, settingsText: { fontSize: 25, color: '#321708' }, tabs: { flexDirection: 'row', flexWrap: 'wrap', padding: 10, gap: 8 }, tab: { flexGrow: 1, flexBasis: 90, minHeight: 44, padding: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#eee6df' }, selectedTab: { backgroundColor: '#e6cbb5' }, tabText: { fontSize: 12, fontWeight: '800', color: '#321708', textAlign: 'center' }, list: { padding: 18, paddingBottom: 32 }, card: { padding: 18, marginTop: 14, borderRadius: 18, backgroundColor: '#fff', borderWidth: 1, borderColor: '#eadfd5' }, name: { fontSize: 20, fontWeight: '900', color: '#321708' }, meta: { fontSize: 13, color: '#746a61', marginTop: 6 }, copy: { fontSize: 14, color: '#61554c', lineHeight: 21, marginTop: 8 }, pay: { fontSize: 17, fontWeight: '800', color: '#287443', marginTop: 10 }, barPhoto: { width: '100%', height: 180, borderRadius: 12, marginVertical: 12 }, photo: { width: 72, height: 72, borderRadius: 16, marginBottom: 12 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }, primary: { minHeight: 44, justifyContent: 'center', borderRadius: 12, padding: 12, backgroundColor: '#321708' }, primaryText: { fontWeight: '800', color: '#fff', textAlign: 'center' }, secondary: { minHeight: 44, justifyContent: 'center', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#d8c6b9', alignSelf: 'flex-start' }, secondaryText: { fontWeight: '800', color: '#321708', textAlign: 'center' }, disabled: { opacity: .5 }, search: { marginTop: 18, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#d8c6b9', backgroundColor: '#fff', fontSize: 16, color: '#321708' }, sectionTitle: { fontSize: 20, fontWeight: '900', color: '#321708', marginTop: 22 }, detail: { marginTop: 12 }, detailLabel: { fontSize: 12, fontWeight: '900', color: '#321708' }, empty: { paddingVertical: 35, alignItems: 'center' },
});
