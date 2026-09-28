import test from 'node:test';
import assert from 'node:assert/strict';
import { rankTools } from '../src/tool-search.js';

const entries = [
  ['home', 'Home'], ['uncensored', 'Uncensored'], ['symposium', 'Symposium'],
  ['device', 'On-device'], ['code', 'Code & build'], ['audio', 'Voice & audio'],
  ['collab', 'Collab'], ['tools', 'Task tools'], ['sheets', 'Sheets'],
  ['compare', 'Compare docs'], ['canvas', 'Canvas'], ['translate', 'Translate docs'],
  ['study', 'Study'], ['slides', 'Slides'], ['notes', 'Meeting notes'],
  ['routines', 'Routines'], ['projects', 'Projects'], ['library', 'Your library'],
  ['models', 'Explore models'], ['api', 'Developer API'],
];
const ids = (query, tools = entries, translate) => rankTools(tools, query, translate).map(([id]) => id);

test('search and truth suggest investigation and comparison, not an accuracy guarantee', () => {
  for (const q of ['search', 'truth', 'help me find the truth', 'fact check', 'check facts']) {
    const found = ids(q);
    assert.equal(found[0], 'tools', q);
    assert.ok(found.includes('symposium'), q);
    assert.ok(found.includes('compare'), q);
    assert.ok(!found.includes('uncensored'), q);
  }
});
test('natural requests rank the most relevant destination first', () => {
  for (const [query, expected] of [
    ['compare contracts', 'compare'], ['make a presentation', 'slides'],
    ['offline private chat', 'device'], ['meeting action items', 'notes'],
    ['find saved pictures', 'library'], ['debug my python code', 'code'],
    ['organize my chats in folders', 'projects'], ['learn with flashcards', 'study'],
    ['translate into another language', 'translate'], ['automate a daily report', 'routines'],
    ['excel charts', 'sheets'], ['work together with my team', 'collab'],
    ['read aloud', 'audio'], ['write a first draft', 'canvas'],
    ['API key', 'api'], ['compare model prices', 'models'],
  ]) assert.equal(ids(query)[0], expected, query);
});
test('direct names outrank semantic suggestions; order is deterministic', () => {
  for (const entry of entries) assert.equal(ids(entry[1])[0], entry[0], entry[1]);
  assert.deepEqual(ids('truth'), ids('truth'));
  assert.equal(ids('  SYMPÓSIUM!  ')[0], 'symposium');
});
test('prefixes and small typos work without fuzzy short-word noise', () => {
  assert.equal(ids('presen')[0], 'slides');
  assert.equal(ids('reaserch')[0], 'tools');
  assert.equal(ids('spreedsheet')[0], 'sheets');
  assert.deepEqual(ids('zz'), []);
  assert.ok(!ids('search internet').includes('device'), 'no-internet intent needs the whole phrase');
});
test('Chinese intents and translated labels are searchable', () => {
  assert.equal(ids('寻找真相')[0], 'tools');
  assert.equal(ids('离线聊天')[0], 'device');
  assert.equal(ids('做幻灯片')[0], 'slides');
  assert.equal(ids('开发者接口', entries, s => s === 'Developer API' ? '开发者接口' : s)[0], 'api');
});
test('descriptions are searchable for entries without curated tags', () => {
  assert.deepEqual(ids('constellation', [['custom', 'Sky', 'Explore a constellation.']]), ['custom']);
});
test('empty input preserves order, unknown intent returns none, queries are bounded', () => {
  assert.deepEqual(rankTools(entries, ''), entries);
  assert.deepEqual(rankTools(entries, '   '), entries);
  assert.deepEqual(ids('please help me'), []);
  assert.deepEqual(ids('zzquuxunrelated'), []);
  const long = 'truth '.repeat(10000);
  assert.deepEqual(ids(long), ids(long.slice(0, 256)));
});
test('ranking never adds gated tools or mutates caller entries', () => {
  const supplied = entries.filter(([id]) => !['tools', 'symposium', 'compare'].includes(id));
  const snapshot = structuredClone(supplied);
  assert.deepEqual(ids('truth', supplied), []);
  assert.deepEqual(supplied, snapshot);
  assert.deepEqual(rankTools([], 'truth'), []);
});
