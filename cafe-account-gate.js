// Resolve the saved account role before displaying café plan information.
window.BaristaMatchCafeGate={
  async authorize(){
    const response=await fetch('/api/config',{cache:'no-store'});
    const config=await response.json();
    if(!response.ok||!config.supabaseUrl||!config.supabasePublishableKey||!window.supabase?.createClient)throw new Error('The account service is unavailable. Please try again.');
    const client=window.supabase.createClient(config.supabaseUrl,config.supabasePublishableKey);
    const sessionResult=await client.auth.getSession();
    if(sessionResult.error)throw new Error('Your session could not be checked. Please log in again.');
    const session=sessionResult.data?.session;
    if(!session){location.replace('/signup.html?role=cafe_owner_manager');return null}
    const {data:profile,error}=await client.from('profiles').select('role').eq('id',session.user.id).maybeSingle();
    if(error)throw new Error('Your café account could not be checked. Please try again.');
    if(!profile){location.replace('/signup.html?complete=1');return null}
    if(profile.role!=='cafe_owner_manager'){location.replace('/dashboard.html');return null}
    const latest=await client.auth.getSession();
    if(latest.error||latest.data?.session?.user?.id!==session.user.id){location.replace('/login.html');return null}
    return {client,session};
  }
};
