import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getCurrentContext } from '@/lib/session';
import { authenticatedApi } from '@/lib/api';

const scheduleOptions = ['Full-time', 'Part-time', 'Morning shift', 'Evening shift'];

export default function PostJobScreen() {
  const [form, setForm] = useState({ title: '', address1: '', address2: '', city: '', state: '', postalCode: '', hourlyPay: '', skills: '', description: '' });
  const [schedules, setSchedules] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);

  const update = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }));
  const toggleSchedule = (value: string) => setSchedules(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value]);

  async function publish() {
    const { user, role, profile } = await getCurrentContext();
    if (!user) return router.replace('/login');
    if (role !== 'cafe_owner_manager') return Alert.alert('Café account required', 'Only café accounts can publish jobs.');
    if (!profile?.cafe_name) return Alert.alert('Complete your café profile', 'Add your café name before publishing a job.');
    const pay = Number(form.hourlyPay);
    if (!form.title.trim() || !form.address1.trim() || !form.city.trim() || !form.state.trim() || !form.postalCode.trim() || !form.description.trim() || !Number.isFinite(pay) || pay <= 0 || !schedules.length) {
      return Alert.alert('Complete the job details', 'Add the title, address, pay, schedule, and description before publishing.');
    }
    setPublishing(true);
    const state = form.state.trim().toUpperCase();
    const payload = {
      owner_id: user.id,
      title: form.title.trim(),
      location: [form.city.trim(), state, form.postalCode.trim()].join(', '),
      address_line1: form.address1.trim(),
      address_line2: form.address2.trim() || null,
      city: form.city.trim(),
      state,
      postal_code: form.postalCode.trim(),
      pay_min: pay,
      pay_max: null,
      schedule: schedules.join(' · '),
      required_skills: form.skills.split(',').map(item => item.trim()).filter(Boolean),
      description: form.description.trim(),
      active: true,
    };
    const { data: job, error } = await supabase.from('jobs').insert(payload).select('id').single();
    setPublishing(false);
    if (error) return Alert.alert('Could not publish job', error.message);
    authenticatedApi('/push-event', { type: 'job', job_id: job.id }).catch(error => console.warn('Nearby job notification failed', error?.message || error));
    Alert.alert('Job published', 'Your opportunity is now visible to local baristas.', [{ text: 'Done', onPress: () => router.replace('/home') }]);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}><Pressable onPress={() => router.back()}><Text style={styles.back}>‹</Text></Pressable><Text style={styles.headerTitle}>Post a job</Text><View style={styles.headerSpacer} /></View>
        <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Find your next great barista.</Text>
          <Text style={styles.subtitle}>Publish a clear local opportunity in a few minutes.</Text>
          <Field label="Job title" value={form.title} onValueChange={value => update('title', value)} placeholder="Lead Barista" />
          <Field label="Street address" value={form.address1} onValueChange={value => update('address1', value)} placeholder="123 Main Street" autoComplete="address-line1" />
          <Field label="Suite / unit (optional)" value={form.address2} onValueChange={value => update('address2', value)} placeholder="Suite 200" autoComplete="address-line2" />
          <View style={styles.row}>
            <View style={styles.flex}><Field label="City" value={form.city} onValueChange={value => update('city', value)} placeholder="Miami" /></View>
            <View style={styles.state}><Field label="State" value={form.state} onValueChange={value => update('state', value.slice(0, 2))} placeholder="FL" autoCapitalize="characters" /></View>
          </View>
          <Field label="ZIP code" value={form.postalCode} onValueChange={value => update('postalCode', value)} placeholder="33101" keyboardType="numbers-and-punctuation" autoComplete="postal-code" />
          <Field label="Hourly pay" value={form.hourlyPay} onValueChange={value => update('hourlyPay', value)} placeholder="20.00" keyboardType="decimal-pad" />
          <Text style={styles.label}>Schedule</Text>
          <View style={styles.options}>{scheduleOptions.map(option => <Pressable key={option} onPress={() => toggleSchedule(option)} style={[styles.option, schedules.includes(option) && styles.optionSelected]}><Text style={[styles.optionText, schedules.includes(option) && styles.optionTextSelected]}>{option}</Text></Pressable>)}</View>
          <Field label="Skills (comma separated)" value={form.skills} onValueChange={value => update('skills', value)} placeholder="Espresso, latte art" />
          <Field label="Description" value={form.description} onValueChange={value => update('description', value)} placeholder="Describe the role, team, and what success looks like." multiline />
          <Pressable disabled={publishing} onPress={publish} style={[styles.primary, publishing && styles.disabled]}><Text style={styles.primaryText}>{publishing ? 'Publishing…' : 'Publish job'}</Text></Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, value, onValueChange, placeholder, multiline = false, ...props }: { label: string; value: string; onValueChange: (value: string) => void; placeholder: string; multiline?: boolean } & Omit<TextInputProps, 'value' | 'onChangeText' | 'placeholder' | 'multiline'>) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onValueChange} placeholder={placeholder} placeholderTextColor="#9b8d84" multiline={multiline} style={[styles.input, multiline && styles.textarea]} {...props} /></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fbf7f1' }, flex: { flex: 1 }, header: { height: 58, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#eadfd5' }, back: { fontSize: 38, color: '#321708', lineHeight: 40 }, headerTitle: { fontSize: 18, fontWeight: '900', color: '#321708' }, headerSpacer: { width: 28 }, wrap: { padding: 20, paddingBottom: 48 }, title: { fontSize: 32, lineHeight: 38, fontWeight: '900', color: '#21150f' }, subtitle: { fontSize: 15, lineHeight: 22, color: '#746a61', marginTop: 8, marginBottom: 18 }, field: { marginTop: 15 }, label: { fontSize: 13, fontWeight: '900', color: '#321708', marginBottom: 8 }, input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e4d6cb', borderRadius: 14, paddingHorizontal: 15, paddingVertical: 14, fontSize: 16, color: '#21150f' }, textarea: { minHeight: 120, textAlignVertical: 'top' }, row: { flexDirection: 'row', gap: 12 }, state: { width: 92 }, options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 2 }, option: { borderWidth: 1, borderColor: '#ddcdbf', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: '#fff' }, optionSelected: { backgroundColor: '#321708', borderColor: '#321708' }, optionText: { color: '#5f5148', fontSize: 12, fontWeight: '800' }, optionTextSelected: { color: '#fff' }, primary: { marginTop: 28, backgroundColor: '#2f7c42', borderRadius: 15, paddingVertical: 16, alignItems: 'center' }, primaryText: { color: '#fff', fontWeight: '900', fontSize: 17 }, disabled: { opacity: .55 }
});
