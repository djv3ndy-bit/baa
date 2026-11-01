import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { requireAccountSession } from '@/lib/api';
import { blockUser, reportUser } from '@/lib/safety';
import { dashboardPrism as prism } from '@/lib/dashboardPrism';

type Props = {
  accountId: string;
  profileId: string;
  profileName: string;
  jobId?: string;
  disabled?: boolean;
  onBlocked: (profileId: string) => void;
  onStart?: () => boolean;
  onFinish?: () => void;
};

/** Profile safety is available before matching or starting a conversation. */
export function ProfileSafetyControl(props: Props) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), focused = useRef(false), current = useRef(props);
  current.current = props;
  useFocusEffect(useCallback(() => { focused.current = true; return () => { focused.current = false; }; }, []));

  function available(origin: Props) {
    const latest = current.current;
    return focused.current && latest.accountId === origin.accountId && latest.profileId === origin.profileId && latest.jobId === origin.jobId;
  }
  async function submit(origin: Props, kind: 'block' | 'harassment' | 'spam_or_scam') {
    if (!available(origin) || current.current.disabled || pending.current || (origin.onStart && !origin.onStart())) return;
    pending.current = true; setBusy(true);
    try {
      await requireAccountSession(origin.accountId);
      if (!available(origin)) return;
      if (kind === 'block') await blockUser(origin.profileId, origin.accountId);
      else await reportUser({ reportedId: origin.profileId, reason: kind, expectedAccountId: origin.accountId,
        details: origin.jobId ? `Job ${origin.jobId} reported from job safety controls.` : 'Profile, photo or showcase video reported from the profile safety controls.' });
      await requireAccountSession(origin.accountId);
      if (!available(origin)) return;
      if (kind === 'block') {
        origin.onBlocked(origin.profileId);
        Alert.alert('Account blocked', 'This account will be hidden from your results and connections.');
      } else Alert.alert('Report sent', 'Your report was submitted to BaristaMatch.');
    } catch {
      if (available(origin)) Alert.alert(kind === 'block' ? 'Block not confirmed' : 'Report not sent', 'This action could not be confirmed. Check your connection and try again.');
    } finally {
      pending.current = false;
      origin.onFinish?.();
      if (available(origin)) setBusy(false);
    }
  }
  function open() {
    const origin = current.current;
    if (!origin.accountId || origin.profileId === origin.accountId || origin.disabled || pending.current || !available(origin)) return;
    const reportLabel = origin.jobId ? 'Report job' : 'Report profile';
    Alert.alert(origin.jobId ? 'Job safety' : 'Profile safety', origin.jobId ? 'Report this job or block its café account.' : 'Report this profile or block this account.', [
      { text: reportLabel, onPress: () => {
        if (!available(origin)) return;
        Alert.alert(reportLabel, origin.jobId ? 'Choose the reason that best describes this job.' : 'Choose the reason that best describes this profile or its media.', [
          { text: 'Harassment or inappropriate content', onPress: () => void submit(origin, 'harassment') },
          { text: 'Spam or scam', onPress: () => void submit(origin, 'spam_or_scam') },
          { text: 'Cancel', style: 'cancel' },
        ], { cancelable: true });
      } },
      { text: 'Block account', style: 'destructive', onPress: () => {
        if (!available(origin)) return;
        Alert.alert('Block this account?', 'Their profile, jobs and connections will be hidden. They will not be able to message you.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Block', style: 'destructive', onPress: () => void submit(origin, 'block') },
        ], { cancelable: true });
      } },
      { text: 'Cancel', style: 'cancel' },
    ], { cancelable: true });
  }
  if (!props.accountId || props.accountId === props.profileId) return null;
  const disabled = busy || props.disabled;
  return <Pressable accessibilityRole="button" accessibilityLabel={props.jobId ? `Report this job or block ${props.profileName}` : `Report or block ${props.profileName}`} accessibilityState={{ disabled, busy }}
    disabled={disabled} onPress={open} style={[styles.button, disabled && styles.disabled]}>
    <Text style={styles.label}>{busy ? 'Saving safety action…' : 'Report or block'}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', padding: 12, marginTop: 8, borderWidth: 1, borderColor: prism.line, borderRadius: 12 },
  label: { fontWeight: '700', color: prism.ink }, disabled: { opacity: 0.5 },
});
