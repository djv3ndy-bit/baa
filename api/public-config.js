export default function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const url=process.env.SUPABASE_URL;
  const key=process.env.SUPABASE_PUBLISHABLE_KEY;
  if(!url||!key)return res.status(503).json({error:'Configuration unavailable'});
  res.setHeader('Cache-Control','public, max-age=300');
  return res.status(200).json({supabaseUrl:url,supabaseKey:key});
}
