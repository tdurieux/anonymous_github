// Exercise the actual public TypeScript route, including its early HEAD return.
const fs=require('node:fs'),vm=require('node:vm'),http=require('node:http'),assert=require('node:assert/strict'),ts=require('typescript'),express=require('express');
require('ts-node/register/transpile-only');
const {isTextFile}=require('../../src/core/anonymize-utils');
const config={MAX_FILE_SIZE:100*1024*1024,SHARED_CACHE_ENABLED:false};
let current, transfers=0;
class File {
 constructor(){}
 async assertContentFile(){}
 async originalPath(){return current.name}
 isFileSupported(){return true}
 async sha(){return 'blob'}
 async size(){return 10}
 async send(){transfers++;throw Error('unexpected source read')}
}
const fixture={exports:{}};
const dependencies={express,'../../core/AnonymizedFile':{default:File},'../../core/AnonymousError':{default:Error},'./route-utils':{getRepo:async()=>({model:{source:{commit:'revision'},options:{}},isReady:async()=>true,countView:async()=>{throw Error('unexpected view')}}),handleError(error){throw error}},'./file-etag':{fileETag:()=> '"f-fixture"'},'../../config':{default:config},'mime-types':require('mime-types'),'../../core/anonymize-utils':{isTextFile}};
const code=ts.transpileModule(fs.readFileSync('src/server/routes/file.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(code,{exports:fixture.exports,module:fixture,require:n=>{assert.ok(dependencies[n],n);return dependencies[n]},URL});
const cases=[];
for(const name of ['data.txt','script.ts','script.TS','LICENSE','Dockerfile','data.jsonl','unknown.mystery','page.shtml','drawing.svgz','schema.xsd','page.xhtml','style.xsl','mail.mhtml','mail.mht','mail.eml'])for(const shared of [false,true])for(const mode of ['head','reject-encoding','fresh'])cases.push({name,shared,mode,query:''});
for(const query of ['?download=','?download=0','?download=1','?download=&download=','?download[]=','?download[x]=','?download[]=0','?download[0]=','?download=0&download[]=1'])cases.push({name:'page.shtml',shared:true,mode:'head',query});
for(const name of ['résumé.pdf','研究.txt','😀.txt','a%20b.txt','a%2Gb.txt','a"b.txt','report with spaces.txt','unknown.mystery'])for(const mode of ['head','fresh'])cases.push({name,shared:true,mode,query:'?download=1'});
(async()=>{
 const app=express();app.set('query parser','extended');app.use('/api/repo',fixture.exports.default);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(const c of cases){current=c;config.SHARED_CACHE_ENABLED=c.shared;
  c.expected=await new Promise((resolve,reject)=>{
   const headers={'accept-encoding':c.mode==='reject-encoding'?'*;q=0':'gzip'};
   if(c.mode==='fresh')headers['if-none-match']='W/"f-fixture"';
   http.request({host:'127.0.0.1',port:server.address().port,path:'/api/repo/fixture/file/'+encodeURIComponent(c.name)+c.query,method:c.mode==='fresh'?'GET':'HEAD',headers},res=>{
    let bytes=0;res.on('data',b=>bytes+=b.length);res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type']||'',encoding:res.headers['content-encoding']||'',length:res.headers['content-length']||'',ranges:res.headers['accept-ranges']||'',vary:res.headers.vary||'',csp:res.headers['content-security-policy']||'',control:res.headers['cache-control']||'',nosniff:res.headers['x-content-type-options']||'',weak:res.headers.etag.startsWith('W/'),attachment:!!res.headers['content-disposition'],disposition:res.headers['content-disposition']||'',bytes}));
   }).on('error',reject).end();
  });
 }}finally{await new Promise(r=>server.close(r));}
 assert.equal(transfers,0);
 const target='backend/internal/server/testdata/file-metadata.json',data=JSON.stringify(cases,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),data);else fs.writeFileSync(target,data);
 console.log(`${cases.length} TypeScript file metadata contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(e=>{console.error(e);process.exitCode=1});
