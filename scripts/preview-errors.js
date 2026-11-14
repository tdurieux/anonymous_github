// Local synthetic fixtures only. No production proxy or credentials.
// Run: node scripts/preview-errors.js, then /admin/errors?scenario=disabled|offline|empty|stale
const express = require('express');
const fs = require('node:fs');
const { setTimeout } = require('node:timers');
const path = require('node:path');
const app = express();
let historyCleared = false;
const root = path.resolve(__dirname, '../public');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
app.use('/api', async (req, res) => {
  const scenario = new URL(req.headers.referer || 'http://localhost').searchParams.get('scenario');
  if (scenario === 'loading') await new Promise(resolve => setTimeout(resolve, 1500));
  const now = new Date().toISOString(), start = new Date(Date.now()-3600000).toISOString();
  if (req.path === '/user') return res.json({username:'Synthetic preview',isAdmin:true,status:'ready'});
  if (req.path === '/user/default') return res.json({options:{},terms:[]});
  if (req.path === '/admin/emails/summary') return res.json({total:2,counts:{accepted:1,rejected:1,unknown:0,sending:0},chartDays:7,series:[{date:now.slice(0,10),accepted:1,rejected:1,unknown:0,sending:0}]});
  if (req.path === '/admin/emails') return res.json({entries:[{_id:'synthetic-attempt',recipient:'fixture@example.test',kind:'repository-expiration',state:'rejected',createdAt:now,httpStatus:503}],nextCursor:null});
  if (req.path === '/admin/billing/summary') return res.json({period:'30d',bucket:'day',subscriptions:{active:3,monthly:2,annual:1,cancelling:0,mrr:{eur:1400}},sales:{count:4,revenue:{eur:3000}},allTime:{count:9,revenue:{eur:5000}},reversals:{refunds:0,disputes:0,amount:{}},plans:[],series:[{date:now,subscription:1,repository:2,conference:1}],revenue:{available:true,missingSales:0},webhooks:{pending:0,failed:0}});
  if (req.path === '/admin/billing/grants') return res.json({results:[],total:0,stateCounts:{active:0,expired:0,revoked:0},statuses:[]});
  if (scenario === 'offline' && req.path.startsWith('/admin/errors')) return res.status(503).json({});
  let samples = [
    {service:'worker',module:'queue',event:'job_failed',errorCode:'upstream_error',severity:'error',status:502,jobId:id,requestId:id},
    {service:'nginx',module:'proxy',event:'edge_request',severity:'info',status:504,requestId:id},
    {service:'streamer',module:'download',event:'request_aborted',severity:'warn',requestId:id},
    {service:'api',module:'route',event:'request_failed',errorCode:'repository_unavailable',severity:'error',status:503,requestId:id},
  ];
  if (scenario === 'diagnostics') samples = [{service:'api',module:'route',event:'application_log',severity:'error',httpStatus:500,requestId:id,method:'GET',route:'/api/repo/:repoId/file/:path',errorType:'TypeError',errorStack:'at printError (build/server/routes/route-utils.js:200:7)\nat <anonymous> (build/server/routes/repository-public.js:312:11)',causeType:'RangeError',causeStack:'at <anonymous> (build/core/repository.js:410:9)'},{service:'api',module:'requests',event:'request_completed',severity:'info',status:500,requestId:id,method:'GET',route:'/api/repo/:repoId/file/:path',ms:283}];
  if (scenario === 'occurrences') samples = Array.from({length:50}, (_,i) => ({service:'api',module:'route',event:'application_log',severity:'error',httpStatus:500,requestId:id,...(i%2?{method:'GET',route:'/api/repo/:repoId/file/:path'}:{})}));
  if (scenario === 'many') samples = Array.from({length:50}, (_,i) => ({...samples[i%4],errorCode:'synthetic_event_'+(i+1)}));
  if (req.path === '/admin/errors/investigation') return res.json({state:scenario === 'unreachable' ? 'unreachable' : scenario === 'disabled' ? 'disabled' : scenario === 'empty' ? 'empty':'ready',window:req.query.window||'1h',start,end:scenario==='stale'?start:now,captured:['disabled','unreachable','empty'].includes(scenario)?0:samples.reduce((sum,_,i)=>sum+[18,9,5,2][i%4],0),groups:['disabled','unreachable','empty'].includes(scenario)?[]:samples.map((sample,i)=>({fingerprint:String(i),sample:{...sample,release:'abcdef1234567'},count:[18,9,5,2][i%4],first:start,last:now})),telemetry:{missing:[],instances:[{service:'api',instance:'synthetic-api',last:now,dropped:0}],collector:{state:'reachable',dropped:0}}});
  if (req.path === '/admin/errors/correlation') return res.json({state:'ready',start,end:now,events:samples.map(sample=>({...sample,timestamp:now}))});
  if (req.path === '/admin/errors/stats') return res.json({available:true,last24h:34,prev24h:20,severity:{error:29,warn:5,info:0},unique:{error:3,warn:1,info:0},buckets:[],dropped:0});
  if (req.path === '/admin/errors' && req.method === 'DELETE') historyCleared = true;
  if (req.path === '/admin/errors') return res.json({available:true,redisCollecting:true,total:historyCleared?0:samples.length,max:1000,entries:historyCleared?[]:samples.map((sample,i)=>({ts:scenario==='occurrences'?new Date(Date.now()-i*11000).toISOString():now,level:sample.severity,module:sample.module,message:sample.errorCode||sample.errorType||sample.event,count:i+1,raw:[sample]}))});
  return res.json([]);
});
app.use((req,res,next)=>{ req.url=req.url.replace(/\.[a-f0-9]{10}\.min\./,'.min.'); next(); });
app.use(express.static(root,{index:false}));
app.get('/{*path}', (req,res)=>res.type('html').send(fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/__([A-Z]+)_JS__/g,(_,name)=>`${name.toLowerCase()}.min.js`).replace('__ALL_CSS__','all.min.css').replace('<body ', '<body data-synthetic-preview="true" ').replace('<div id="app"', '<div style="padding:6px 16px;background:#fff3cd;color:#493800;text-align:center;font:13px sans-serif">Synthetic preview · generated fixtures only · no production connection</div><div id="app"')));
app.listen(4173,'0.0.0.0',()=>console.log('Synthetic Errors preview: http://localhost:4173/admin/errors'));
