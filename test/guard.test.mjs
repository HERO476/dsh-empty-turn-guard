/**
 * 空回合保护插件的契约测试：用 mock ctx 驱动真实 apply()，不依赖宿主。
 *
 *   node test/guard.test.mjs
 *
 * 事件载荷严格按宿主的真实形状构造（`session.append(type, data)`，data 就是消息本体）：
 *   turn/start        { turn }
 *   assistant/message { turn, step, message }
 *   user/message      <message>（含 source.kind：user / runtime-context / plugin:...）
 *   turn/end          { turn, reason: { kind } }
 *
 * 覆盖：零宽空回合补写、正常回合不干预、非 completed 不补写、补写回合再空不连环、
 * 真人插话取消、runtime-context 不取消、send 失败降级 followup、投递全失败后标志清理、
 * 配置 0/非法值语义、扩展零宽字符集、turn 前进后丢弃过期补写、小时预算、prompt 段落参数。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../lib/index.js';

const ZW = '\u200b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function makeRig(config = {}, registryAgents = []) {
  const logFile = path.join(os.tmpdir(), 'etg-test-' + process.pid + '-' + (++seq) + '.log');
  const sections = [];
  const handlers = new Map();
  const effects = [];
  const sent = [];
  const ctx = {
    systemPrompt: { section: (opts) => { sections.push(opts); return () => {}; } },
    on: (event, fn) => { handlers.set(event, fn); },
    effect: (fn) => { effects.push(fn); },
    get: (service) => (service === 'agents' ? { list: () => registryAgents } : undefined),
  };
  apply(ctx, { delayMs: 5, logFile, maxNudgesPerHour: 3, ...config });
  const session = { id: 'sess-' + seq };
  const agent = {
    session,
    send(message, target, wakeup) { sent.push({ via: 'send', target, wakeup, text: message.content[0].text, message }); },
    followup(message) { sent.push({ via: 'followup', text: message.content[0].text, message }); },
    inject(message) { sent.push({ via: 'inject', text: message.content[0].text, message }); },
  };
  if (!config.__skipCreate && handlers.has('agent/created')) handlers.get('agent/created')({ agent });
  const fire = (type, data) => {
    const fn = handlers.get('session/event');
    if (typeof fn !== 'function') throw new Error('插件未订阅 session/event（enabled=false？）');
    fn(session, { type, data, seq: ++seq, time: Date.now() });
  };
  const log = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  const cleanup = () => { try { fs.rmSync(logFile, { force: true }); } catch {} };
  return { ctx, sections, handlers, effects, sent, session, agent, fire, log, cleanup };
}

const assistant = (text, tool = false) => ({
  role: 'assistant',
  content: [
    ...(text === null ? [] : [{ type: 'text', text }]),
    ...(tool ? [{ type: 'tool-call', name: 'ops_bash' }] : []),
    { type: 'reasoning', text: 'thinking' },
  ],
});

/** 真人输入消息（source.kind === 'user'）。 */
const human = (text = '再说一次') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
/** 宿主每步注入的运行时上下文消息。 */
const runtimeContext = () => ({ role: 'user', content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' } });

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
  // 补写消息必须带可辨识来源，且不能自称普通用户输入后要求隐瞒。
  assert.equal(rig.sent[0].message.source.kind, 'plugin:empty-turn-guard');
  assert.ok(!rig.sent[0].text.includes('不要提及'));
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

test('非 completed（aborted）空回合 → 不补写，且不留悬空标志', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 3 });
  rig.fire('assistant/message', { turn: 3, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 3, reason: { kind: 'aborted' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /kind=aborted .*-> no nudge/);
  // 紧接着的真空回合仍应补写（旧实现会把它当成连环补写跳过）。
  rig.fire('turn/start', { turn: 4 });
  rig.fire('assistant/message', { turn: 4, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 4, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'aborted turn must not poison the next empty turn');
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
  rig.fire('user/message', human());
  await sleep(140);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /pending nudge CANCELLED \(human message\)/);
  rig.cleanup();
});

test('runtime-context 不是真人 → 不取消补写', async () => {
  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 7 });
  rig.fire('assistant/message', { turn: 7, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 7, reason: { kind: 'completed' } });
  rig.fire('user/message', runtimeContext());
  await sleep(140);
  assert.equal(rig.sent.length, 1, 'runtime-context must not cancel the pending nudge');
  assert.doesNotMatch(rig.log(), /CANCELLED/);
  rig.cleanup();
});

test('新回合自己起来 → 丢弃过期补写', async () => {
  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 8 });
  rig.fire('assistant/message', { turn: 8, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 8, reason: { kind: 'completed' } });
  rig.fire('turn/start', { turn: 9 });
  await sleep(140);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /CANCELLED \(new turn started\)/);
  rig.cleanup();
});

test('send 抛错 → 降级到 followup', async () => {
  const rig = makeRig();
  rig.agent.send = () => { throw new Error('boom'); };
  rig.fire('turn/start', { turn: 10 });
  rig.fire('assistant/message', { turn: 10, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 10, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  assert.equal(rig.sent[0].via, 'followup');
  rig.cleanup();
});

test('三级投递全失败 → 清标志，下一次空回合仍补写', async () => {
  const rig = makeRig();
  const boom = () => { throw new Error('nope'); };
  rig.agent.send = boom; rig.agent.followup = boom; rig.agent.inject = boom;
  rig.fire('turn/start', { turn: 11 });
  rig.fire('assistant/message', { turn: 11, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 11, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /NOT DELIVERED -> awaitingGuardTurn cleared/);
  // 恢复通道后，下一次真空回合必须还能补写（旧实现会被当成连环补写静默跳过）。
  rig.agent.send = (message, target, wakeup) => { rig.sent.push({ via: 'send', target, wakeup, text: message.content[0].text }); };
  rig.fire('turn/start', { turn: 12 });
  rig.fire('assistant/message', { turn: 12, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 12, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'delivery failure must not disable the guard');
  rig.cleanup();
});

test('扩展零宽字符集全部判空', async () => {
  for (const ch of ['\u200b', '\u3164', '\u2800', '\u180e', '\ufe0f', '\u2060', '\ufeff', '\u00ad']) {
    const rig = makeRig();
    rig.fire('turn/start', { turn: 13 });
    rig.fire('assistant/message', { turn: 13, step: 1, message: assistant(ch) });
    rig.fire('turn/end', { turn: 13, reason: { kind: 'completed' } });
    await sleep(40);
    assert.equal(rig.sent.length, 1, 'invisible char U+' + ch.codePointAt(0).toString(16) + ' should count as empty');
    rig.cleanup();
  }
});

test('没有 assistant 消息的 completed 回合也算空（旧版会漏判）', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 14 });
  rig.fire('turn/end', { turn: 14, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  rig.cleanup();
});

test('maxNudgesPerHour=0 → 关闭补写（不被 || 默认成 3）', async () => {
  const rig = makeRig({ maxNudgesPerHour: 0 });
  rig.fire('turn/start', { turn: 15 });
  rig.fire('assistant/message', { turn: 15, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 15, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /maxNudgesPerHour=0 -> no nudge/);
  rig.cleanup();
});

test('小时预算：3 次之后不再补写', async () => {
  const rig = makeRig({ maxNudgesPerHour: 3 });
  // 每次补写之后接一个「补写成功」的回合，把 awaitingGuardTurn 正常消费掉，
  // 否则连续空回合会按设计走「stop chaining」而不是继续消耗预算。
  for (let i = 1; i <= 4; i += 1) {
    const t = 20 + i * 2;
    rig.fire('turn/start', { turn: t });
    rig.fire('assistant/message', { turn: t, step: 1, message: assistant(ZW) });
    rig.fire('turn/end', { turn: t, reason: { kind: 'completed' } });
    await sleep(40);
    rig.fire('turn/start', { turn: t + 1 });
    rig.fire('assistant/message', { turn: t + 1, step: 1, message: assistant('补出来的结论') });
    rig.fire('turn/end', { turn: t + 1, reason: { kind: 'completed' } });
    await sleep(40);
  }
  assert.equal(rig.sent.length, 3);
  assert.match(rig.log(), /budget exhausted/);
  rig.cleanup();
});

test('非法配置回落默认值；enabled:"false" 真的关闭', async () => {
  const rig = makeRig({ delayMs: 'abc', maxNudgesPerHour: 'x', minVisibleChars: null });
  rig.fire('turn/start', { turn: 30 });
  rig.fire('assistant/message', { turn: 30, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 30, reason: { kind: 'completed' } });
  await sleep(1100);
  assert.match(rig.log(), /delay=900ms/, 'delayMs 非法应回落 900');
  assert.equal(rig.sent.length, 1, 'maxNudgesPerHour 非法应回落 3（仍会补写）');
  rig.cleanup();

  const off = makeRig({ enabled: 'false' });
  assert.match(off.log(), /guard disabled by config/);
  // 禁用时不应订阅 session/event（补写逻辑整体不装）；但 A 段指令仍生效。
  assert.equal(off.handlers.has('session/event'), false, '禁用时不应订阅 session/event');
  assert.equal(off.sections.length, 1, 'A 段指令与 C 段开关互相独立');
  off.cleanup();
});

test('热启用：启动时从 agent 注册表回填，无需等 agent/created', async () => {
  const preexisting = { session: { id: 'sess-preexisting' }, send() { preexisting.sent = true; } };
  const rig = makeRig({ __skipCreate: true }, [preexisting]);
  assert.match(rig.log(), /agent registry backfilled: \+1/);
  rig.cleanup();
});

test('session 对象身份不同但 id 相同 → 仍能找到 agent 投递', async () => {
  const rig = makeRig();
  const clone = { id: rig.session.id }; // 宿主不同路径可能给不同实例
  const handler = rig.handlers.get('session/event');
  const fireClone = (type, data) => handler(clone, { type, data, seq: ++seq, time: Date.now() });
  fireClone('turn/start', { turn: 40 });
  fireClone('assistant/message', { turn: 40, step: 1, message: assistant(ZW) });
  fireClone('turn/end', { turn: 40, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'should fall back to session.id lookup');
  rig.cleanup();
});

test('effect 注册了清理函数（卸载时清定时器）', () => {
  const rig = makeRig();
  assert.ok(rig.effects.length >= 1);
  for (const eff of rig.effects) {
    const dispose = eff();
    if (typeof dispose === 'function') dispose();
  }
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
