from pathlib import Path

p=Path('mobile/app/discover.tsx')
s=p.read_text()
s=s.replace('import { supabase } from \'@/lib/supabase\';','import { supabase } from \'@/lib/supabase\';\nimport { AppBottomNav } from \'@/components/AppBottomNav\';')
old='''      <View style={styles.bottomNav}>\n        <Nav icon="☕" label="Discover" active onPress={()=>{}} />\n        <Nav icon="♡" label="Matches" onPress={()=>router.push('/home')} />\n        <Nav icon="✉" label="Messages" onPress={()=>router.push('/home')} />\n        <Nav icon="◯" label="Profile" onPress={()=>router.push('/home')} />\n      </View>'''
new='''      <AppBottomNav active="discover" role="barista"/>'''
if old not in s: raise SystemExit('discover nav marker missing')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('mobile/app/home.tsx')
s=p.read_text()
# Route quick actions into real screens.
s=s.replace('<Action icon="☕" title="Find jobs" copy="Browse café opportunities near you." />','<Action icon="☕" title="Find jobs" copy="Browse café opportunities near you." onPress={()=>router.push(\'/discover\')} />')
s=s.replace('<Action icon="🤝" title="Matches" copy="See cafés that matched with you." />','<Action icon="🤝" title="Matches" copy="See cafés that matched with you." onPress={()=>router.push(\'/matches\')} />')
s=s.replace('<Action icon="💬" title="Messages" copy="Continue conversations with matched cafés." />','<Action icon="💬" title="Messages" copy="Continue conversations with matched cafés." onPress={()=>router.push(\'/messages\')} />')
s=s.replace('<Action icon="👤" title="My profile" copy="Keep your profile and coffee showcase updated." />','<Action icon="👤" title="My profile" copy="Keep your profile and coffee showcase updated." onPress={()=>router.push(\'/profile\')} />')
s=s.replace('<Action icon="☕" title="Candidates" copy="Review interested baristas." />','<Action icon="☕" title="Candidates" copy="Review interested baristas." onPress={()=>router.push(\'/candidates\')} />')
s=s.replace('<Action icon="🤝" title="Matches" copy="See your active hiring connections." />','<Action icon="🤝" title="Matches" copy="See your active hiring connections." onPress={()=>router.push(\'/matches\')} />')
s=s.replace('<Action icon="💬" title="Messages" copy="Chat with matched baristas." />','<Action icon="💬" title="Messages" copy="Chat with matched baristas." onPress={()=>router.push(\'/messages\')} />')
old_sig='function Action({ icon, title, copy }: { icon: string; title: string; copy: string }) {'
new_sig='function Action({ icon, title, copy, onPress }: { icon: string; title: string; copy: string; onPress?:()=>void }) {'
s=s.replace(old_sig,new_sig)
s=s.replace("return <Pressable style={({ pressed }) => [styles.action, pressed && { opacity: .85 }]}>","return <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && { opacity: .85 }]}>")
p.write_text(s)
