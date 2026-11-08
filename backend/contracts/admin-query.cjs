'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const source=ts.createSourceFile('admin.ts',fs.readFileSync('src/server/routes/admin.ts','utf8'),ts.ScriptTarget.Latest,true);
function find(n,p){if(p(n))return n;let result;ts.forEachChild(n,c=>{result ||= find(c,p)});return result}
const route=path=>find(source,n=>ts.isCallExpression(n)&&n.expression.getText(source)==='router.get'&&n.arguments[0]?.text===path);
const expr=(node,name)=>find(node,n=>ts.isVariableDeclaration(n)&&n.name.getText(source)===name).initializer.getText(source);
const ranges=expr(source,'RANGE_MINUTES');const metrics=route('/queues/metrics'),errors=route('/errors');
const queueSelect=new Function('req',`const RANGE_MINUTES=${ranges};const queueName=${expr(metrics,'queueName')};if(!['download','remove','cache'].includes(queueName))return {error:'queue_not_found'};const range=${expr(metrics,'range')};const minutes=${expr(metrics,'minutes')};return {queue:queueName,range,minutes:typeof minutes==='number'?minutes:0};`);
const logger=ts.createSourceFile('logger.ts',fs.readFileSync('src/core/logger.ts','utf8'),ts.ScriptTarget.Latest,true);
const max=find(logger,n=>ts.isVariableDeclaration(n)&&n.name.getText(logger)==='ERROR_LOG_MAX').initializer.getText(logger);
const errorSelect=new Function('req',`const ERROR_LOG_MAX=${max};const offset=${expr(errors,'offset')};const limit=${expr(errors,'limit')};return {offset:Math.min(Number.MAX_SAFE_INTEGER,offset),limit};`);
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const input={queue:['','queue[]=cache','queue[]=','queue=cache&queue=remove','queue[x]=cache','queue=unknown&range[toString]=x','range[]=','range[]=24h','range[1]=7d&range[0]=1h','range[x]=24h','range[toString]=x','queue[toString]=x',...['toString','constructor','__proto__','hasOwnProperty','valueOf','toLocaleString'].map(x=>'range='+x)],errors:['','offset[]=2&limit[]=7','offset[1]=2&offset[0]=7','offset[x]=3','limit[x]=3','offset=&offset=2&limit=7&limit=9','offset[]=&limit[]=','offset[toString]=3','limit[toString]=3','offset=-2&limit=-2','offset=0x10&limit=0x10']};
const output={};for(const [kind,queries] of Object.entries(input))output[kind]=queries.map(query=>{try{return{query,...(kind==='queue'?queueSelect:errorSelect)({query:parse(query)})}}catch{return{query,error:'invalid_query_value'}}});
const file='backend/internal/server/testdata/admin-query.json',text=JSON.stringify(output,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),text);else fs.writeFileSync(file,text);console.log(`${output.queue.length+output.errors.length} TypeScript admin query contracts verified`);
