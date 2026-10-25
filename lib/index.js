/**
 * dsh-empty-turn-guard — 空回合保护（C）+ 正文收尾指令（A），单插件合并。
 *
 * 背景（2026-10 排查结论）：
 *   模型偶尔把输出预算全烧在 reasoning 上，assistant/message 的 text 块只剩一个
 *   U+200B（零宽空格）占位符。因为 ZWSP 在长度上「非空」，宿主自带的
 *   EMPTY_RESPONSE 重试判定不会触发，回合照常以 turn/end {kind:"completed"}
 *   结束 —— 界面上就只剩「已完成分析 / 已调用工具 / 用时 N 分」这些过程行，
 *   用户一个字也看不到。
 *
 * 本插件做两件事：
 *   C) 监听 turn/end：若该回合所有助手消息的可见正文（剥离零宽字符后）为空，
 *      就通过 agent.send(msg, 'next-turn', true) 追加一条 plugin 消息，让模型
 *      在下一个回合把结论补出来。每回合最多 1 次，每会话每小时有上限，
 *      补写回合再空则不再连环触发。
 *   A) 注册一段 system prompt（order 960）要求每回合都以可见正文收尾。
 *
 * 设计约束：所有逻辑都包在 try/catch 里，任何异常只写日志，绝不向上抛，
 * 以免拖垮宿主回合。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// 注意：本插件刻意不 import 任何宿主包。
// 插件从 .dsh/plugins 经 junction 装进 profile 的 node_modules，Node 的裸名解析
// 在插件目录下找不到 @deepseek-ai/*（宿主靠自己的 loader 解析）；少一个 import
// 就少一个「插件整个加载失败」的风险面。因此不导出 Config schema。


export const name = 'empty-turn-guard';
export const inject = ['systemPrompt'];

const PLUGIN_ID = 'empty-turn-guard';
const SOURCE = Object.freeze({ kind: 'plugin:' + PLUGIN_ID });
const SECTION_NAME = 'empty-turn-guard';
/** 950 已被 instruction-memory 占用；960 在其后、TOOL_BASH(1000) 之前。 */
const SECTION_ORDER = 960;

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g;

const DEFAULT_INSTRUCTION = [
  '# 回合收尾：必须留下看得见的正文',
  '',
  '不管推理多长、工具调用多少次，**每一回合的最后都要给用户一段看得见的正文**（普通文本，不能是空字符串、空白、零宽字符或只有工具调用）。',
  '结束回合前自检：',
  '1. 只做了工具调用、还没有文字结论 → 补一段总结：做了什么、结果如何、下一步是什么。',
  '2. 被长度或超时截断 → 写出已知结论，并明确说明「尚未完成，剩余部分是……」。',
  '3. 禁止用零宽字符、空行或纯空白充当回答；这种回合在用户界面上是空白的。',
].join('\n');

const NUDGE_TEXT = [
  '【空回合保护 · 系统自动提醒】',
  '你上一个回合结束时没有任何可见正文（最后一条助手消息的文字只有零宽占位符），用户界面上看不到你的回答。',
  '请立刻用 1~3 句话把上一回合的结论补出来：做了什么、结果如何、下一步是什么。',
  '直接输出纯文本，不要调用工具，也不要提及这条提醒。',
].join('\n');

function errText(err) {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
}

/** 一条消息里所有 text 块拼起来，剥掉零宽字符和首尾空白后的可见文本。 */
function visibleText(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  let acc = '';
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') acc += part.text;
  }
  return acc.replace(ZERO_WIDTH, '').trim();
}

function hasToolCall(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  return content.some((part) => part && part.type === 'tool-call');
}

export function apply(ctx, config) {
  const cfg = {
    enabled: true,
    injectInstruction: true,
    instructionText: '',
    minVisibleChars: 1,
    delayMs: 900,
    maxNudgesPerHour: 3,
    logFile: '',
    ...(config || {}),
  };

  const logPath = cfg.logFile && cfg.logFile.trim() !== ''
    ? cfg.logFile
    : path.join(os.homedir(), '.dsh', 'logs', 'empty-turn-guard.log');
  const startedAt = Date.now();

  // 主日志写在 ~/.dsh/logs；万一主路径不可写（受限环境/目录被锁），
  // 再退到系统临时目录，避免「插件其实活着但一行日志都没有」的误判。
  const fallbackLogPath = path.join(os.tmpdir(), 'empty-turn-guard.log');
  const log = (line) => {
    const record = '[' + new Date().toISOString() + '] ' + line + '\n';
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, record);
      return;
    } catch {
      /* 落到下面的兜底 */
    }
    try {
      fs.appendFileSync(fallbackLogPath, record);
    } catch {
      /* 日志失败绝不影响宿主 */
    }
  };

  log('plugin activated: pid=' + process.pid + ' enabled=' + cfg.enabled + ' instruction=' + cfg.injectInstruction);

  // ---- A) system prompt 段落 ----
  if (cfg.injectInstruction) {
    try {
      const text = cfg.instructionText && cfg.instructionText.trim() !== '' ? cfg.instructionText : DEFAULT_INSTRUCTION;
      const dispose = ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text,
        interpolate: false,
      });
      if (typeof dispose === 'function') {
        try {
          ctx.effect(() => () => { try { dispose(); } catch { /* ignore */ } });
        } catch { /* effect 不可用时忽略 */ }
      }
      log('prompt section registered: order=' + SECTION_ORDER + ' chars=' + text.length);
    } catch (err) {
      log('prompt section registration FAILED: ' + errText(err));
    }
  }

  if (!cfg.enabled) {
    log('guard disabled by config; only instruction part active');
    return;
  }

  // ---- C) 空回合保护 ----
  const agents = new Map(); // session -> agent
  let agentCount = 0;
  const state = new WeakMap(); // session -> per-session guard state

  const stateOf = (session) => {
    let s = state.get(session);
    if (!s) {
      s = {
        turn: null,
        assistantMessages: 0,
        visibleChars: 0,
        lastToolOnly: false,
        guardSentForTurn: null,
        awaitingGuardTurn: false,
        nudgeTimes: [],
        timer: null,
      };
      state.set(session, s);
    }
    return s;
  };

  const agentOf = (session) => {
    const direct = agents.get(session);
    if (direct) return direct;
    for (const [key, agent] of agents) {
      try {
        if (key === session || agent.session === session) return agent;
      } catch { /* ignore */ }
    }
    return undefined;
  };

  try {
    ctx.on('agent/created', (payload) => {
      try {
        const agent = payload && payload.agent ? payload.agent : payload;
        const session = agent && agent.session;
        if (session) {
          agents.set(session, agent);
          agentCount += 1;
          // 启动时宿主会为每个会话建一次 agent（实测 30+ 行刷屏），
          // 所以这里只在数量变化时记一行摘要，不逐条打点。
          if (agentCount % 20 === 0) log('agent registry size=' + agentCount);
        }
      } catch (err) {
        log('agent/created handler error: ' + errText(err));
      }
    });
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent ? payload.agent : payload;
        const session = agent && agent.session;
        if (session) {
          const s = state.get(session);
          if (s && s.timer) clearTimeout(s.timer);
          agents.delete(session);
        }
      } catch (err) {
        log('agent/disposed handler error: ' + errText(err));
      }
    });
  } catch (err) {
    log('agent lifecycle subscription FAILED: ' + errText(err));
  }

  const buildMessage = (text) => ({
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { ...SOURCE },
  });

  const deliver = (session, text) => {
    const agent = agentOf(session);
    if (!agent) {
      log('nudge SKIPPED: no live agent bound to session');
      return false;
    }
    const message = buildMessage(text);
    const attempts = [
      ['send(next-turn,wakeup)', () => agent.send(message, 'next-turn', true)],
      ['followup', () => agent.followup(message)],
      ['inject', () => agent.inject(message)],
    ];
    for (let i = 0; i < attempts.length; i += 1) {
      const label = attempts[i][0];
      const fn = attempts[i][1];
      try {
        fn();
        log('nudge DELIVERED via ' + label);
        return true;
      } catch (err) {
        log('nudge attempt "' + label + '" failed: ' + errText(err));
      }
    }
    return false;
  };

  const scheduleNudge = (session, s, turn, info) => {
    try {
      if (s.timer) clearTimeout(s.timer);
      const delay = Math.max(0, Number(cfg.delayMs) || 0);
      s.guardSentForTurn = turn;
      s.awaitingGuardTurn = true;
      s.nudgeTimes.push(Date.now());
      log('nudge SCHEDULED turn=' + turn + ' delay=' + delay + 'ms (' + info + ')');
      s.timer = setTimeout(() => {
        s.timer = null;
        try {
          deliver(session, NUDGE_TEXT);
        } catch (err) {
          log('nudge timer error: ' + errText(err));
        }
      }, delay);
      if (s.timer && typeof s.timer.unref === 'function') s.timer.unref();
    } catch (err) {
      log('scheduleNudge error: ' + errText(err));
    }
  };

  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!session || !event || typeof event.type !== 'string') return;
        const data = event.data || {};
        const s = stateOf(session);

        if (event.type === 'turn/start') {
          s.turn = typeof data.turn === 'number' ? data.turn : s.turn;
          s.assistantMessages = 0;
          s.visibleChars = 0;
          s.lastToolOnly = false;
          return;
        }

        if (event.type === 'user/message') {
          const source = data.source;
          const isGuard = source && typeof source.kind === 'string' && source.kind === SOURCE.kind;
          if (isGuard) return; // 自己排进去的补写消息，不参与判定
          // 真人插话：取消尚未触发的补写，避免和用户新消息抢话
          if (s.timer) {
            clearTimeout(s.timer);
            s.timer = null;
            log('pending nudge CANCELLED (new user message)');
          }
          return;
        }

        if (event.type === 'assistant/message') {
          const message = data.message;
          if (!message || message.role !== 'assistant') return;
          if (typeof data.turn === 'number' && s.turn !== null && data.turn !== s.turn) {
            s.turn = data.turn;
            s.assistantMessages = 0;
            s.visibleChars = 0;
          }
          const visible = visibleText(message);
          s.assistantMessages += 1;
          s.visibleChars += visible.length;
          s.lastToolOnly = hasToolCall(message) && visible.length === 0;
          return;
        }

        if (event.type !== 'turn/end') return;

        const turn = typeof data.turn === 'number' ? data.turn : s.turn;
        const kind = data && data.reason && typeof data.reason.kind === 'string' ? data.reason.kind : 'unknown';
        const empty = s.assistantMessages > 0 && s.visibleChars < (Number(cfg.minVisibleChars) || 1);

        log('turn/end turn=' + turn + ' kind=' + kind + ' steps=' + s.assistantMessages + ' visibleChars=' + s.visibleChars + ' empty=' + empty);

        if (!empty) {
          s.awaitingGuardTurn = false;
          return;
        }
        if (kind !== 'completed') {
          log('empty turn but kind=' + kind + ' -> no nudge');
          return;
        }
        if (s.guardSentForTurn === turn) {
          log('already nudged for turn ' + turn + ' -> no nudge');
          return;
        }
        if (s.awaitingGuardTurn) {
          log('previous turn was already a guard turn and still empty -> stop chaining');
          s.awaitingGuardTurn = false;
          return;
        }
        const now = Date.now();
        s.nudgeTimes = s.nudgeTimes.filter((t) => now - t < 3600000);
        if (s.nudgeTimes.length >= (Number(cfg.maxNudgesPerHour) || 3)) {
          log('hourly nudge budget exhausted (' + s.nudgeTimes.length + ') -> no nudge');
          return;
        }
        scheduleNudge(session, s, turn, 'empty completed turn');
      } catch (err) {
        log('session/event handler error: ' + errText(err));
      }
    });
  } catch (err) {
    log('session/event subscription FAILED: ' + errText(err));
    return;
  }

  log('guard armed (uptime=' + (Date.now() - startedAt) + 'ms)');
}

export default { name, inject, apply };
