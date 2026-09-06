"""Reproduce the locally reviewed indentation before the unchanged output hash check."""
from pathlib import Path
script=Path('.github/scripts/apply-launch-checklist.py').read_text()
old="p=root/'mobile/app/profile.tsx';p.write_text("
extra="""p=root/'mobile/app/profile.tsx'
s=p.read_text()
start=s.index('      const permission =', s.index('if (needsMediaLibraryPermission(Platform.OS, kind))'))
end=s.index('      }\\n      const result = await ImagePicker.launchImageLibraryAsync({',start)
s=s[:start]+''.join('  '+line if line.strip() else line for line in s[start:end].splitlines(keepends=True))+s[end:]
p.write_text(s)
"""
assert script.count(old)==1
script=script.replace(old,extra+old)
exec(compile(script,'reviewed-launch-checklist-application','exec'),{'__name__':'__main__'})
