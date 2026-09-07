import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getCurrentContext } from '@/lib/session';
import { authenticatedApi } from '@/lib/api';
import { JOB_FIELDS, MarketJob } from '@/lib/marketplace';
import { blankJobDraft, draftFromJob, jobPayload } from '@/lib/jobEditor';

const scheduleOptions = ['Full-time', 'Part-time', 'Morning shift', 'Evening shift'];
export default function PostJobScreen() {
  const params = useLocalSearchParams<{ jobId?: string }>();
  const jobId = typeof params.jobId === 'string' ? params.jobId : undefined, editing = !!jobId;
  const [form, setForm] = useState({ ...blankJobDraft });
  const [schedules, setSchedules] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [loadingJob, setLoadingJob] = useState(true);
  const [loadError, setLoadError] = useState(''), [customSchedule, setCustomSchedule] = useState('');
  const action = useRef(false), request = useRef(0), focused = useRef(false), ownerId = useRef(''), active = useRef(true), initialized = useRef<string | null>(null);
  const load = useCallback(async () => {
    const version = ++request.current; setLoadingJob(true); setLoadError('');
    try {
      const { user, role } = await getCurrentContext();
      if (version !== request.current) return;
      if (!user) { router.replace('/login'); return; }
      if (role !== 'cafe_owner_manager') { router.replace('/home'); return; }
      ownerId.current = user.id;
      if (!jobId) { initialized.current = jobId || 'new'; return; }
      const { data, error } = await supabase.from('jobs').select(JOB_FIELDS).eq('id', jobId).eq('owner_id', user.id).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('This job is no longer available to edit.');
      if (version !== request.current) return;
      setForm(draftFromJob(data as MarketJob)); setSchedules(String(data.schedule || '').split(' · ').filter(Boolean)); active.current = data.active; initialized.current = jobId || 'new';
    } catch (caught) { if (version === request.current) setLoadError(caught instanceof Error ? caught.message : 'The job could not load. Please retry.'); }
    finally { if (version === request.current) setLoadingJob(false); }
  }, [jobId]);
  useFocusEffect(useCallback(() => { focused.current = true; if (initialized.current !== (jobId || 'new')) void load(); return () => { focused.current = false; request.current++; }; }, [load, jobId]));
  const update = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }));
  const toggleSchedule = (value: string) => setSchedules(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
  async function publish() {
    if (action.current || loadingJob || loadError || !initialized.current) return;
    action.current = true; setPublishing(true);
    const draft = { ...form }, chosenSchedules = [...schedules, customSchedule.trim()].filter(Boolean);
    try {
      const payload = jobPayload(draft, chosenSchedules, ownerId.current);
      const { user, role, profile } = await getCurrentContext();
      if (!user || user.id !== ownerId.current || role !== 'cafe_owner_manager') throw new Error('Your account changed. Reopen this job before saving.');
      if (!profile?.is_discoverable || profile.suspended_at) throw new Error('Complete and save your café profile before publishing or editing jobs.');
      const query = editing ? supabase.from('jobs').update(payload).eq('id', jobId!).eq('owner_id', user.id) : supabase.from('jobs').insert({ ...payload, active: true });
      const { data: job, error } = await query.select('id,active').single();
      if (error) throw error;
      if (!job) throw new Error('Your saved job could not be confirmed. Please refresh Job Posts before retrying.');
      if (!editing) authenticatedApi('/push-event', { type: 'job', job_id: job.id }, 'POST', user.id).catch(() => {});
      if (focused.current) { router.replace('/jobs'); Alert.alert(editing ? 'Job updated' : 'Job published', job.active ? 'Your job details are saved and available to baristas.' : 'Your changes are saved. This job remains paused and its applications are retained.'); }
    } catch (caught) { if (focused.current) Alert.alert(editing ? 'Job not updated' : 'Job not published', caught instanceof Error ? caught.message : 'Please check your connection and try again.'); }
    finally { action.current = false; setPublishing(false); }
  }
  if (loadingJob) return <SafeAreaView style={styles.safe}><View style={styles.loading}><ActivityIndicator size="large" color="#321708"/><Text style={styles.loadingText}>Loading job…</Text></View></SafeAreaView>;
  return <SafeAreaView style={styles.safe}><KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.header}><Pressable disabled={publishing} accessibilityRole="button" accessibilityLabel="Go back" style={styles.backButton} onPress={() => router.back()}><Text allowFontScaling={false} style={styles.back}>‹</Text></Pressable><Text style={styles.headerTitle}>{editing ? 'Edit job' : 'Post a job'}</Text><View style={styles.headerSpacer}/></View>
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      {loadError ? <><Text accessibilityRole="alert" style={styles.subtitle}>{loadError}</Text><Pressable style={styles.primary} onPress={() => void load()}><Text style={styles.primaryText}>Retry loading job</Text></Pressable></> : <>
      <Text style={styles.title}>{editing ? 'Keep your job accurate.' : 'Find your next great barista.'}</Text><Text style={styles.subtitle}>{editing ? `Update the role while keeping its applications and ${active.current ? 'active' : 'paused'} status.` : 'Publish a clear Florida opportunity.'}</Text>
      <Field label="Job title" value={form.title} onValueChange={value => update('title', value)} placeholder="Lead Barista" editable={!publishing}/>
      <Field label="Street address" value={form.address1} onValueChange={value => update('address1', value)} placeholder="123 Main Street" editable={!publishing} autoComplete="address-line1"/>
      <Field label="Suite / unit (optional)" value={form.address2} onValueChange={value => update('address2', value)} placeholder="Suite 200" editable={!publishing} autoComplete="address-line2"/>
      <View style={styles.row}><View style={styles.flex}><Field label="City" value={form.city} onValueChange={value => update('city', value)} placeholder="Miami" editable={!publishing}/></View><View style={styles.state}><Field label="State" value={form.state} onValueChange={() => {}} placeholder="FL" editable={false}/></View></View>
      <Field label="ZIP code" value={form.postalCode} onValueChange={value => update('postalCode', value)} placeholder="33101" editable={!publishing} keyboardType="numbers-and-punctuation" autoComplete="postal-code"/>
      <Field label="Minimum hourly pay" value={form.hourlyPay} onValueChange={value => update('hourlyPay', value)} placeholder="20.00" editable={!publishing} keyboardType="decimal-pad"/>
      <Field label="Maximum hourly pay (optional)" value={form.maximumPay} onValueChange={value => update('maximumPay', value)} placeholder="25.00" editable={!publishing} keyboardType="decimal-pad"/>
      <Text style={styles.label}>Schedule</Text><View style={styles.options}>{[...new Set([...scheduleOptions, ...schedules])].map(option => <Pressable key={option} accessibilityRole="checkbox" accessibilityState={{ checked: schedules.includes(option) }} disabled={publishing} onPress={() => toggleSchedule(option)} style={[styles.option, schedules.includes(option) && styles.optionSelected]}><Text style={[styles.optionText, schedules.includes(option) && styles.optionTextSelected]}>{option}</Text></Pressable>)}</View>
      <Field label="Additional schedule (optional)" value={customSchedule} onValueChange={setCustomSchedule} placeholder="Weekends, 7 AM–2 PM" editable={!publishing}/>
      <Field label="Skills (comma separated)" value={form.skills} onValueChange={value => update('skills', value)} placeholder="Espresso, latte art" editable={!publishing}/>
      <Field label="Description" value={form.description} onValueChange={value => update('description', value)} placeholder="Describe the role, team, and what success looks like." editable={!publishing} multiline/>
      <Pressable accessibilityRole="button" disabled={publishing} onPress={() => void publish()} style={[styles.primary, publishing && styles.disabled]}><Text style={styles.primaryText}>{publishing ? 'Saving…' : editing ? 'Save changes' : 'Publish job'}</Text></Pressable>
      </>}
    </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}

function Field({ label, value, onValueChange, placeholder, multiline = false, ...props }: { label: string; value: string; onValueChange: (value: string) => void; placeholder: string; multiline?: boolean } & Omit<TextInputProps, 'value' | 'onChangeText' | 'placeholder' | 'multiline'>) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onValueChange} placeholder={placeholder} placeholderTextColor="#9b8d84" multiline={multiline} style={[styles.input, multiline && styles.textarea]} {...props} /></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fbf7f1' }, loading:{flex:1,alignItems:'center',justifyContent:'center'},loadingText:{marginTop:12,fontSize:13,fontWeight:'800',color:'#746a61'}, flex: { flex: 1 }, backButton: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, header: { minHeight: 58, paddingVertical: 8, gap: 12, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#eadfd5' }, back: { fontSize: 38, color: '#321708', lineHeight: 40 }, headerTitle: { flex: 1, minWidth: 0, textAlign: 'center', fontSize: 18, fontWeight: '900', color: '#321708' }, headerSpacer: { width: 44, flexShrink: 0 }, wrap: { padding: 20, paddingBottom: 48 }, title: { fontSize: 32, lineHeight: 38, fontWeight: '900', color: '#21150f' }, subtitle: { fontSize: 15, lineHeight: 22, color: '#746a61', marginTop: 8, marginBottom: 18 }, field: { marginTop: 15 }, label: { fontSize: 13, fontWeight: '900', color: '#321708', marginBottom: 8 }, input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e4d6cb', borderRadius: 14, paddingHorizontal: 15, paddingVertical: 14, fontSize: 16, color: '#21150f' }, textarea: { minHeight: 120, textAlignVertical: 'top' }, row: { flexDirection: 'row', gap: 12 }, state: { width: 92 }, options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 2 }, option: { borderWidth: 1, borderColor: '#ddcdbf', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: '#fff' }, optionSelected: { backgroundColor: '#321708', borderColor: '#321708' }, optionText: { color: '#5f5148', fontSize: 12, fontWeight: '800' }, optionTextSelected: { color: '#fff' }, primary: { marginTop: 28, backgroundColor: '#2f7c42', borderRadius: 15, paddingVertical: 16, alignItems: 'center' }, primaryText: { color: '#fff', fontWeight: '900', fontSize: 17 }, disabled: { opacity: .55 }
});
