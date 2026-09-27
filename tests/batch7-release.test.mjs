import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { UPDATES } from '../server/releases.js';
test('all ten batch 7 releases are enabled by the production MVP setting',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'anonyma-b7-release-'));
 const svc=createApp({testMode:true,released:'mvp',origin:'http://localhost:5175',dbPath:join(dir,'test.sqlite'),mediaPath:join(dir,'media'),catalogPath:join(dir,'models.json')});
 t.after(()=>{svc.close();rmSync(dir,{recursive:true,force:true});});
 const cfg=(await request(svc.app).get('/api/config').expect(200)).body;
 for(const id of ['python','deadswitch','giftlinks','arena','vaultsync','automodel','canvas','slides','doctranslate','meetingnotes']){
  assert.equal(UPDATES.filter(u=>u.id===id).length,1,id+' registered once');
  assert.equal(UPDATES.find(u=>u.id===id).released,true,id+' committed released');
  assert.equal(cfg.releases.features[id],true,id+' enabled without all override');
 }
});
