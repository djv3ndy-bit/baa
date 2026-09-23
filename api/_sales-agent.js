const clean=(value,max=500)=>String(value??'').trim().slice(0,max);
export function prioritizeCafeLead(lead={}) {
 const city=clean(lead.city,80).toLowerCase(), state=clean(lead.state,30).toLowerCase(), name=clean(lead.name,160), website=clean(lead.website,300), contact=clean(lead.contact_channel,60).toLowerCase();
 const hiring=Boolean(lead.hiring_signal), independent=lead.independent!==false, florida=state==='fl'||state==='florida'||/miami|fort lauderdale|hollywood|north miami|broward|dade/.test(city);
 let score=0;if(name)score+=10;if(florida)score+=30;if(hiring)score+=30;if(independent)score+=15;if(website)score+=10;if(contact)score+=5;
 const priority=score>=75?'High':score>=50?'Medium':'Low';
 return Object.freeze({version:'cafe-sales-v1',score,priority,qualified:score>=50,reasons:{florida,hiring_signal:hiring,independent,website_present:Boolean(website),contact_channel_present:Boolean(contact)},autonomous_outreach_allowed:false,email_send_allowed:false,dm_send_allowed:false,ad_spend_allowed:false,pricing_change_allowed:false,financial_action_allowed:false,user_write_allowed:false,production_write_allowed:false,owner_approval_required_for_outreach:true});
}
export function draftCafeOutreach(lead={},result=prioritizeCafeLead(lead)){
 const name=clean(lead.name,160)||'your café', city=clean(lead.city,80), location=city?' in '+city:'';
 return {subject:'A simpler way to find local baristas',body:'Hi '+name+' team,\n\nI’m reaching out from BaristaMatch, a hiring platform built specifically for cafés and baristas. We’re growing our Florida café network'+location+' and would love to invite your team to take a look.\n\nBaristaMatch is designed to make it easier to post café roles and connect with local baristas without the noise of a general job board.\n\nIf it sounds useful, I can share the details.\n\n— BaristaMatch',approval_required:true,send_allowed:false,lead_priority:result.priority};
}
export function privateLeadSummary(lead={},result=prioritizeCafeLead(lead)){return {task:'Café prospect: '+(clean(lead.name,120)||'Unnamed café'),priority:result.priority,summary:'Sales prospect scored '+result.score+'/100. Florida='+result.reasons.florida+'; hiring signal='+result.reasons.hiring_signal+'; independent='+result.reasons.independent+'. Outreach is draft-only and requires owner approval.',owner_approval_required:true};}