from pathlib import Path

path = Path('dashboard.html')
text = path.read_text()
marker = '</style>'
css = r'''
/* Mobile Discover café/barista card layout fix */
@media(max-width:720px){
  .job-item{
    display:grid;
    grid-template-columns:56px minmax(0,1fr);
    gap:12px 14px;
    align-items:start;
    padding:18px 0;
    width:100%;
  }
  .job-item .avatar{
    width:56px;
    height:56px;
    border-radius:14px;
    grid-column:1;
    grid-row:1;
  }
  .job-item .itemtext{
    grid-column:2;
    grid-row:1;
    min-width:0;
    width:100%;
  }
  .job-item .itemtext b{
    font-size:18px;
    line-height:1.25;
  }
  .job-item .itemtext small{
    font-size:14px;
    line-height:1.45;
    overflow-wrap:anywhere;
    word-break:normal;
  }
  .job-item .applicant-actions{
    grid-column:1/-1;
    grid-row:2;
    display:grid;
    grid-template-columns:minmax(0,1fr) minmax(0,1fr);
    gap:10px;
    width:100%;
    margin-top:4px;
  }
  .job-item .applicant-actions button{
    width:100%;
    min-width:0;
    min-height:48px;
    padding:12px 10px;
    white-space:normal;
    line-height:1.2;
    text-align:center;
  }
  .job-item .applicant-actions button:only-child{
    grid-column:1/-1;
  }
  .card:has(.job-item){
    padding:18px;
    overflow:hidden;
  }
  .card:has(.job-item)>h3{
    font-size:22px;
    margin-bottom:8px;
  }
}
@media(max-width:390px){
  .job-item{grid-template-columns:50px minmax(0,1fr);gap:11px 12px}
  .job-item .avatar{width:50px;height:50px}
  .job-item .applicant-actions{grid-template-columns:1fr}
  .job-item .applicant-actions button{grid-column:1/-1}
}
'''
if 'Mobile Discover café/barista card layout fix' not in text:
    text = text.replace(marker, css + '\n' + marker, 1)
path.write_text(text)
