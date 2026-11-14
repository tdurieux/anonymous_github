// Extract the actual TS validator declarations with its parser, not a copied oracle.
const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');const ts=require('typescript');
class AnonymousError extends Error{constructor(message,options){super(message);this.httpStatus=options?.httpStatus}}
const specifications=[['repo','repository','validateNewRepo','repoId'],['gist','gist','validateNewGist','gistId'],['pr','pullRequest','validateNewPullRequest','pullRequestId']];
process.env.SESSION_SECRET ||= 'synthetic-validation';require('ts-node/register/transpile-only');
const {normalizePreserveFiles}=require('../../src/core/preserve-files');
const cases=[];
for(const [kind,file,name,id] of specifications){
 const path=`src/server/routes/${file}-private.ts`;const text=fs.readFileSync(path,'utf8');const tree=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
 const declaration=tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);assert.ok(declaration,name);
 const code=ts.transpileModule(`${declaration.getText(tree)};module.exports=${name}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};vm.runInNewContext(code,{module,AnonymousError,normalizePreserveFiles});const validate=module.exports;
 const base={[id]:'example',source:{branch:'main',commit:'abc123',gistId:'snippet',repositoryFullName:'owner/repo',pullRequestId:42},options:{},terms:[]};
 const add=(name,change)=>{const body=structuredClone(base);change(body);let expected=null;try{validate(body)}catch(e){assert.ok(e instanceof AnonymousError,`${kind}/${name}: unexpected TS runtime exception`);expected={code:e.message,status:e.httpStatus}}cases.push({name:`${kind}/${name}`,kind,body,expected})};
 add('valid',()=>{});
 for(const value of ['', 'ab','bad/name','a b','ééé','a'.repeat(180)])add(`id/${JSON.stringify(value)}`,b=>b[id]=value);
 const fields=kind==='repo'?['branch','commit']:kind==='gist'?['gistId']:['repositoryFullName','pullRequestId'];
 for(const field of fields)for(const value of [null,'',false,0])add(`source/${field}/${JSON.stringify(value)}`,b=>b.source[field]=value);
 for(const value of [null,false,'',0])add(`options/${JSON.stringify(value)}`,b=>b.options=value);
 for(const value of [null,'terms',{},42])add(`terms/${JSON.stringify(value)}`,b=>b.terms=value);
 add('precedence/source-options-terms',b=>{b.source={};b.options=null;b.terms=null});
 add('precedence/options-terms',b=>{b.options=null;b.terms=null});
 if(kind==='repo'){add('missing-source',b=>delete b.source);for(const v of ['xyz','a-b','abc\n','123'])add(`commit/${JSON.stringify(v)}`,b=>b.source.commit=v);add('precedence/terms-commit',b=>{b.terms=null;b.source.commit='xyz'})}
 if(kind==='gist')add('missing-source',b=>delete b.source);
 if(kind==='pr')for(const v of [1.5,1e20,1e21,-1e21,'1.0','1e3',' 42 ','42abc','0x10',true,'0',-1])add(`number/${JSON.stringify(v)}`,b=>b.source.pullRequestId=v);
}
const target='backend/internal/server/testdata/validation.json';const output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TS validation contract changed');else fs.writeFileSync(target,output);
console.log(`${cases.length} TypeScript validation contracts ${process.argv.includes('--check')?'verified':'generated'}`);
