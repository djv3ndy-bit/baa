import {androidPublicGoogleBillingHandler} from './handler.mjs';
import {verifiedAndroidDeploymentIdentity} from './deploymentIdentity.mjs';
import {androidSupabaseTransport} from './supabaseTransport.mjs';
import {androidPublicReadOnlyStatus} from './accountStatus.mjs';
import {androidGoogleRuntime} from './googleRuntime.mjs';
import {nativeBillingRepository} from '../native-billing/repository.mjs';
import {createReconciler} from '../native-billing/reconcile.mjs';
import {androidPublicGoogleCheckoutService,androidGoogleCheckoutRepository} from './checkout.mjs';
import {createAndroidStripeReadClient,inspectAndroidPublicStripeBilling} from './stripeInspection.mjs';
import {androidGooglePublicEvent} from './googleEvents.mjs';

/** Each request has its own frozen configuration/dependencies. Disabled routes
 * create no transport/provider/repository and do no account or ledger work. */
export function androidPublicBillingApplication(route,{
  env=process.env,verifyDeploymentIdentity=verifiedAndroidDeploymentIdentity,
  createTransport=androidSupabaseTransport,createRuntime=androidGoogleRuntime,
  createRepository=nativeBillingRepository,reconciler=createReconciler,now=Date.now,
  createStripeReadClient=createAndroidStripeReadClient,inspectStripe=inspectAndroidPublicStripeBilling,
}={}) {
  return async(req,res)=>{
    let transport,repository,runtime,checkoutRepository;
    const connections=config=>{
      if(!transport){
        transport=createTransport(config);checkoutRepository=androidGoogleCheckoutRepository(transport.adminRows);
        const original=createRepository(transport.adminRows);
        repository={...original,async apply(status) {
          if(status?.provider!=='google' || status.environment!=='Production')throw new Error('Google billing unavailable.');
          const result=await original.apply(status);
          // Durable apply is retried before acknowledgement. An expired restore
          // may have nothing to settle; false is a valid no-op, an RPC error is
          // retryable and must prevent ACK/event completion.
          if(['applied','duplicate'].includes(result))await checkoutRepository.settleVerifiedGoogleCheckout(status.userId);
          return result;
        }};
      }
      return {transport,repository};
    };
    const provider=async config=>runtime ??= await createRuntime(config);
    const checkout=config=>{
      const {transport}=connections(config);
      return androidPublicGoogleCheckoutService({repository:checkoutRepository,enabled:config.newSalesEnabled===true,
        ready:async()=>{await (await provider(config)).ready();},
        inspectWebsiteBilling:account=>inspectStripe({account,readSubscription:id=>transport.subscriptionFor(id),
          createClient:()=>createStripeReadClient(config.stripe)})});
    };
    const handler=androidPublicGoogleBillingHandler({route,env,verifyDeploymentIdentity,now,
      newCheckoutReady:true,
      authenticateCafe:(request,config)=>connections(config).transport.authenticateCafe(request),
      status:({account,configuration})=>androidPublicReadOnlyStatus({account,...connections(configuration),now,checkoutEnabled:configuration.newSalesEnabled}),
      prepareGoogleCheckout:({account,configuration,selection})=>checkout(configuration).prepare(account,selection),
      startGoogleCheckout:({account,configuration,selection,attemptId})=>checkout(configuration).start(account,attemptId,selection),
      cancelGoogleCheckout:({account,configuration,attemptId,reason})=>checkout(configuration).cancel(account,attemptId,reason),
      async verifyGooglePurchase({account,configuration,proof}) {
        const {repository}=connections(configuration);
        const runtime=await provider(configuration);
        const result=await reconciler({repository,providers:{google:runtime.provider},environment:'Production'})
          .reconcile({provider:'google',proof,accountId:account.id});
        return {accountId:account.id,verified:true,purchase:{provider:'google',access:result.access,status:result.status,
          currentPeriodEnd:result.currentPeriodEnd,autoRenews:result.autoRenews,canManage:result.canManage}};
      },
      async handleGoogleEvent({authorization,body,configuration}) {
        const runtime=await provider(configuration);
        // Authenticate the Pub/Sub envelope before constructing a DB transport.
        const event=await runtime.notification(authorization,body);
        const {repository}=connections(configuration);
        const service=reconciler({repository,providers:{google:runtime.provider},environment:'Production'});
        await androidGooglePublicEvent({event,payload:body.message.data,repository,runtime,reconcile:service.reconcile});
      },
    });
    return handler(req,res);
  };
}
