const clean=(value,max=500)=>String(value??'').trim().slice(0,max);
export function prioritizeCafeLead(lead={}) {
 const city=clean(lead.city,80).toLowerCase(), state=clean(lead.state,30).toLowerCase(), name=clean(lead.name,160), website=clean(lead.website,300), contact=clean(lead.contact_channel,60).toLowerCase();
 const hiring=Boolean(lead.hiring_signal), independent=lead.independent!==false, florida=state==='fl'||state==='florida'||/miami|fort lauderdale|hollywood|north miami|broward|dade/.test(city);
 let score=0;if(name)score+=10;if(florida)score+=30;if(hiring)score+=30;if(independent)score+=15;if(website)score+=10;if(contact)score+=5;
 const priority=score>=75?'High':score>=50?'Medium':'Low';
 return Object.freeze({version:'cafe-sales-v1',score,priority,qualified:score>=50,reasons:{florida,hiring_signal:hiring,independent,website_present:Boolean(website),contact_channel_present:Boolean(contact)},autonomous_outreach_allowed:false,email_send_allowed:false,dm_send_allowed:false,ad_spend_allowed:false,pricing_change_allowed:false,financial_action_allowed:false,user_write_allowed:false,production_write_allowed:false,owner_approval_required_for_outreach:true});
}
export function draftCafeOutreach(lead={},result=prioritizeCafeLead(lead),channel='instagram_dm'){
 const name=clean(lead.name,160)||'your café', city=clean(lead.city,80), location=city?' in '+city:'';
 if(channel==='email') return {channel:'email',body:'',approval_required:true,send_allowed:false,blocked:true,reason:'Owner policy: do not use email for café sales outreach.'};
 const body=channel==='in_person'
  ? 'Hi — I’m with BaristaMatch. We’re building a Florida platform specifically for cafés that need baristas'+location+'. I noticed '+name+' and thought it could be a good fit. If you’re open to it, I can show you how it works.'
  : 'Hi '+name+'! I’m with BaristaMatch, a Florida platform built specifically to connect cafés with baristas'+location+'. I thought your team could be a great fit. If you’re open to it, I’d be happy to share how it works. ☕';
 return {channel:channel==='in_person'?'in_person':'instagram_dm',body,approval_required:true,send_allowed:false,blocked:false,lead_priority:result.priority};
}
export function privateLeadSummary(lead={},result=prioritizeCafeLead(lead)){return {task:'Café prospect: '+(clean(lead.name,120)||'Unnamed café'),priority:result.priority,summary:'Sales prospect scored '+result.score+'/100. Florida='+result.reasons.florida+'; hiring signal='+result.reasons.hiring_signal+'; independent='+result.reasons.independent+'. Outreach is draft-only and requires owner approval.',owner_approval_required:true};}