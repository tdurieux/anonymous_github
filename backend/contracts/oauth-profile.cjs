const fs=require('node:fs');const assert=require('node:assert/strict');
const source=fs.readFileSync('src/server/routes/github-app.ts','utf8');
const predicate=source.match(/if \((!Number\.isSafeInteger\(profile\.id\).*?)\) throw appError\(\);/)[1];
const rejected=new Function('profile',`return ${predicate}`);
const cases=[];
for(const id of [undefined,null,false,true,'42','',[],{},0,-1,1,1.5,-1.5,9007199254740991,-9007199254740991,9007199254740992,1e30]) {
 const profile={login:'synthetic-login'};if(id!==undefined)profile.id=id;
 cases.push({name:`id-${cases.length}`,profile,rejected:rejected(profile)});
}
for(const login of [undefined,null,false,true,0,1,'','valid-login',[],{},['login']]) {
 const profile={id:42};if(login!==undefined)profile.login=login;
 cases.push({name:`login-${cases.length}`,profile,rejected:rejected(profile)});
}
const path='backend/internal/server/testdata/oauth-profile.json',output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);
console.log(`${cases.length} TypeScript App profile validation contracts verified`);
