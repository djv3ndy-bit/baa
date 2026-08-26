from pathlib import Path
p=Path('dashboard.html')
s=p.read_text()
count=s.count('Pricing & Subscription')
if not count:
    raise SystemExit('label not found')
s=s.replace('Pricing & Subscription','Subscription')
p.write_text(s)
print(f'replaced {count} occurrences')
