import existingBilling from './billing.js';
import { authenticatedCafe } from './_billing.js';
import { nativeAccountService } from './native-billing.js';
import { accountBillingHandler } from '../server/native-billing/accountBillingHandler.mjs';

export default accountBillingHandler({
  existingBilling,
  authenticateCafe: authenticatedCafe,
  configured: () => Boolean(process.env.NATIVE_BILLING_ENVIRONMENT),
  statusFor: (account, website) => nativeAccountService().status(account, website),
});
