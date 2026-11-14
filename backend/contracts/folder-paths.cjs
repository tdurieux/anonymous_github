'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path').posix;
const paths=['','alice','alice/','alice//','a//b/','/','//','///','./alice/','a/../b','//a/b','a///b//','a\\b','日本語/é/',' a / b ','/root/leaf','../x','a/./b'];
const cases=paths.map(requested=>{let directory=path.dirname(requested);if(directory==='.')directory='';if(directory.endsWith('/'))directory=directory.slice(0,-1);return {requested,directory,name:path.basename(requested)}});
const file='backend/internal/server/testdata/folder-paths.json',output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
console.log(cases.length+' Node POSIX folder path contracts verified');
