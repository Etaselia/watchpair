window.pickerFixture = { jobs: [], requests: [], metadataReady: false, failManifest: false };
const originalFetch = window.fetch.bind(window);
const preparation = { status: 'waiting', stage: 'waiting', progress: 0, label: 'Waiting', hardware: false };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: {'content-type':'application/json'} });
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const fixture = window.pickerFixture;
  const body = init.body ? JSON.parse(init.body) : {};
  if (url.pathname === '/api/sessions' && body.action === 'source-manifest' && fixture.failManifest) {
    return reply({error:'Simulated room file-list failure'}, 503);
  }
  if (url.origin !== 'http://127.0.0.1:41735') return originalFetch(input, init);
  fixture.requests.push({path:url.pathname, body});
  if (url.pathname === '/health') return reply({ok:true, protocolVersion:3});
  if (url.pathname === '/resolve') return reply({source:{kind:'magnet',value:'magnet:?xt=urn:btih:d7eda0fc37ad6f117baf0aa6516b2a7a1fe464f3',label:'Nyaa four-season fixture'}});
  if (url.pathname === '/downloads' && init.method === 'POST') {
    const source = body.source;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('magnet\u0000d7eda0fc37ad6f117baf0aa6516b2a7a1fe464f3'));
    const sourceIdentity = [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const job = {id:source.id,kind:'magnet',sourceIdentity,status:'metadata',files:[],downloadFileIndexes:source.downloadFileIndexes,
      progress:0,infoHash:'d7eda0fc37ad6f117baf0aa6516b2a7a1fe464f3',seed:false,peers:0,preparation,transcoder:{label:'CPU',hardware:false},subtitles:[],audioTracks:[],chapters:[],subtitleStatus:'waiting'};
    fixture.jobs.push(job);
    return reply({job});
  }
  for (const job of fixture.jobs) {
    if (fixture.metadataReady && !job.files.length) {
      job.status='downloading';
      job.files = Array.from({length:48},(_,index)=>({index,itemId:`${job.id}-f${index}`,name:`Episode ${index%12+1}.mkv`,path:`Season ${Math.floor(index/12)+1}/Episode ${index%12+1}.mkv`,size:1048576,downloaded:0,progress:0,downloadReady:false,ready:false,selected:false,status:'downloading',preparation,subtitles:[],audioTracks:[],chapters:[],subtitleStatus:'waiting'}));
    }
  }
  if (url.pathname === '/downloads') return reply({jobs:fixture.jobs});
  const selection = /^\/downloads\/([^/]+)\/selection$/.exec(url.pathname);
  if (selection) { const job=fixture.jobs.find(job=>job.id===selection[1]);job.downloadFileIndexes=body.fileIndexes;return reply({job}); }
  const selected = /^\/downloads\/([^/]+)\/select$/.exec(url.pathname);
  if (selected) { const job=fixture.jobs.find(job=>job.id===selected[1]);job.files.forEach(file=>file.selected=file.index===body.fileIndex);return reply({job}); }
  if (url.pathname === '/media-priority') {
    for (const selection of body.selections||[]) { const job=fixture.jobs.find(job=>job.id===selection.jobId);if(job)job.downloadFileIndexes=selection.fileIndexes; }
    return reply({ok:true,targets:body.targets||[]});
  }
  return reply({ok:true,jobs:fixture.jobs});
};
