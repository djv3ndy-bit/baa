import { sectionMemory, type SectionMemoryStore } from './store';

type Session = { user: { id: string }; expires_at?: number } | null;
type AuthClient = { auth: {
  getSession(): Promise<{ data: { session: Session }; error: unknown }>;
  onAuthStateChange(callback: (event: string, session: Session) => void): { data: { subscription: { unsubscribe(): void } } };
} };

/** One synchronous auth listener per running app; never calls Auth inside its callback. */
export function createSectionMemorySession(store: SectionMemoryStore) {
  let client: AuthClient | undefined, namespace = '', initialization: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  return (nextClient: AuthClient, nextNamespace: string): Promise<void> => {
    if (client === nextClient && namespace === nextNamespace && initialization) return initialization;
    stop?.(); store.setSession(nextNamespace, null);
    client = nextClient; namespace = nextNamespace;
    let active = true, events = 0;
    const apply = (session: Session) => store.setSession(nextNamespace, session?.user.id ?? null, (session?.expires_at ?? 0) * 1000);
    const { data: { subscription } } = nextClient.auth.onAuthStateChange((_event, session) => {
      if (active) { events++; apply(session); }
    });
    stop = () => { active = false; subscription.unsubscribe(); };
    const pending = nextClient.auth.getSession().then(({ data, error }) => {
      // A slower initial read cannot overwrite a newer sign-in or sign-out event.
      if (!active || events) return;
      apply(error ? null : data.session);
    }).catch(() => {
      // This optional display cache must not block login when session recovery fails.
      // Keep listening so a later successful sign-in can enable it again.
      if (active && !events) store.setSession(nextNamespace, null);
    });
    initialization = pending;
    return pending;
  };
}

export const initializeSectionMemory = createSectionMemorySession(sectionMemory);
