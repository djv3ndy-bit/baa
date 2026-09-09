import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { dashboardPrism as prism } from '@/lib/dashboardPrism';

type Tab = 'home' | 'discover' | 'candidates' | 'matches' | 'messages' | 'profile';

type NavItem = {
  key: Tab;
  icon: string;
  label: string;
  path: string;
};

export function AppBottomNav({
  active,
  role = 'barista',
}: {
  active: Tab;
  role?: 'barista' | 'cafe_owner_manager';
}) {
  const items: NavItem[] = [
    { key: 'home', icon: '⌂', label: 'Home', path: '/home' },
    { key: 'discover', icon: '⌕', label: role === 'barista' ? 'Find Jobs' : 'Discover', path: '/discover' },
    ...(role === 'cafe_owner_manager'
      ? [{ key: 'candidates' as Tab, icon: '♙', label: 'Candidates', path: '/candidates' }]
      : []),
    { key: 'matches', icon: '♡', label: 'Matches', path: '/matches' },
    { key: 'messages', icon: '✉', label: 'Messages', path: '/messages' },
    { key: 'profile', icon: '◯', label: 'Profile', path: '/profile' },
  ];

  return (
    <View style={styles.bar}>
      {items.map((item) => {
        const isActive = active === item.key;
        const isCandidates = item.key === 'candidates';

        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: isActive }}
            hitSlop={4}
            key={item.key}
            onPress={() => router.replace(item.path as never)}
            style={[styles.item, isCandidates && styles.candidatesItem, isActive && styles.selectedItem]}
          >
            <Text
              allowFontScaling={false}
              style={[styles.icon, isActive && styles.active]}
            >
              {item.icon}
            </Text>
            <Text
              adjustsFontSizeToFit
              allowFontScaling={false}
              minimumFontScale={0.78}
              numberOfLines={1}
              style={[styles.label, isCandidates && styles.candidatesLabel, isActive && styles.active]}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 72,
    borderTopWidth: 1,
    borderTopColor: prism.line,
    backgroundColor: prism.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingBottom: 5,
  },
  item: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    paddingHorizontal: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  candidatesItem: {
    flex: 1.14,
  },
  selectedItem: {
    borderRadius: 14,
    backgroundColor: prism.soft,
  },
  icon: {
    fontSize: 19,
    lineHeight: 22,
    color: prism.muted,
  },
  label: {
    width: '100%',
    marginTop: 3,
    color: prism.muted,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  candidatesLabel: {
    fontSize: 8.5,
    letterSpacing: -0.15,
  },
  active: {
    color: prism.ink,
  },
});
