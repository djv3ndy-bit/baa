import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeAccountService} from '../api/native-billing.js';

const account={id:'10000000-0000-4000-8000-000000000001',role:'cafe_owner_manager'};
const website={plan:'free',connectedToBilling:false,canManageBilling:false,billingPaused:false};

for(const mapped of [false,true]) test(`actual account-service wiring preserves ${mapped?'mapped reviewer with no eligible history':'ordinary production'} status without Apple credentials`,async()=>{
  const names=['VERCEL_ENV','NATIVE_BILLING_ENVIRONMENT','NATIVE_PURCHASES_ENABLED','BILLING_ENABLED','APPLE_SANDBOX_PURCHASES_ENABLED','SUPABASE_URL','SUPABASE_SECRET_KEY'];
  const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const fetchBefore=globalThis.fetch;
  const requests=[];
  Object.assign(process.env,{VERCEL_ENV:'production',NATIVE_BILLING_ENVIRONMENT:'Production',
    NATIVE_PURCHASES_ENABLED:'false',BILLING_ENABLED:'true',APPLE_SANDBOX_PURCHASES_ENABLED:'false',
    SUPABASE_URL:'https://synthetic-status.supabase.invalid',SUPABASE_SECRET_KEY:'synthetic-service-test-key-no-live-credential'});
  const environment=mapped?'Sandbox':'Production';
  const responses={
    native_billing_context:{environment,appleSandboxTester:mapped},
    native_checkout_settle_verified:false,native_billing_owned_apple_refresh:null,
    native_billing_summary:{accountId:account.id,environment,subscriptions:[]},native_checkout_pending:false,
  };
  globalThis.fetch=async(url,options)=>{
    const parsed=new URL(url);
    assert.equal(parsed.origin,'https://synthetic-status.supabase.invalid');
    const name=parsed.pathname.replace('/rest/v1/rpc/','');
    assert(Object.hasOwn(responses,name),`Unexpected external operation: ${name}`);
    assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);assert.equal(body.p_user_id,account.id);
    requests.push(name);
    return new Response(JSON.stringify(responses[name]),{status:200});
  };
  try{
    const result=await nativeAccountService().status(account,website);
    assert.equal(result.accountId,account.id);assert.equal(result.verified,true);assert.equal(result.access,'free');
    assert.equal(result.canPurchase,false);assert.equal(result.storeEnvironment,environment);
    assert.equal(requests.filter(name=>name==='native_billing_owned_apple_refresh').length,mapped?1:0);
    assert(!requests.includes('consume_public_form_budget'));
    assert(!JSON.stringify(result).includes('synthetic-service-test-key'));
    assert(!JSON.stringify(result).includes('subscriptionId'));
  }finally{
    globalThis.fetch=fetchBefore;
    for(const name of names)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
  }
});
