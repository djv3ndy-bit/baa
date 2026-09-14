import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getStorefrontCountryCode } from '@/modules/baristamatch-storefront';
import { authenticatedApi, requireAccountSession } from './api';
import { canManageBilling, hasActivePro, validBillingStatus, validCheckoutSessionId, validatedCheckoutUrl, type BillingStatus } from './websiteCheckout';

type ReturnInfo = { billing?: string; sessionId?: string };
type State = {
  accountId: string | null;
  billing: BillingStatus | null;
  loading: boolean;
  opening: boolean;
  error: string;
  notice: string;
  storefrontChecked: boolean;
  storefrontCountryCode: string | null;
};
type Run = { accountId: string; revision: number };
type Confirmation = { confirmed: boolean; pending?: boolean; status?: string };
const initialState = (accountId: string | null): State => ({ accountId, billing: null, loading: Boolean(accountId), opening: false, error: '', notice: '', storefrontChecked: false, storefrontCountryCode: null });
const unknownStorefront = 'We could not verify your App Store region. Please try again.';
const unavailableStorefront = 'Website checkout is currently available only for the U.S. App Store.';
const messageOf = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

export function useWebsiteCheckout(accountId: string | null, returnInfo?: ReturnInfo) {
  const [state, setState] = useState<State>(() => initialState(accountId));
  const stateRef = useRef(state);
  const account = useRef(accountId);
  account.current = accountId;
  const focused = useRef(false);
  const appState = useRef(AppState.currentState);
  const revision = useRef(0);
  const openingRun = useRef<number | null>(null);
  const refreshingRun = useRef<number | null>(null);
  const pendingWaits = useRef(new Set<() => void>());
  const returnBilling = returnInfo?.billing;
  const returnSessionId = returnInfo?.sessionId;
  const returnKey = JSON.stringify([returnBilling ?? null, returnSessionId ?? null]);
  const returnBinding = useRef({ key: returnKey, accountId, invalidated: false });
  if (returnBinding.current.key !== returnKey) returnBinding.current = { key: returnKey, accountId, invalidated: false };
  else if (!returnBinding.current.accountId && accountId) returnBinding.current.accountId = accountId;
  else if (returnBinding.current.accountId && returnBinding.current.accountId !== accountId) returnBinding.current.invalidated = true;

  const current = (run: Run) => focused.current && appState.current === 'active' && account.current === run.accountId && revision.current === run.revision;
  const update = (run: Run, patch: Partial<State>) => {
    if (!current(run)) return;
    const next = { ...(stateRef.current.accountId === run.accountId ? stateRef.current : initialState(run.accountId)), ...patch };
    stateRef.current = next;
    setState(next);
  };
  const invalidate = () => {
    revision.current += 1;
    openingRun.current = null;
    refreshingRun.current = null;
    for (const cancel of pendingWaits.current) cancel();
    pendingWaits.current.clear();
  };
  const wait = (run: Run, milliseconds: number) => new Promise<boolean>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); pendingWaits.current.delete(finish); resolve(current(run)); };
    timer = setTimeout(finish, milliseconds);
    pendingWaits.current.add(finish);
  });
  const readStorefront = () => new Promise<string | null>(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cancel = () => finish(null);
    const finish = (country: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingWaits.current.delete(cancel);
      resolve(country);
    };
    timer = setTimeout(cancel, 8000);
    pendingWaits.current.add(cancel);
    try { void getStorefrontCountryCode().then(finish, cancel); }
    catch { cancel(); }
  });
  const readBilling = async (expectedId: string) => {
    const result = await authenticatedApi<BillingStatus>('/billing-status', {}, 'GET', expectedId);
    await requireAccountSession(expectedId);
    if (!validBillingStatus(result)) throw new Error('Subscription details are unavailable. Please try again.');
    return result;
  };

  const refresh = useCallback(async () => {
    if (!accountId || account.current !== accountId || !focused.current || appState.current !== 'active' || openingRun.current !== null || refreshingRun.current !== null) return;
    const run = { accountId, revision: ++revision.current };
    refreshingRun.current = run.revision;
    update(run, { loading: true, opening: false, error: '', notice: '', storefrontChecked: false, storefrontCountryCode: null });
    try {
      const [billingResult, countryResult] = await Promise.allSettled([readBilling(accountId), readStorefront()]);
      await requireAccountSession(accountId);
      if (!current(run)) return;
      const country = countryResult.status === 'fulfilled' ? countryResult.value : null;
      update(run, { storefrontChecked: true, storefrontCountryCode: country });
      if (billingResult.status !== 'fulfilled') throw billingResult.reason;
      update(run, { billing: billingResult.value });

      if ((returnBilling || returnSessionId) && (returnBinding.current.invalidated || returnBinding.current.accountId !== accountId)) {
        throw new Error('This checkout return is no longer current. Check your subscription from the café account used for checkout.');
      }
      if (returnBilling === 'success') {
        const legacyReturn = returnSessionId === undefined || returnSessionId === '';
        if (!legacyReturn && !validCheckoutSessionId(returnSessionId)) throw new Error('We could not verify that checkout return. Please check your subscription status again shortly.');
        for (let attempt = 0; attempt < 5; attempt += 1) {
          if (!current(run)) return;
          if (legacyReturn) {
            // Older app return links omitted the session ID. Read trusted billing;
            // never infer payment from the link or ask the customer to pay again.
            const billing = attempt === 0 ? billingResult.value : await readBilling(accountId);
            if (!current(run)) return;
            update(run, { billing });
            if (hasActivePro(billing)) {
              update(run, { notice: 'Your current Pro subscription is active.' });
              return;
            }
          } else {
            const confirmation = await authenticatedApi<Confirmation>('/confirm-checkout-session', { sessionId: returnSessionId }, 'POST', accountId);
            await requireAccountSession(accountId);
            if (!current(run)) return;
            if (typeof confirmation?.confirmed !== 'boolean') throw new Error('Checkout confirmation is unavailable. Please try again.');
            const billing = await readBilling(accountId);
            if (!current(run)) return;
            update(run, { billing });
            if (confirmation.confirmed && hasActivePro(billing)) {
              update(run, { notice: 'Your Pro subscription is active.' });
              return;
            }
            if (confirmation.confirmed && canManageBilling(billing) && !hasActivePro(billing)) {
              update(run, { error: 'Your subscription needs attention. Open subscription management in Settings.' });
              return;
            }
          }
          if (attempt < 4) {
            update(run, { notice: legacyReturn ? 'Checking your current subscription status…' : 'Your checkout is still being confirmed. Please wait…' });
            if (!await wait(run, 1500)) return;
          }
        }
        update(run, { notice: '', error: legacyReturn ? 'Please check your subscription status again shortly.' : 'Your checkout is still being confirmed. Please check your subscription status again shortly.' });
        return;
      }
      if (returnBilling === 'canceled') update(run, { notice: 'Checkout closed. Your subscription status has been refreshed.' });
      else if (returnBilling === 'portal' || returnBilling === 'complete') update(run, { notice: 'Your subscription status has been refreshed.' });
      else if (returnBilling || returnSessionId) throw new Error('We could not verify that checkout return. Your current subscription status is shown here.');
      if (Platform.OS === 'ios' && !country) update(run, { error: unknownStorefront });
    } catch (cause) {
      update(run, { error: messageOf(cause, 'Subscription details are unavailable. Please try again.'), notice: '' });
    } finally {
      if (refreshingRun.current === run.revision) refreshingRun.current = null;
      update(run, { loading: false });
    }
  }, [accountId, returnBilling, returnSessionId]);

  const subscribe = useCallback(async () => {
    if (!accountId || account.current !== accountId || !focused.current || appState.current !== 'active' || openingRun.current !== null || refreshingRun.current !== null) return;
    const snapshot = stateRef.current;
    const run = { accountId, revision: ++revision.current };
    if (snapshot.accountId !== accountId || snapshot.loading || !snapshot.billing) {
      update(run, { error: 'Load your subscription details before opening checkout. Please try again.' });
      return;
    }
    if (Platform.OS !== 'ios') { update(run, { error: unavailableStorefront }); return; }
    if (snapshot.billing.billingPaused) { update(run, { error: 'Subscriptions are temporarily unavailable. Please try again later.' }); return; }
    if (canManageBilling(snapshot.billing)) { update(run, { error: 'This café already has a subscription. Manage it from Settings.' }); return; }
    openingRun.current = run.revision;
    update(run, { opening: true, error: '', notice: '' });
    try {
      await requireAccountSession(accountId);
      if (!current(run)) return;
      const country = await readStorefront();
      if (!current(run)) return;
      update(run, { storefrontChecked: true, storefrontCountryCode: country });
      if (country !== 'USA') throw new Error(country ? unavailableStorefront : unknownStorefront);
      const billing = await readBilling(accountId);
      if (!current(run)) return;
      update(run, { billing });
      if (billing.billingPaused) throw new Error('Subscriptions are temporarily unavailable. Please try again later.');
      if (canManageBilling(billing)) throw new Error('This café already has a subscription. Manage it from Settings.');
      const response = await authenticatedApi<{ url: string }>('/create-checkout-session', { channel: 'mobile' }, 'POST', accountId);
      await requireAccountSession(accountId);
      if (!current(run)) return;
      const url = validatedCheckoutUrl(response?.url);
      const launchCountry = await readStorefront();
      await requireAccountSession(accountId);
      if (!current(run)) return;
      update(run, { storefrontChecked: true, storefrontCountryCode: launchCountry });
      if (launchCountry !== 'USA') throw new Error(launchCountry ? unavailableStorefront : unknownStorefront);
      await Linking.openURL(url);
      update(run, { notice: 'Complete checkout in your browser. Your subscription will update after confirmation.' });
    } catch (cause) {
      update(run, { error: messageOf(cause, 'Secure checkout could not be opened. Please try again.') });
    } finally {
      if (openingRun.current === run.revision) openingRun.current = null;
      update(run, { opening: false });
    }
  }, [accountId]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    void refresh();
    return () => { focused.current = false; invalidate(); };
  }, [refresh]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      const previous = appState.current;
      appState.current = next;
      if (next !== 'active') {
        invalidate();
        const nextState = { ...stateRef.current, loading: false, opening: false, storefrontChecked: false, storefrontCountryCode: null };
        stateRef.current = nextState;
        setState(nextState);
      } else if (previous !== 'active' && focused.current) void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const visible = state.accountId === accountId ? state : initialState(accountId);
  return { billing: visible.billing, loading: visible.loading, opening: visible.opening, error: visible.error, notice: visible.notice, storefrontChecked: visible.storefrontChecked, storefrontCountryCode: visible.storefrontCountryCode, refresh, subscribe };
}
