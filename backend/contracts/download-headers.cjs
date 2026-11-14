const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict'),express=require('express');
const names=['report.txt','report with spaces.txt','résumé.pdf','研究.txt','😀.txt','a%20b.txt','a%2Gb.txt','a%ab.txt','a%FF.txt','a%.txt','a"b.txt','a\\b.txt','a;b.txt','a\r\nb.txt','a\0b.txt','a\tb.txt','!#$&+-.^_`|~.txt',"quote'paren().txt",'e\u0301.txt','repo-name.zip',''];
for(let i=0;i<256;i++)names.push('a'+String.fromCharCode(i)+'b.txt');
const cases=names.map(name=>({name}));
(async()=>{
 const app=express();app.get('/',(req,res)=>{res.attachment(cases[Number(req.headers['x-fixture'])].name);res.end()});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(let i=0;i<cases.length;i++)cases[i].expected=await new Promise((resolve,reject)=>{
  http.get({host:'127.0.0.1',port:server.address().port,path:'/',headers:{'x-fixture':String(i)}},res=>{res.resume();res.on('end',()=>{assert.equal(res.statusCode,200);resolve(res.headers['content-disposition'])});res.on('error',reject)}).on('error',reject);
 })}finally{await new Promise(r=>server.close(r));}
 const target='backend/internal/server/testdata/download-headers.json',data=JSON.stringify(cases,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),data);else fs.writeFileSync(target,data);
 console.log(`${cases.length} Express download-header contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(e=>{console.error(e);process.exitCode=1});
