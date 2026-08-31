import { adminRows, stripeClient, updateSubscription } from "./_billing.js";
export const config = { api:{ bodyParser:false } };
async function body(req){const chunks=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));return Buffer.concat(chunks)}
function periodEnd(s){const unix=s.current_period_end||s.items?.data?.[0]?.current_period_end;return unix?new Date(unix*1000).toISOString():null}
async function sync(s){const userId=s.metadata?.cafe_user_id;if(!userId)throw new Error("Subscription is missing cafe_user_id metadata.");await updateSubscription(userId,{stripe_customer_id:String(s.customer),stripe_subscription_id:s.id,status:s.status==='unpaid'?'past_due':s.status,current_period_end:periodEnd(s),cancel_at_period_end:Boolean(s.cancel_at_period_end)})}
async function invoicePayment(invoice,status){const source=invoice.subscription||invoice.parent?.subscription_details?.subscription,id=typeof source==='string'?source:source?.id;if(!id)return;const s=await stripeClient().subscriptions.retrieve(id),userId=s.metadata?.cafe_user_id;if(!userId)return;await adminRows("subscription_payments?on_conflict=provider_payment_id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({cafe_user_id:userId,provider:"stripe",provider_payment_id:invoice.id,amount_cents:invoice.amount_paid||invoice.amount_due||0,currency:invoice.currency||"usd",status,paid_at:status==="succeeded"?new Date((invoice.status_transitions?.paid_at||Math.floor(Date.now()/1000))*1000).toISOString():null})})}
export default async function handler(req,res){
  if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).send("Method not allowed")}
  try{
    const event=stripeClient().webhooks.constructEvent(await body(req),req.headers["stripe-signature"],process.env.STRIPE_WEBHOOK_SECRET);
    const previous=await adminRows(`stripe_webhook_events?event_id=eq.${encodeURIComponent(event.id)}&select=event_id&limit=1`);if(previous.length)return res.status(200).json({received:true,duplicate:true});
    if(["customer.subscription.created","customer.subscription.updated","customer.subscription.deleted"].includes(event.type))await sync(event.data.object);
    if(event.type==="invoice.paid")await invoicePayment(event.data.object,"succeeded");
    if(event.type==="invoice.payment_failed")await invoicePayment(event.data.object,"failed");
    await adminRows("stripe_webhook_events",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({event_id:event.id,event_type:event.type})});
    return res.status(200).json({received:true});
  }catch(error){console.error("Stripe webhook rejected",error?.message||error);return res.status(400).send("Webhook rejected")}
}
