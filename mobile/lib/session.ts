import { supabase } from './supabase';
export type AppRole='barista'|'cafe_owner_manager';
export async function getCurrentContext(){
  // Navigation should use the persisted client session. Calling getUser() here
  // adds a network round trip and can incorrectly send a signed-in user back to
  // login when the phone has a slow or temporarily unavailable connection.
  const {data:{session}}=await supabase.auth.getSession();
  const user=session?.user??null;
  if(!user)return {user:null,profile:null,role:null as AppRole|null};
  const {data:profile}=await supabase.from('profiles').select('*').eq('id',user.id).maybeSingle();
  const role=(profile?.role==='cafe_owner_manager'?'cafe_owner_manager':'barista') as AppRole;
  return {user,profile,role};
}
