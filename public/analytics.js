(()=>{
  if(navigator.doNotTrack==='1'||window.location.hostname==='localhost')return;
  const path=(location.pathname||'/').slice(0,300);
  let referrer_host='';
  try{if(document.referrer){const host=new URL(document.referrer).hostname;referrer_host=host===location.hostname?'direct/internal':host.slice(0,200)}}catch{}
  const body=JSON.stringify({path,referrer_host});
  if(navigator.sendBeacon){navigator.sendBeacon('/api/analytics',new Blob([body],{type:'application/json'}));return}
  fetch('/api/analytics',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true,credentials:'omit'}).catch(()=>{});
})();
