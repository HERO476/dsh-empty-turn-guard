/**
 * 空回合保护插件的契约测试：用 mock ctx 驱动真实 apply()，不依赖宿主。
 *
 *   node test/guard.test.mjs
 *
 * 覆盖：零宽空回合补写、正常回合不干预、非 completed 不补写、补写回合再空不连环、
 * 真人插话取消、send 失败降级 followup、prompt 段落注册参数。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../lib/index.js';

const ZW = '\u200b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function makeRig(config = {}) {
  const logFile = path.join(os.tmpdir(), 'etg-test-' + process.pid + '-' + (++seq) + '.log');
  const sections = [];
  const handlers = new Map();
  const sent = [];
  const ctx = {
    systemPrompt: { section: (opts) => { sections.push(opts); return () => {}; } },
    on: (event, fn) => { handlers.set(event, fn); },
    effect: (fn) => { fn(); },
  };
  apply(ctx, { delayMs: 5, logFile, maxNudgesPerHour: 3, ...config });
  const session = { id: 'sess-' + seq };
  const agent = {
    session,
    send(message, target, wakeup) { sent.push({ via: 'send', target, wakeup, text: message.content[0].text }); },
    followup(message) { sent.push({ via: 'followup', text: message.content[0].text }); },
    inject(message) { sent.push({ via: 'inject', text: message.content[0].text }); },
  };
  handlers.get('agent/created')({ agent });
  const fire = (type, data) => handlers.get('session/event')(session, { type, data, seq: ++seq, time: Date.now() });
  const log = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  const cleanup = () => { try { fs.rmSync(logFile, { force: true }); } catch {} };
  return { ctx, sections, handlers, sent, session, agent, fire, log, cleanup };
}

const assistant = (text, tool = false) => ({
  role: 'assistant',
  content: [
    ...(text === null ? [] : [{ type: 'text', text }]),
    ...(tool ? [{ type: 'tool-call', name: 'ops_bash' }] : []),
    { type: 'reasoning', text: 'thinking' },
  ],
});

const cases = [];
const test = (title, fn) => cases.push({ title, fn });

test('导出契约：name / inject', () => {
  assert.equal(name, 'empty-turn-guard');
  assert.deepEqual(inject, ['systemPrompt']);
});

test('prompt 段落：order 960 + interpolate:false + 非空文案', () => {
  const rig = makeRig();
  assert.equal(rig.sections.length, 1);
  const s = rig.sections[0];
  assert.equal(s.name, 'empty-turn-guard');
  assert.equal(s.order, 960);
  assert.equal(s.interpolate, false);
  assert.ok(s.text.length > 100, 'section text too short: ' + s.text.length);
  rig.cleanup();
});

test('零宽空回合（completed）→ 补写一次，走 send(next-turn, wakeup)', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 1 });
  rig.fire('assistant/message', { turn: 1, step: 1, message: assistant(null, true) });
  rig.fire('assistant/message', { turn: 1, step: 2, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  assert.equal(rig.sent[0].via, 'send');
  assert.equal(rig.sent[0].target, 'next-turn');
  assert.equal(rig.sent[0].wakeup, true);
  assert.ok(rig.sent[0].text.includes('空回合保护'));
  assert.match(rig.log(), /empty=true/);
  assert.match(rig.log(), /nudge DELIVERED via send/);
  rig.cleanup();
});

test('正常回合 → 不干预', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 2 });
  rig.fire('assistant/message', { turn: 2, step: 1, message: assistant('结论：一切正常。') });
  rig.fire('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /empty=false/);
  rig.cleanup();
});

test('非 completed（interrupted）空回合 → 不补写', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 3 });
  rig.fire('assistant/message', { turn: 3, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 3, reason: { kind: 'interrupted' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /kind=interrupted .*-> no nudge/);
  rig.cleanup();
});

test('补写回合仍然为空 → 不连环补写', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 4 });
  rig.fire('assistant/message', { turn: 4, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 4, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  rig.fire('turn/start', { turn: 5 });
  rig.fire('assistant/message', { turn: 5, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 5, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'should not chain a second nudge');
  assert.match(rig.log(), /stop chaining/);
  rig.cleanup();
});

test('补写定时器未触发前真人插话 → 取消补写', async () => {
  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 6 });
  rig.fire('assistant/message', { turn: 6, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 6, reason: { kind: 'completed' } });
  rig.fire('user/message', { message: { role: 'user', source: { kind: 'user' } } });
  await sleep(140);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /pending nudge CANCELLED/);
  rig.cleanup();
});

test('send 抛错 → 降级到 followup', async () => {
  const rig = makeRig();
  rig.agent.send = () => { throw new Error('boom'); };
  rig.fire('turn/start', { turn: 7 });
  rig.fire('assistant/message', { turn: 7, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 7, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  assert.equal(rig.sent[0].via, 'followup');
  rig.cleanup();
});

test('plugin 来源的补写消息不参与空回合判定', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 8 });
  rig.fire('user/message', { message: { role: 'user', source: { kind: 'plugin:empty-turn-guard' } } });
  rig.fire('assistant/message', { turn: 8, step: 1, message: assistant('补写正文') });
  rig.fire('turn/end', { turn: 8, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  rig.cleanup();
});

let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log('  ok   ' + c.title);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + c.title);
    console.error('       ' + (err && err.message ? err.message : err));
  }
}
console.log('');
console.log(failed === 0 ? 'all ' + cases.length + ' cases passed' : failed + ' of ' + cases.length + ' cases failed');
process.exit(failed === 0 ? 0 : 1);
