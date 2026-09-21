import { useMemo, useSyncExternalStore, type ComponentType } from 'react';
import { sectionMemory } from './store';

/** Remount only the private section on account/environment changes, not the auth router. */
export function withSectionMemory(Screen: ComponentType, useScope: () => string = () => '') {
  return function AccountSection() {
    const generation = useSyncExternalStore(sectionMemory.subscribe, sectionMemory.version, sectionMemory.version);
    const scope = useScope();
    return <Screen key={`${generation}:${scope}`} />;
  };
}

export function useSectionMemory<T>(key: string) {
  return useMemo(() => {
    const lease = sectionMemory.lease();
    return {
      initial: sectionMemory.read<T>(lease, key),
      current: () => sectionMemory.current(lease),
      save: (accountId: string, role: string, value: T) => sectionMemory.save(lease, key, accountId, role, value),
      forget: () => sectionMemory.forget(lease, key),
    };
  }, [key]);
}
