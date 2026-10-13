// The validated owner's token is held only in this per-request provider closure.
// No privileged credentials, customer rows, or provider payloads reach MCP output.
export { createOfficeProviders } from './office-data.mjs';

// Compatibility callers without an authenticated request receive unavailable data.
import { createOfficeProviders } from './office-data.mjs';
export const getLiveOverview = () => createOfficeProviders().getLiveOverview();
export const getSupportSummary = () => createOfficeProviders().getSupportSummary();
export const getBillingSummary = () => createOfficeProviders().getBillingSummary();
export const getSystemHealth = () => createOfficeProviders().getSystemHealth();
export const getDecisionSignals = () => createOfficeProviders().getDecisionSignals();
