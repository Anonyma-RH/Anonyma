#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
if(existsSync('.git')){
 for(const [key,value]of Object.entries({'user.name':'Anonyma Contributors','user.email':'contributors@example.invalid','user.useConfigOnly':'true','commit.gpgsign':'false','tag.gpgsign':'false','core.hooksPath':'.githooks'}))execFileSync('git',['config','--local',key,value]);
 for(const name of ['pre-commit','commit-msg','pre-push'])chmodSync(`.githooks/${name}`,0o755);
 console.log('Anonyma contributor identity and local hooks installed. Global Git settings are unchanged.');
}
