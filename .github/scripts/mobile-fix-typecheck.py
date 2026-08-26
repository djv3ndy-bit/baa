from pathlib import Path

# Re-apply navigation integration because the previous workflow stopped before commit.
exec(Path('.github/scripts/mobile-integrate.py').read_text())

p=Path('mobile/app/chat/[id].tsx')
s=p.read_text()
s=s.replace("const {data:a}=await supabase.from('applications').select(","const {data:aRaw}=await supabase.from('applications').select(")
s=s.replace(".eq('id',id).maybeSingle();setName(role==='barista'?(a?.job?.owner?.cafe_name||'Café'):(a?.barista?.display_name||'Barista'));", ".eq('id',id).maybeSingle();const a:any=aRaw;setName(role==='barista'?(a?.job?.owner?.cafe_name||'Café'):(a?.barista?.display_name||'Barista'));")
s=s.replace("await supabase.rpc('mark_conversation_read',{p_application_id:id}).catch(()=>{})", "try{await supabase.rpc('mark_conversation_read',{p_application_id:id})}catch{}")
p.write_text(s)
