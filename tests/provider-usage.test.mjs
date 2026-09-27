import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderUsage, chatStream } from '../server/provider.js';
const native = { prompt_tokens:400, completion_tokens:40, total_tokens:1013,
  completion_tokens_details:{reasoning_tokens:573}, extra_properties:{google:{traffic_type:'ON_DEMAND'}} };
const gateway='https://api.ppq.ai';
test('PPQ native Gemini usage agrees with its observed 613-token history debit', () => {
  const u=normalizeProviderUsage(native,gateway,'google/gemini-3.7-flash');
  assert.equal(u.completion_tokens,613); assert.equal(u.total_tokens,1013);
  assert.equal(u.completion_tokens_details.reasoning_tokens,573);
  assert.equal(native.completion_tokens,40,'do not alter raw evidence');
  assert.deepEqual(normalizeProviderUsage(u,gateway,'gemini-3.7-flash'),u,'idempotent');
});
test('inclusive, ambiguous, other-provider and malformed usage cannot be inflated', () => {
  for(const u of [ {...native,completion_tokens:613,total_tokens:1013},
    {...native,completion_tokens_details:{reasoning_tokens:10}},
    {...native,total_tokens:440}, {...native,extra_properties:undefined},
    {...native,completion_tokens_details:{reasoning_tokens:-1}},
    {...native,completion_tokens_details:{reasoning_tokens:Infinity}},
    {...native,prompt_tokens:Number.MAX_SAFE_INTEGER,total_tokens:Number.MAX_SAFE_INTEGER}, null ]) {
    assert.equal(normalizeProviderUsage(u,gateway,'gemini-3.7-flash'),u);
  }
  assert.equal(normalizeProviderUsage(native,'https://openrouter.ai','google/gemini-3.7-flash'),native);
  assert.equal(normalizeProviderUsage(native,'https://api.ppq.ai.evil.example','google/gemini-3.7-flash'),native);
  assert.equal(normalizeProviderUsage(native,gateway,'openai/gpt-5'),native);
});
test('all chatStream consumers receive corrected PPQ usage without changing reported cost', async t => {
  t.mock.method(globalThis,'fetch',async()=>new Response('data: '+JSON.stringify({choices:[],usage:native,cost:0.001299375})+'\n\ndata: [DONE]\n\n'));
  const parts=[]; for await(const p of chatStream({gateway,gatewayKey:'fixture'},{model:'google/gemini-3.7-flash',messages:[]},new AbortController().signal))parts.push(p);
  assert.equal(parts[0].usage.completion_tokens,613); assert.equal(parts[0].cost,0.001299375);
});
