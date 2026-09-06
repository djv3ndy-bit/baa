from pathlib import Path
import hashlib
root=Path.cwd()
expected={
'mobile/app/cafe-trial.tsx':['24d52bf11a4e71aeed610180ceb33fa8d25d57ac7904d18a6a612a518ffcd487','20bee6cf135856dd5929a2f4a28580558b22d663c8a1289d4e381f78b9a8051a'],
'mobile/app/candidates.tsx':['52fdbd80b59794c6d4a929137aba04d8df46c07a267ff46df3a29ab477aed9d6','e882b1422e08bac164bbeda9123b58d4b3a7e8c7d9cec5391d5b525118158817'],
'mobile/app/chat/[id].tsx':['076fdc74f1eefb7e54251a4ddf689a60c5851c6f53fa8742ce47a1775cd71c01','483c9dc647842f754d14a9a9458666466a3ecb0dc5a49e9d8316a93cd2bd4c45'],
'mobile/app/discover.tsx':['4274b4ba0ea1acf44f24b9103298f9827c78ecd2f1f3335c78756a719a2ba8e9','67e9dab64d50623683362e21285420486bf51b877c726eb9a29fb2d7ab23ad43'],
'mobile/app/jobs.tsx':['b11f7f4ced6018e6841190b9a14b0bd8e48951cb6b25a4203cd4ba92ee0af99b','ee0828a35711496dcb9dc4361d4d6a9cc76d0e742a5bcf7065d62ea1ddedd329'],
'mobile/app/post-job.tsx':['4b30313596aa154731ce9e7bf9f5345c51fb939ec20b1451903b35899407cd44','efcd3eea042eb8ed7cfed1cc135e3d12deae8cccc0b70f7b4dede5b69ae9a352'],
'mobile/app/profile.tsx':['c3430b1fdc7e4b66d973b2296c9dea6cea0618c0fecd7e0a7b1283c4c44f6320','2210e7efe6c4ad8e67a0f3f8caa48f9e904c4297438a373d0a1cc504702f5a92'],
'mobile/app/settings.tsx':['402ef0a6f46301656bdd919eee91d052252b5df0e55143262ff18ff57787be17','6fdf3b4f077b4d4d2d5b8aff4c5dfd9018e03d23a0c6d7c9aef7a88e55e0aa92'],
'mobile/app/subscription.tsx':['deb813d54932c95bf9411654648cf5d59954c159d786dc28f5134a176e516b21','be50021f04b69ee815514b995bc878da2d31a7538ed71ce0043ad61d44f62bc8'],
'mobile/components/QuietFocusHome.tsx':['08abc0ee3d8ca6066910f2d52020c3493d0d0afb4ec61922a0b37303c5f9da81','31b0fd2af9218fe89392a8cd4deb05142229d5d4dbb3b94329ab7bef8124cf39']}
for name,(before,after) in expected.items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==before, 'Source changed: '+name

def edit(path,replacements):
 p=root/path; s=p.read_text()
 for old,new in replacements:
  assert s.count(old)==1,(path,old[:100],s.count(old))
  s=s.replace(old,new)
 p.write_text(s)
edit('mobile/app/profile.tsx',[
 ('<View style={s.header}>\n        <View>', '<View style={s.header}>\n        <View style={s.headerCopy}>'),
 ('<Pressable onPress={() => router.push("/settings")} style={s.settings}>\n          <Text style={{ fontSize: 20 }}>⚙</Text>', '<Pressable accessibilityRole="button" accessibilityLabel="Open account settings" onPress={() => router.push("/settings")} style={s.settings}>\n          <Text allowFontScaling={false} style={{ fontSize: 20 }}>⚙</Text>'),
 ('    paddingBottom: 10,\n    flexDirection: "row",','    paddingBottom: 10,\n    gap: 12,\n    flexDirection: "row",'),
 ('  title: { fontSize: 31,', '  // Reserve the trailing action width; long subtitles must wrap, not push it off screen.\n  headerCopy: { flex: 1, minWidth: 0 },\n  title: { fontSize: 31,'),
 ('  settings: {\n    width: 44,','  settings: {\n    flexShrink: 0,\n    width: 44,'),
 ('  name: { fontSize: 28, fontWeight: "900", color: "#321708", marginTop: 12 },','  name: { maxWidth: "100%", textAlign: "center", fontSize: 28, fontWeight: "900", color: "#321708", marginTop: 12 },'),
 ('  location: { fontSize: 14, color: "#746a61", marginTop: 5 },','  location: { maxWidth: "100%", textAlign: "center", fontSize: 14, color: "#746a61", marginTop: 5 },'),
 ('  mediaRow: {\n    flexDirection: "row",','  mediaRow: {\n    flexDirection: "row",\n    flexWrap: "wrap",'),
 ('  mediaValue: { flex: 1, fontSize: 12,','  mediaValue: { flexGrow: 1, flexShrink: 1, flexBasis: 100, minWidth: 0, fontSize: 12,'),
 ('  mediaButton: {\n    backgroundColor:', '  mediaButton: {\n    maxWidth: "100%",\n    flexShrink: 0,\n    backgroundColor:'),
 ('  mediaButtonText: { fontSize: 11,', '  mediaButtonText: { flexShrink: 1, textAlign: "center", fontSize: 11,'),
 ('    paddingHorizontal: 12,\n    flexDirection: "row",\n    alignItems: "center",\n    backgroundColor: "#fff",','    paddingHorizontal: 12,\n    flexDirection: "row",\n    flexWrap: "wrap",\n    alignItems: "center",\n    backgroundColor: "#fff",'),
 ('  dayCheck: {\n    flex: 1,','  dayCheck: {\n    flexGrow: 1,\n    flexShrink: 1,\n    flexBasis: 120,\n    minWidth: 0,'),
 ('  dayText: { fontSize: 13,','  dayText: { flexShrink: 1, fontSize: 13,'),
 ('  hoursInput: {\n    width: 116,','  hoursInput: {\n    flexGrow: 1,\n    width: 116,'),
 ('  choice: {\n    flexDirection: "row",','  choice: {\n    maxWidth: "100%",\n    flexDirection: "row",'),
 ('  choiceText: { fontSize: 11,','  choiceText: { flexShrink: 1, fontSize: 11,'),
])
edit('mobile/app/discover.tsx',[
 ('<View style={styles.header}><View><Text style={styles.logo}>','<View style={styles.header}><View style={styles.headerCopy}><Text style={styles.logo}>'),
 ("<Pressable onPress={()=>router.push('/settings')} style={styles.filter}><Text style={styles.filterText}>","<Pressable accessibilityRole=\"button\" accessibilityLabel=\"Open account settings\" onPress={()=>router.push('/settings')} style={styles.filter}><Text allowFontScaling={false} style={styles.filterText}>"),
 ('<View><Text style={styles.logo}>Barista<Text style={styles.logoAccent}>Match</Text></Text><Text style={styles.tagline}>SWIPE', '<View style={styles.headerCopy}><Text style={styles.logo}>Barista<Text style={styles.logoAccent}>Match</Text></Text><Text style={styles.tagline}>SWIPE'),
 ("header:{paddingHorizontal:20,", "headerCopy:{flex:1,minWidth:0},header:{gap:12,paddingHorizontal:20,"),
 ("filter:{width:42,height:42,", "filter:{flexShrink:0,width:44,height:44,"),
])
edit('mobile/components/QuietFocusHome.tsx',[
 ('<Text style={styles.settingsIcon}>⚙</Text>', '<Text allowFontScaling={false} style={styles.settingsIcon}>⚙</Text>'),
 ("brandRow: { flexDirection: 'row',", "brandRow: { gap: 12, flexDirection: 'row',"),
 ("brandLockup: { flexDirection: 'row',", "brandLockup: { flex: 1, minWidth: 0, flexDirection: 'row',"),
 ('brandImage: { width: 33,', 'brandImage: { flexShrink: 0, width: 33,'),
 ("brand: { color: '#17110d',", "brand: { flexShrink: 1, minWidth: 0, color: '#17110d',"),
 ('settingsButton: { width: 40, height: 40,','settingsButton: { flexShrink: 0, width: 44, height: 44,'),
 ('<View style={styles.profileTop}>\n                <View>', '<View style={styles.profileTop}>\n                <View style={styles.profileHeading}>'),
 ('  profileTop:', '  profileHeading: { flex: 1, minWidth: 0 },\n  profileTop:'),
 ('featureButton: { minHeight: 43,', 'featureButton: { paddingHorizontal: 8, paddingVertical: 10, minHeight: 44,'),
 ("featureButtonText: { color: '#fff',", "featureButtonText: { textAlign: 'center', flexShrink: 1, color: '#fff',"),
])
edit('mobile/app/candidates.tsx',[
 ('<View style={s.header}><Text style={s.logo}>Barista<Text style={s.accent}>Match</Text></Text><Text style={s.kicker}>CANDIDATES</Text></View>', '<View style={s.header}><View style={s.headerCopy}><Text style={s.logo}>Barista<Text style={s.accent}>Match</Text></Text><Text style={s.kicker}>CANDIDATES</Text></View></View>'),
 ('<View style={s.header}><View><Text style={s.logo}>', '<View style={s.header}><View style={s.headerCopy}><Text style={s.logo}>'),
 ("header:{padding:18,", "headerCopy:{flex:1,minWidth:0},header:{gap:12,padding:18,"),
 ("count:{fontWeight:'800',", "count:{flexShrink:0,fontWeight:'800',"),
 ("tag:{backgroundColor:", "tag:{maxWidth:'100%',backgroundColor:"),
 ("tagText:{fontSize:11,", "tagText:{flexShrink:1,fontSize:11,"),
])
edit('mobile/app/jobs.tsx',[
 ("<Pressable onPress={()=>router.back()}><Text style={s.back}>‹</Text></Pressable><View><Text style={s.title}>","<Pressable accessibilityRole=\"button\" accessibilityLabel=\"Go back\" style={s.backButton} onPress={()=>router.back()}><Text allowFontScaling={false} style={s.back}>‹</Text></Pressable><View style={s.headerCopy}><Text style={s.title}>"),
 ("<Pressable style={s.add} onPress={()=>router.push('/post-job')}><Text style={s.addText}>","<Pressable accessibilityRole=\"button\" accessibilityLabel=\"Post a job\" style={s.add} onPress={()=>router.push('/post-job')}><Text allowFontScaling={false} style={s.addText}>"),
 ("header:{minHeight:72,", "headerCopy:{flex:1,minWidth:0},backButton:{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center'},header:{minHeight:72,paddingVertical:10,"),
 ("add:{marginLeft:'auto',width:42,height:42,", "add:{flexShrink:0,width:44,height:44,"),
])
edit('mobile/app/settings.tsx',[
 ('<Pressable onPress={() => router.back()}>\n          <Text style={s.back}>', '<Pressable accessibilityRole="button" accessibilityLabel="Go back" style={s.backButton} onPress={() => router.back()}>\n          <Text allowFontScaling={false} style={s.back}>'),
 ('<View style={{ width: 32 }} />', '<View style={s.headerSpacer} />'),
 ('    height: 66,','    minHeight: 66,\n    paddingVertical: 10,\n    gap: 12,'),
 ('  back: { fontSize: 34,','  backButton: { width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center" },\n  headerSpacer: { width: 44, flexShrink: 0 },\n  back: { fontSize: 34,'),
 ('  title: { fontSize: 19,','  title: { flex: 1, minWidth: 0, textAlign: "center", fontSize: 19,'),
])
edit('mobile/app/post-job.tsx',[
 ('<Pressable onPress={() => router.back()}><Text style={styles.back}>', '<Pressable accessibilityRole="button" accessibilityLabel="Go back" style={styles.backButton} onPress={() => router.back()}><Text allowFontScaling={false} style={styles.back}>'),
 ('header: { height: 58,', 'backButton: { width: 44, height: 44, flexShrink: 0, alignItems: \'center\', justifyContent: \'center\' }, header: { minHeight: 58, paddingVertical: 8, gap: 12,'),
 ('headerTitle: { fontSize: 18,','headerTitle: { flex: 1, minWidth: 0, textAlign: \'center\', fontSize: 18,'),
 ('headerSpacer: { width: 28 }','headerSpacer: { width: 44, flexShrink: 0 }'),
])
edit('mobile/app/subscription.tsx',[
 ('<Text style={styles.back}>‹</Text>', '<Text allowFontScaling={false} style={styles.back}>‹</Text>'),
 ('header: { height: 60,', 'header: { minHeight: 60, paddingVertical: 8, gap: 12,'),
 ('backButton: { width: 38, height: 42,', 'backButton: { flexShrink: 0, width: 44, height: 44,'),
 ('headerTitle: { fontSize: 18,', 'headerTitle: { flex: 1, minWidth: 0, textAlign: \'center\', fontSize: 18,'),
 ('headerSpacer: { width: 38 }', 'headerSpacer: { width: 44, flexShrink: 0 }'),
])
edit('mobile/app/chat/[id].tsx',[
 ('<Pressable onPress={() => router.back()} style={s.back}><Text style={s.backText}>','<Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={s.back}><Text allowFontScaling={false} style={s.backText}>'),
 ('<View style={s.heading}><Text style={s.name}>{name}</Text><Text style={s.sub}>','<View style={s.heading}><Text accessibilityLabel={name} numberOfLines={2} ellipsizeMode="tail" style={s.name}>{name}</Text><Text numberOfLines={2} style={s.sub}>'),
 ('<Pressable accessibilityLabel="Conversation safety options"', '<Pressable accessibilityRole="button" accessibilityLabel="Conversation safety options"'),
 ('<Text style={s.safetyText}>•••</Text>', '<Text allowFontScaling={false} style={s.safetyText}>•••</Text>'),
 ('header: { height: 72,', 'header: { minHeight: 72, paddingVertical: 8,'),
 ('back: { width: 38, height: 38,', 'back: { flexShrink: 0, width: 44, height: 44,'),
 ('avatar: { width: 42, height: 42,', 'avatar: { flexShrink: 0, width: 42, height: 42,'),
 ('safety: { width: 40, height: 40,', 'safety: { flexShrink: 0, width: 44, height: 44,'),
])
edit('mobile/app/cafe-trial.tsx',[
 ('<View><Text style={s.kicker}>FREE CAFÉ PLAN', '<View style={s.heading}><Text style={s.kicker}>FREE CAFÉ PLAN'),
 ("head:{flexDirection:'row'", "heading:{flex:1,minWidth:0},head:{flexDirection:'row'"),
 ('crown:{width:56,', 'crown:{flexShrink:0,width:56,'),
 ('benefitText:{fontSize:12,', 'benefitText:{flex:1,minWidth:0,fontSize:12,'),
 ('buttonText:{fontSize:14,', "buttonText:{textAlign:'center',flexShrink:1,fontSize:14,"),
 ('button:{marginTop:23,', 'button:{paddingHorizontal:12,marginTop:23,'),
 ('<Text style={s.crownText}>1</Text>', '<Text allowFontScaling={false} style={s.crownText}>1</Text>'),
])
for name,(before,after) in expected.items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==after, 'Output changed: '+name
print('Verified exact UI changes in',len(expected),'source files')
