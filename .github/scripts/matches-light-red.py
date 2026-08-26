from pathlib import Path
p=Path('dashboard.html')
s=p.read_text()
old='.wow-stat:nth-child(3){background:linear-gradient(145deg,#fff,#fff0f4)}.wow-stat:nth-child(3) .wow-bars i{background:#f291ad}'
new='.wow-stat:nth-child(3){background:linear-gradient(145deg,#fff,#fff1f1)}.wow-stat:nth-child(3) .wow-bars i{background:#ef7777}'
if old not in s:
    raise SystemExit('matches color target not found')
p.write_text(s.replace(old,new,1))
