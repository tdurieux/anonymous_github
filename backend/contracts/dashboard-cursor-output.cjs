const fs=require('node:fs'),assert=require('node:assert/strict'),{Types}=require('mongoose');
const source=fs.readFileSync('src/server/routes/dashboard-summary.ts','utf8');
const expression=source.match(/const cursor = hasMore \? ([\s\S]*?) : null;/)[1];
const encode=new Function('query','last',`return ${expression}`);
const values=['plain','<>&','"\\\n\t','é😀','\u2028\u2029','\\u2028','\\\\u2029','\\\u2028',0,-0,1,-1,1e-7,1e-6,1e20,1e21,1.23456789,null,true,false];
const id='abcdefabcdefabcdefabcdef';
const cases=values.map(value=>({sort:'_label',value,type:'repo',id,expected:encode({sort:'_label'},{_sort:value,_type:'repo',_id:new Types.ObjectId(id)})}));
for(const value of [0,1,-1,1700000000123,-62135596800000,253402300800000])cases.push({sort:'-anonymizeDate',value,date:true,type:'pr',id,expected:encode({sort:'-anonymizeDate'},{_sort:new Date(value),_type:'pr',_id:new Types.ObjectId(id)})});
for(const [index,value] of ['cursor-a','cursor-b'].entries()){const id='eeddcc00000000000000000'+(index+1);cases.push({sort:'_name',value,type:'repo',id,http:true,expected:encode({sort:'_name'},{_sort:value,_type:'repo',_id:new Types.ObjectId(id)})});}
const path='backend/internal/server/testdata/dashboard-cursor-output.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);console.log(`${cases.length} exact TypeScript cursor encodings verified`);
