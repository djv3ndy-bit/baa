import { useState, type ComponentProps, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { dashboardTheme as t } from './theme';

export function Icon({ name, size = 24, color = t.ink }: { name: ComponentProps<typeof Ionicons>['name']; size?: number; color?: string }) {
  return <Ionicons accessible={false} importantForAccessibility="no" name={name} size={size} color={color} />;
}

export function Action({ label, onPress, primary = false, icon, disabled = false }: {
  label: string; onPress: () => void; primary?: boolean; icon?: ComponentProps<typeof Ionicons>['name']; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.action, primary && s.primary, (pressed || disabled) && s.dim]}>
    {icon ? <Icon name={icon} color={primary ? '#fff' : t.accent} /> : null}
    <Text style={[s.actionText, primary && s.primaryText]}>{label}</Text>
  </Pressable>;
}

export function Section({ title, action, onPress, children }: { title: string; action?: string; onPress?: () => void; children: ReactNode }) {
  return <View style={s.section}><View style={s.sectionHeading}>
    <Text accessibilityRole="header" style={s.sectionTitle}>{title}</Text>
    {action && onPress ? <Pressable accessibilityRole="button" accessibilityLabel={`${action}: ${title}`} onPress={onPress} style={s.sectionAction}>
      <Text style={s.link}>{action}</Text><Icon name="arrow-forward" color={t.accent} size={20} />
    </Pressable> : null}
  </View>{children}</View>;
}

export function Avatar({ uri, name, cafe = false }: { uri?: string | null; name: string; cafe?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  return uri && failed !== uri ? <Image source={{ uri }} accessibilityLabel={`${name} photo`} style={s.avatar} onError={() => setFailed(uri)} />
    : <View accessibilityLabel={`${name}, photo unavailable`} style={[s.avatar, s.fallback]}><Icon name={cafe ? 'cafe-outline' : 'person-outline'} size={28} color={t.accent} /></View>;
}

export function EmptyCard({ title, body }: { title: string; body: string }) {
  return <View style={s.empty}><Text style={s.emptyTitle}>{title}</Text><Text style={s.copy}>{body}</Text></View>;
}

const s = StyleSheet.create({
  action: { minHeight: 48, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: t.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  primary: { backgroundColor: t.accent, borderColor: t.accent, minHeight: 54 },
  actionText: { color: t.accent, fontSize: 16, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  primaryText: { color: '#fff', fontSize: 19 }, dim: { opacity: 0.65 },
  section: { marginTop: 10 }, sectionHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginBottom: 8 },
  sectionTitle: { flexShrink: 1, minWidth: 0, maxWidth: '100%', fontFamily: t.headingFont, fontSize: 23, fontWeight: '700', color: t.ink },
  sectionAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, flexShrink: 0 }, link: { color: t.accent, fontSize: 15 },
  avatar: { width: 52, height: 52, borderRadius: 26, flexShrink: 0 }, fallback: { backgroundColor: t.soft, justifyContent: 'center', alignItems: 'center' },
  empty: { borderWidth: 1, borderColor: t.border, borderRadius: 14, backgroundColor: t.surface, padding: 18 },
  emptyTitle: { color: t.ink, fontSize: 17, fontWeight: '600' }, copy: { color: t.muted, fontSize: 15, lineHeight: 22, marginTop: 5 },
});
