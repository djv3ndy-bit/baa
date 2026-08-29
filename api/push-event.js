import {claimPushEvent,getAuthenticatedUser,getRows,locationMatches,profileName,sendPushToUsers} from './_push.js';

const clean=(value,max=500)=>String(value??'').trim().slice(0,max);

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(!process.env.SUPABASE_URL||!process.env.SUPABASE_PUBLISHABLE_KEY||!process.env.SUPABASE_SECRET_KEY)return res.status(503).json({error:'Notifications are temporarily unavailable.'});
  const user=await getAuthenticatedUser(req);
  if(!user?.id)return res.status(401).json({error:'Please log in again.'});
  const type=clean(req.body?.type,40);
  try{
    if(type==='interest'){
      const targetId=clean(req.body?.target_id,80);
      const interests=await getRows(`discovery_interests?sender_id=eq.${encodeURIComponent(user.id)}&target_id=eq.${encodeURIComponent(targetId)}&select=id&limit=1`);
      if(!interests.length)return res.status(403).json({error:'Interest could not be verified.'});
      const reciprocal=await getRows(`discovery_interests?sender_id=eq.${encodeURIComponent(targetId)}&target_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`);
      const matches=reciprocal.length?await getRows(`discovery_matches?or=(and(barista_id.eq.${encodeURIComponent(user.id)},cafe_id.eq.${encodeURIComponent(targetId)}),and(barista_id.eq.${encodeURIComponent(targetId)},cafe_id.eq.${encodeURIComponent(user.id)}))&select=id&limit=1`):[];
      const eventKey=matches.length?`discovery-match:${matches[0].id}`:`discovery-interest:${interests[0].id}`;
      if(!await claimPushEvent(eventKey))return res.status(200).json({success:true,sent:0,duplicate:true});
      const sender=await profileName(user.id);
      const notice=reciprocal.length
        ?{title:'It’s a match ☕',body:`You and ${sender} are interested in each other.`,data:{route:'/matches',type:'match'}}
        :{title:'Someone is interested',body:`${sender} is interested in your profile.`,data:{route:'/discover',type:'interest'}};
      const result=await sendPushToUsers([targetId],notice);
      return res.status(200).json({success:true,...result});
    }
    if(type==='discovery_message'){
      const matchId=clean(req.body?.match_id,80),messageId=clean(req.body?.message_id,80);
      const matches=await getRows(`discovery_matches?id=eq.${encodeURIComponent(matchId)}&select=id,barista_id,cafe_id&limit=1`);
      const match=matches[0];
      if(!match||![match.barista_id,match.cafe_id].includes(user.id))return res.status(403).json({error:'Conversation could not be verified.'});
      const messages=await getRows(`discovery_messages?id=eq.${encodeURIComponent(messageId)}&match_id=eq.${encodeURIComponent(matchId)}&sender_id=eq.${encodeURIComponent(user.id)}&select=id,body&limit=1`);
      if(!messages.length)return res.status(403).json({error:'Message could not be verified.'});
      if(!await claimPushEvent(`discovery-message:${messages[0].id}`))return res.status(200).json({success:true,sent:0,duplicate:true});
      const body=clean(messages[0].body,240);
      const sender=await profileName(user.id),recipient=user.id===match.barista_id?match.cafe_id:match.barista_id;
      const result=await sendPushToUsers([recipient],{title:`New message from ${sender}`,body:body||'Open BaristaMatch to read it.',data:{route:`/chat/${matchId}?kind=discovery`,type:'message'}});
      return res.status(200).json({success:true,...result});
    }
    if(type==='job'){
      const jobId=clean(req.body?.job_id,80);
      const jobs=await getRows(`jobs?id=eq.${encodeURIComponent(jobId)}&owner_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=id,title,city,state,postal_code&limit=1`);
      const job=jobs[0];
      if(!job)return res.status(403).json({error:'Job could not be verified.'});
      if(!await claimPushEvent(`job:${job.id}`))return res.status(200).json({success:true,sent:0,duplicate:true});
      const profiles=await getRows('profiles?role=eq.barista&is_discoverable=eq.true&suspended_at=is.null&select=id,preferred_city,preferred_state,preferred_postal_code&limit=500');
      const nearby=profiles.filter(profile=>locationMatches(job,profile)).map(profile=>profile.id);
      const cafe=await profileName(user.id);
      const result=await sendPushToUsers(nearby,{title:'New job near you',body:`${cafe} just posted ${job.title}.`,data:{route:'/discover',type:'job',jobId:job.id}});
      return res.status(200).json({success:true,recipients:nearby.length,...result});
    }
    return res.status(400).json({error:'Unsupported notification event.'});
  }catch(error){
    console.error('Push event failed',type,error?.message||error);
    return res.status(500).json({error:'The notification could not be sent.'});
  }
}
