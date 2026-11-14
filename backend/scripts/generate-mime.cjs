// Run from repository root after npm ci. Update the vendored MIT notice when updating mime-db.
const fs=require('node:fs');
const mime=require('mime-types');
const result={};
for(const [ext,type] of Object.entries(mime.types).sort()) result[ext]=mime.contentType(type)||type;
fs.writeFileSync('backend/internal/filetype/mime.json',JSON.stringify(result));
fs.copyFileSync('node_modules/mime-db/LICENSE','backend/internal/filetype/LICENSE.mime-db');
fs.copyFileSync('node_modules/isbinaryfile/LICENSE.txt','backend/internal/filetype/LICENSE.isbinaryfile');
