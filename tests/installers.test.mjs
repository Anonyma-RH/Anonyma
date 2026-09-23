import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { cliDownload, shellInstaller, powershellInstaller } from '../server/installers.js';
const run = promisify(execFile);

if (process.platform !== 'win32') test('downloaded CLI connects to its installation without an explicit base URL; shell installation preserves arguments and failed downloads', async t => {
 const root = mkdtempSync(join(tmpdir(), 'anonyma-cli-install-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 let cfg, failure=false, body;
 const server=createServer(async(req,res)=>{
  if(req.url==='/cli.mjs') {res.writeHead(failure?503:200);res.end(failure?'Unavailable':cliDownload(cfg));return;}
  if(req.url==='/v1/chat/completions') {
   let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw);
   assert.equal(req.headers.authorization,'Bearer isolated-cli-key');
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.end('data: '+JSON.stringify({choices:[{delta:{content:'Installed CLI works'}}]})+'\n\ndata: '+JSON.stringify({choices:[],anonyma:{credits_charged:0.1}})+'\n\ndata: [DONE]\n\n');return;
  }
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 cfg={origin:`http://127.0.0.1:${server.address().port}`};
 const script=join(root,'install.sh');writeFileSync(script,shellInstaller(cfg));
 const env={...process.env,ANONYMA_INSTALL_DIR:join(root,'bin with spaces'),ANONYMA_CONFIG_DIR:join(root,'config'),ANONYMA_API_KEY:'isolated-cli-key'};
 delete env.ANONYMA_BASE_URL;
 await run('/bin/sh',[script],{env});
 const executable=join(env.ANONYMA_INSTALL_DIR,'anonyma');
 assert.equal(statSync(executable).mode&0o777,0o700);
 const answer=await run(executable,['An argument with spaces and "quotes"'],{env});
 assert.match(answer.stdout,/Installed CLI works/);
 assert.equal(body.messages.at(-1).content,'An argument with spaces and "quotes"');
 const previous=readFileSync(join(env.ANONYMA_INSTALL_DIR,'anonyma.mjs'),'utf8');
 failure=true;await assert.rejects(run('/bin/sh',[script],{env}));
 assert.equal(readFileSync(join(env.ANONYMA_INSTALL_DIR,'anonyma.mjs'),'utf8'),previous);
});

if (process.platform === "win32")
  test("PowerShell installation connects to its origin, preserves arguments, and survives an invalid update", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "anonyma windows install "));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let cfg,
      failure = "",
      body;
    const server = createServer(async (req, res) => {
      if (req.url === "/cli.mjs") {
        res.writeHead(failure === "http" ? 503 : 200, {
          "content-type": "text/javascript",
        });
        res.end(
          failure === "invalid"
            ? "this is not JavaScript!"
            : failure === "http"
              ? "Unavailable"
              : cliDownload(cfg),
        );
        return;
      }
      if (req.url === "/v1/chat/completions") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        body = JSON.parse(raw);
        assert.equal(req.headers.authorization, "Bearer isolated-windows-key");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { content: "Windows CLI works" } }],
            }) +
            "\n\ndata: " +
            JSON.stringify({ choices: [], anonyma: { credits_charged: 0.1 } }) +
            "\n\ndata: [DONE]\n\n",
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => server.close(r)));
    cfg = { origin: `http://127.0.0.1:${server.address().port}` };
    const script = join(root, "install.ps1");
    writeFileSync(script, powershellInstaller(cfg));
    const env = {
      ...process.env,
      LOCALAPPDATA: join(root, "Local App Data"),
      ANONYMA_CONFIG_DIR: join(root, "config"),
      ANONYMA_API_KEY: "isolated-windows-key",
    };
    delete env.ANONYMA_BASE_URL;
    const install = () =>
      run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
        ],
        { env },
      );
    await install();
    const dir = join(env.LOCALAPPDATA, "Anonyma");
    const installed = join(dir, "anonyma.mjs");
    const wrapper = join(dir, "anonyma.cmd");
    assert.ok(statSync(installed).size > 0);
    assert.ok(statSync(wrapper).size > 0);
    // Node escapes quotes for most Windows programs, but cmd.exe parses its
    // own command line, so the quoting below must reach it unchanged.
    const answer = await run(
      "cmd.exe",
      ["/d", "/s", "/c", `""${wrapper}" "An argument with spaces""`],
      { env, windowsVerbatimArguments: true },
    );
    assert.match(answer.stdout, /Windows CLI works/);
    assert.equal(body.messages.at(-1).content, "An argument with spaces");
    const previous = readFileSync(installed, "utf8");
    failure = "http";
    await assert.rejects(install());
    assert.equal(readFileSync(installed, "utf8"), previous);
    failure = "invalid";
    await assert.rejects(install());
    assert.equal(readFileSync(installed, "utf8"), previous);
  });

test('installer origins exclude embedded credentials and generated PowerShell stops before replacing invalid downloads',()=>{
 assert.throws(()=>shellInstaller({origin:Object.assign(new URL('https://example.invalid'), { username: 'user', password: 'secret' }).href}));
 assert.throws(()=>cliDownload({origin:'file:///tmp/app'}));
 const script=powershellInstaller({origin:'https://anonyma.example.invalid'});
 assert.match(script,/https:\/\/anonyma.example.invalid\/cli.mjs/);
 assert.match(script,/\$ErrorActionPreference = 'Stop'/);
 assert.ok(script.indexOf('node --check')<script.indexOf('Move-Item'));
});
