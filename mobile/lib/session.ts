import { supabase } from './supabase';
export type AppRole='barista'|'cafe_owner_manager';
export async function getCurrentContext(){
  const {data:{user}}=await supabase.auth.getUser();
  if(!user)return {user:null,profile:null,role:null as AppRole|null};
  const {data:profile}=await supabase.from('profiles').select('*').eq('id',user.id).maybeSingle();
  const role=(profile?.role==='cafe_owner_manager'?'cafe_owner_manager':'barista') as AppRole;
  return {user,profile,role};
}
