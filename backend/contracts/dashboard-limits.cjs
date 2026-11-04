const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('src/server/routes/dashboard-summary.ts','utf8');
const expressions=[...source.matchAll(/const limit = (.*);/g)].map(x=>x[1]);assert.equal(expressions.length,2);assert.equal(expressions[0],expressions[1]);
const calculate=new Function('query',`return ${expressions[0]}`);
const values=[[],['1','2'],['',''],['2',''],...['',' ','0','-0','1','-1','2.9','-0.1','0.1','100','101','999999999999999999999999','1e2','1e-2','1e999','-1e999','1e-9999','0x2','0Xff','0x','0xgg','0xfffffffffffffffffffffffffffff','0xffffz','0b10','0B101','0b12','0o10','0O10','0o8','-0x2','+0x2','Infinity','+Infinity','-Infinity','Inf','NaN','true','null','1_0','0x1p2','.5','+.5','1.','01','1e','2suffix','\ufeff2\ufeff','\u00852\u0085','\n2\t'].map(x=>[x])];
const cases=values.map(values=>({values,expected:calculate({limit:values.length===0?undefined:values.length===1?values[0]:values})}));
const path='backend/internal/server/testdata/dashboard-limits.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);console.log(`${cases.length} TypeScript dashboard limit contracts verified`);
