import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addCredit, balance } from "../server/core.js";
import { createModels } from "../server/models.js";
import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import { buildChatRequest, quoteBody, cloneVeilState } from "../src/estimate.js";
import { requestNeedsVision, resolveChoice } from "../src/model-finder.js";
import { createVeilState } from "../src/veil.js";
import { messageFromServer } from "../src/lib.js";
import { completionNotice, CONTINUE_PROMPT, replyBudgetFor, replyBudgets } from "../src/long-answers.js";

const MODEL = "google/gemini-2.5-flash";
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-long-answers-"));
  const s = createApp({ testMode: true, released: "all", dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"), catalogPath: join(dir, "models.json"), origin: "http://localhost:5175", ...extra });
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return s;
}
async function person(s) {
  const agent = request.agent(s.app);
  const r = await agent.post("/api/auth/register").send({username:"longanswers",password:"test-password-long"}).expect(201);
  addCredit(s.db,r.body.user.id,1e9,"local-fixture-fund");
  return {agent,user:r.body.user};
}
async function gateway(t, handler) {
  const server = createServer(async(req,res) => {
    let raw=""; for await (const part of req) raw+=part;
    await handler(JSON.parse(raw || "{}"),res);
  });
  await new Promise(r => server.listen(0,"127.0.0.1",r));
  t.after(() => {server.closeAllConnections();server.close();});
  return `http://127.0.0.1:${server.address().port}`;
}
const event = (res,x) => res.write(`data: ${JSON.stringify(x)}\n\n`);

test("published output caps constrain each model; unknown models do not inherit alias capacities", () => {
  assert.equal(chatLimits({id:MODEL,context_length:1048576}).maxOutputTokens,32768);
  assert.equal(chatLimits({id:MODEL,context_length:1048576,top_provider:{max_completion_tokens:2048}}).maxOutputTokens,2048);
  assert.equal(chatLimits({id:"~google/gemini-latest",context_length:1e6}).maxOutputTokens,8192);
  assert.equal(chatLimits({id:"unknown",max_output_tokens:-1}).outputLimitKnown,false);
  const model={id:"small",type:"chat",context_length:4096,max_output_tokens:1024};
  const models=createModels({released:"all",catalogPath:"/nonexistent"});
  assert.throws(()=>models.maxTokens(2048,model),e=>e.code==="output_limit_exceeded");
  assert.throws(()=>models.validateContext([{role:"user",content:"x".repeat(3600)}],model,1024),e=>e.code==="context_limit_exceeded");
  assert.equal(replyBudgetFor({chatLimits:chatLimits(model)},32768),1024);
});

test("a nonstandard selected budget stays visible when switching models", () => {
  const small = {chatLimits: {maxOutputTokens: 6000}}, large = {chatLimits: {maxOutputTokens: 32768}};
  const selected = replyBudgetFor(small, 8192);
  assert.equal(selected, 6000);
  assert.equal(replyBudgetFor(large, selected), selected);
  assert.ok(replyBudgets(large, selected).includes(selected));
  assert.ok(replyBudgets(small, replyBudgetFor(small,32768)).includes(6000));
  assert.ok(replyBudgets(small, 32768).every(n=>n<=6000));
});

test("failover refuses history that exceeds the backup context before any backup generation", async t => {
  for (const context of [4096, undefined]) {
    let backupCalls = 0;
    const primary = await gateway(t, (_,res)=>{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture primary refusal'}}));});
    const backup = await gateway(t, (body,res)=>{
      if(!body.model){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:MODEL,context_length:context,max_output_tokens:2048}]}));return;}
      backupCalls++;
      event(res,{choices:[{delta:{content:'Must not run'}}]});res.end('data: [DONE]\n\n');
    });
    const s=fixture(t,{testMode:false,gateway:primary,gatewayKey:'fixture',gateway2:backup,gateway2Key:'fixture'}),{agent,user}=await person(s);
    const before=balance(s.db,user.id);
    const body={model:MODEL,messages:[{role:'user',content:'x'.repeat(context ? 5000 : 33000)}],max_tokens:1024,requestId:'backup-context'};
    await agent.post('/api/quote').send(body).expect(200);
    const failed = await agent.post('/api/chat').send(body).expect(200);
    assert.match(failed.text, /"code":"provider_down"/);
    assert.equal(backupCalls,0);
    assert.deepEqual(balance(s.db,user.id),before);
  }
});

test("extended history preserves standing instructions and every turn, including Veil on quote and send", () => {
  const history=Array.from({length:38},(_,i)=>({role:i%2?"assistant":"user",content:`Turn ${i} for alice@example.invalid`}));
  const state=createVeilState();
  const args={messages:history,text:CONTINUE_PROMPT,instructions:"Keep the exact plan",preserveHistory:true};
  const q=buildChatRequest({...args,veilWith:{state:cloneVeilState(state),words:[]}});
  const send=buildChatRequest({...args,veilWith:{state,words:[]}});
  assert.equal(send.request.length,40); assert.equal(send.request[0].role,"system");
  assert.deepEqual(send.request,q.request);assert.doesNotMatch(JSON.stringify(q.request),/alice@example/);
  assert.match(send.request[1].content,/Turn 0/);
  const models=createModels({released:"all",catalogPath:"/nonexistent"});
  assert.equal(models.validateMessages(send.request,{id:MODEL}).length,40);
  assert.throws(()=>models.validateMessages(Array.from({length:201},()=>({role:"user",content:"hi"})),{}),e=>e.code==="context_limit_exceeded");
  assert.ok(contextEstimate([{role:"user",content:"汉字"}])>2);
});

test("32k quote matches the transmitted budget and reservation; over-limit requests never reach the provider", async t => {
  const received=[];
  const url=await gateway(t,(body,res)=>{received.push(body);event(res,{choices:[{delta:{content:"Done"},finish_reason:"stop"}]});event(res,{usage:{prompt_tokens:10,completion_tokens:1}});res.end("data: [DONE]\n\n");});
  const s=fixture(t,{testMode:false,gateway:url,gatewayKey:"fixture"}),{agent,user}=await person(s);
  const body=quoteBody({model:MODEL,request:[{role:"system",content:"Keep this."},...Array.from({length:24},()=>({role:"user",content:"Continue the plan"}))],maxTokens:32768});
  const q=(await agent.post("/api/quote").send(body).expect(200)).body;
  assert.equal(q.budget.replyBudget,32768);
  await agent.post("/api/chat").send({...body,requestId:"long-test"}).expect(200);
  assert.equal(received.length,1);assert.equal(received[0].max_tokens,32768);assert.equal(received[0].messages.length,25);
  const h=s.db.prepare("SELECT * FROM holds WHERE id=?").get(user.id+":long-test");
  assert.equal(h.amount,Math.ceil(q.credits*10000*s.cfg.holdMargin));
  const before=balance(s.db,user.id);
  for(const path of ["/api/quote","/api/chat"]){
    assert.equal((await agent.post(path).send({...body,max_tokens:32769}).expect(400)).body.error.code,"output_limit_exceeded");
    await agent.post(path).send({...body,messages:Array.from({length:201},()=>({role:"user",content:"hi"}))}).expect(400);
  }
  assert.deepEqual(balance(s.db,user.id),before);assert.equal(received.length,1);
  await agent.post("/api/chat").send({...body,requestId:"long-test"}).expect(409);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE ref=?").get(user.id+":long-test").n,1);
});

test("length termination survives API responses, saved history and receipts without auto continuation", async t => {
  let calls=0;
  const url=await gateway(t,(_,res)=>{calls++;event(res,{choices:[{delta:{reasoning:"Thinking",content:"A partial chapter"},finish_reason:"length"}]});res.end("data: [DONE]\n\n");});
  const s=fixture(t,{testMode:false,gateway:url,gatewayKey:"fixture"}),{agent}=await person(s);
  const body={model:MODEL,messages:[{role:"user",content:"Write a chapter"}],max_tokens:8192};
  const r=await agent.post("/api/chat").send({...body,requestId:"length"}).expect(200);
  assert.match(r.text,/"finish_reason":"length"/);
  const saved=JSON.parse(s.db.prepare("SELECT content FROM messages WHERE role='assistant'").get().content);
  assert.equal(saved.finish_reason,"length");assert.equal(saved.reasoning,"Thinking");
  assert.match(completionNotice(messageFromServer({content:saved})),/reply limit/);
  const recovery=(await agent.get("/api/requests/length").expect(200)).body;
  assert.equal(recovery.receipt.finish_reason,"length");assert.equal(calls,1);
  const key=(await agent.post("/api/keys").send({name:"local"}).expect(201)).body.key;
  const api=await request(s.app).post("/v1/chat/completions").set("Authorization","Bearer "+key).send(body).expect(200);
  assert.equal(api.body.choices[0].finish_reason,"length");assert.equal(calls,2);
});

test("timeouts and broken streams keep partial output exactly once; off-record requests store no content", async t => {
  for(const failure of ["timeout","broken"]){
    const url=await gateway(t,(_,res)=>{event(res,{choices:[{delta:{content:"Keep this partial answer",reasoning:"And its reasoning"}}]});if(failure==="broken")res.end();});
    const s=fixture(t,{testMode:false,gateway:url,gatewayKey:"fixture",requestTimeoutMs:80,privateModels:[MODEL]}),{agent,user}=await person(s);
    for(const privacy of ["saved","ephemeral","private"]){
      const ephemeral = privacy !== "saved", id=failure+privacy;
      const before=s.db.prepare("SELECT COUNT(*) n FROM messages").get().n;
      const r=await agent.post("/api/chat").send({model:MODEL,messages:[{role:"user",content:"Question"}],max_tokens:8192,requestId:id,...(privacy === "private" ? { private:true } : { ephemeral })}).expect(200);
      assert.match(r.text,failure==="timeout"?/provider_timeout/:/provider_interrupted/);
      const rows=s.db.prepare("SELECT content FROM messages WHERE role='assistant'").all();
      if(!ephemeral){assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].content).text,"Keep this partial answer");assert.equal(JSON.parse(rows[0].content).interrupted,true);}
      else assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n,before);
      assert.equal(balance(s.db,user.id).held,0);
      assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE ref=?").get(user.id+":"+id).n,1);
      await agent.get("/api/requests/"+id).expect(200);
    }
  }
});


test("Finder vision eligibility and redo retain the same extended image history as Send", () => {
  const history = [{ role: "user", content: "Describe this", images: ["data:image/png;base64,AA=="] },
    ...Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "Later turn " + i }))];
  assert.equal(requestNeedsVision(buildChatRequest({ messages: history }).request), false);
  const args = { messages: history, preserveHistory: true, instructions: "Keep context" };
  const eligibility = buildChatRequest(args).request;
  const actual = buildChatRequest({ ...args, text: "Continue" }).request;
  assert.equal(requestNeedsVision(eligibility), true);
  assert.equal(requestNeedsVision(actual), true);
  const models = [
    { id: "text", name: "Text", callable: true, vision: false, pricing: { input_per_1M_tokens: 0, output_per_1M_tokens: 0 } },
    { id: "vision", name: "Vision", callable: true, vision: true, pricing: { input_per_1M_tokens: 1, output_per_1M_tokens: 1 } },
  ];
  const allowed = models.filter(m => !requestNeedsVision(eligibility) || m.vision);
  assert.equal(resolveChoice({ model: "text" }, allowed, models, { mode: "chat", needsVision: true }).model.id, "vision");
  // Regenerating an earlier turn uses its cut context, not the current composer.
  assert.equal(requestNeedsVision(buildChatRequest({ messages: [], preserveHistory: true, text: "New start" }).request), false);
});

test("32k team quote and Send retain treasury ownership and standard rate with discounted members", async t => {
  const received = [];
  const url = await gateway(t, (body, res) => {
    received.push(body);
    event(res, { choices: [{ delta: { content: "Team answer" }, finish_reason: "stop" }] });
    event(res, { usage: { prompt_tokens: 10, completion_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gateway: url, gatewayKey: "fixture" });
  s.cfg.markup = 50;
  const { agent, user } = await person(s);
  const collab = (await agent.post("/api/collabs").send({ name: "Long answer team" }).expect(201)).body.id;
  await agent.post(`/api/collabs/${collab}/treasury/contribute`).send({ credits: 1000, idempotency_key: "fund-long-team" }).expect(201);
  const conversationId = (await agent.post(`/api/collabs/${collab}/conversations`).send({ title: "Team chapter" }).expect(201)).body.id;
  s.db.prepare("UPDATE users SET token_balance=? WHERE id=?").run(40000000, user.id);
  const personalBefore = balance(s.db, user.id);
  const body = quoteBody({ model: MODEL, request: [{ role: "user", content: "Explain this" }], maxTokens: 32768, treasury: true, conversationId });
  const quoted = (await agent.post("/api/quote").send(body).expect(200)).body;
  const personal = (await agent.post("/api/quote").send({ ...body, treasury: false }).expect(200)).body;
  assert.equal(quoted.budget.replyBudget, 32768);
  assert.ok(quoted.credits > personal.credits);
  await agent.post("/api/chat").send({ ...body, requestId: "team-long" }).expect(200);
  assert.equal(received.length, 1);
  assert.equal(received[0].max_tokens, 32768);
  const hold = s.db.prepare("SELECT * FROM holds WHERE id=?").get(user.id + ":team-long");
  const account = s.db.prepare("SELECT account_user_id FROM treasury_accounts WHERE collab_id=?").get(collab).account_user_id;
  assert.equal(hold.user_id, account);
  assert.equal(hold.amount, Math.ceil(quoted.credits * 10000 * s.cfg.holdMargin));
  assert.deepEqual(balance(s.db, user.id), personalBefore);
  assert.equal(balance(s.db, account).held, 0);
});
