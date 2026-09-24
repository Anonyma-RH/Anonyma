#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const name='Anonyma Contributors',email='contributors@example.invalid';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:64*1024*1024}).trim();
const trailers=/^(?:Co-authored-by|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Mentored-by|Helped-by|Requested-by|Approved-by|Cc):/im;
const mode=process.argv[2]||'history';
if(mode==='staged'){
 for(const role of ['AUTHOR','COMMITTER'])if(!git('var',`GIT_${role}_IDENT`).startsWith(`${name} <${email}> `))throw Error(`Incorrect ${role} identity; run npm run identity:setup`);
}else if(mode==='message'){
 if(trailers.test(readFileSync(process.argv[3],'utf8')))throw Error('Remove identity-bearing commit trailers');
}else if(mode==='history'){
 const refs=process.argv.slice(3);const ids=git('rev-list',...(refs.length?refs:['--all'])).split('\n').filter(Boolean);
 for(const id of ids){
  const fields=git('show','-s','--format=%an%x00%ae%x00%cn%x00%ce',id);
  if(fields!==[name,email,name,email].join('\0'))throw Error('Identity mismatch in '+id);
  if(trailers.test(git('show','-s','--format=%B',id)))throw Error('Identity trailer in '+id);
 }
 console.log(`Identity verified across ${ids.length} commits.`);
}else throw Error('Expected staged, message or history');
