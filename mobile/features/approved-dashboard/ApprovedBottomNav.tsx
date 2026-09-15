import { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import type { AppRole } from '../../lib/session';
import { Icon } from './DashboardPrimitives';
import { countLabel } from './model';
import { dashboardTheme as t } from './theme';
import { useUnreadCount } from './useUnreadCount';

type Tab = 'home' | 'jobs' | 'discover' | 'candidates' | 'matches' | 'messages' | 'profile';
export function ApprovedBottomNav({ active, role = 'barista', unread: supplied }: { active: Tab; role?: AppRole; unread?: number }) {
  const unread = useUnreadCount(supplied) ?? 0;
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale > 1.5;
  const scrollTabs = fontScale > 2.5;
  const navigationScroll = useRef<ScrollView>(null);
  const path = usePathname();
  const selected = path === '/jobs' || path === '/candidates' || path === '/discover' ? 'jobs' : active === 'discover' || active === 'candidates' ? 'jobs' : active;
  const items = [
    { key: 'home', label: 'Home', path: '/home', icon: 'home-outline', filled: 'home' },
    { key: 'jobs', label: 'Jobs', path: role === 'barista' ? '/discover' : '/jobs', icon: 'briefcase-outline', filled: 'briefcase' },
    { key: 'matches', label: 'Matches', path: '/matches', icon: 'people-outline', filled: 'people' },
    { key: 'messages', label: 'Messages', path: '/messages', icon: 'chatbubbles-outline', filled: 'chatbubbles' },
    { key: 'profile', label: 'Profile', path: '/profile', icon: 'person-outline', filled: 'person' },
  ] as const;
  const tabs = items.map(item => <Pressable key={item.key} testID={`main-navigation-${item.key}`} accessibilityRole="tab"
    accessibilityLabel={`${item.label}${item.key === 'messages' && unread > 0 ? `, ${unread} unread messages` : ''}`}
    accessibilityState={{ selected: selected === item.key }} aria-selected={selected === item.key} onPress={() => { if (path !== item.path) router.replace(item.path); }}
    accessibilityHint={scrollTabs ? "Swipe horizontally to see more navigation tabs." : undefined}
    onLayout={scrollTabs && selected === item.key ? event => navigationScroll.current?.scrollTo({ x: Math.max(0, event.nativeEvent.layout.x - 8), animated: false }) : undefined}
    style={[s.item, largeText && s.itemLarge, scrollTabs && s.itemScrollable, selected === item.key && s.selected]}>
    <View style={s.icon}><Icon name={selected === item.key ? item.filled : item.icon} color={selected === item.key ? t.accent : t.muted} />
      {item.key === 'messages' && unread > 0 ? <View accessible={false} style={[s.badge, largeText && s.badgeLarge]}><Text style={s.badgeText}>{unread > 99 ? '99+' : countLabel(unread)}</Text></View> : null}
    </View><Text numberOfLines={scrollTabs ? undefined : 1} adjustsFontSizeToFit={!scrollTabs}
      minimumFontScale={scrollTabs ? undefined : 0.9}
      style={[s.label, !largeText && item.key === 'messages' && s.messageLabel, scrollTabs && s.labelScrollable, selected === item.key && s.active]}>{item.label}</Text>
  </Pressable>);
  return scrollTabs ? <ScrollView ref={navigationScroll} horizontal accessibilityRole="tablist" accessibilityLabel="Main navigation"
    showsHorizontalScrollIndicator style={s.scrollBar} contentContainerStyle={[s.bar, s.barScrollable]}>{tabs}</ScrollView>
    : <View style={[s.bar, largeText && s.barLarge]} accessibilityRole="tablist">{tabs}</View>;
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'stretch', backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.border, paddingHorizontal: 5, paddingVertical: 8, gap: 2 },
  item: { flex: 1, minWidth: 0, minHeight: 56, alignItems: 'center', justifyContent: 'flex-start', paddingHorizontal: 2, paddingVertical: 6, borderRadius: 18 },
  barLarge: { flexWrap: 'wrap' }, itemLarge: { flexBasis: '30%' },
  scrollBar: { flexGrow: 0, flexShrink: 0, backgroundColor: t.surface }, barScrollable: { flexGrow: 1 },
  itemScrollable: { flex: 0, flexBasis: 'auto', paddingHorizontal: 14 }, labelScrollable: { width: 'auto', flexShrink: 0 },
  selected: { backgroundColor: t.soft }, icon: { minHeight: 26, justifyContent: 'center' },
  label: { width: '100%', fontSize: 12, color: t.muted, textAlign: 'center', marginTop: 4, flexShrink: 1 }, active: { color: t.accent, fontWeight: '600' }, messageLabel: { fontSize: 11 },
  badge: { position: 'absolute', left: 18, top: -6, backgroundColor: '#c92b25', borderRadius: 12, minWidth: 18, paddingHorizontal: 4, paddingVertical: 1 },
  badgeText: { color: '#fff', fontSize: 10, textAlign: 'center' },
  badgeLarge: { position: 'relative', left: 0, top: 0, alignSelf: 'center', marginTop: 3 },
});
