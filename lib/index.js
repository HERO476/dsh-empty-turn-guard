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
 * 设计约束：
 *   1) 所有逻辑都包在 try/catch 里，任何异常只写日志，绝不向上抛，以免拖垮宿主回合。
 *   2) inject 是 cordis 的硬依赖（数组形式）。本版本 cordis 的 Inject.resolve
 *      （@deepseek-ai/cordis lib/index.js）只接受「数组」或「name -> config 映射」，
 *      没有 required/optional 语义 —— 写 { optional: [...] } 会被当成「等一个叫
 *      optional 的服务」，插件将永不激活。因此 systemPrompt 保持硬依赖。
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
const SOURCE = Object.freeze({ kind: 'plugin:' + PLUGIN_ID, plugin: PLUGIN_ID, reason: 'empty-turn' });
const SOURCE_KIND = SOURCE.kind;
const SECTION_NAME = 'empty-turn-guard';
/** 950 已被 instruction-memory 占用；960 在其后、TOOL_BASH(1000) 之前。 */
const SECTION_ORDER = 960;

/** 一小时预算窗口（毫秒）。 */
const HOUR_MS = 3600000;
/** 单个日志文件上限，超过就轮转成 .1（appendFileSync 没有上限，长期跑会无限长）。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_ROTATE_CHECK_MS = 60000;

/**
 * 不可见字符集合（按「渲染后不产生任何可见笔画」取值）：
 *   U+00AD 软连字符、U+034F 组合字形连接符、U+061C 阿拉伯字母标记、
 *   U+115F/U+1160 韩文字母填充符、U+17B4/U+17B5 高棉元音固有符、
 *   U+180B-U+180E 蒙古文自由变体选择符、U+200B-U+200F 零宽/方向符、
 *   U+2028/U+2029 行/段分隔符、U+202A-U+202E 双向控制、
 *   U+2060-U+2065 词连接符/不可见运算符、U+206A-U+206F 已弃用格式符、
 *   U+2800 盲文空白、U+3164 韩文填充符（最常被拿来当「隐形字」）、
 *   U+FE00-U+FE0F 变体选择符、U+FEFF BOM/零宽不换行空格、
 *   U+FFA0 半角韩文填充符、U+E0100-U+E01EF 变体选择符补充。
 */
const ZERO_WIDTH = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2065\u206a-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0100}-\u{e01ef}]/gu;

const DEFAULT_INSTRUCTION = [
  '# 回合收尾：必须留下看得见的正文',
  '',
  '不管推理多长、工具调用多少次，**每一回合的最后都要给用户一段看得见的正文**（普通文本，不能是空字符串、空白、零宽字符或只有工具调用）。',
  '结束回合前自检：',
  '1. 只做了工具调用、还没有文字结论 → 补一段总结：做了什么、结果如何、下一步是什么。',
  '2. 被长度或超时截断 → 写出已知结论，并明确说明「尚未完成，剩余部分是……」。',
  '3. 禁止用零宽字符、空行或纯空白充当回答；这种回合在用户界面上是空白的。',
].join('\n');

/**
 * 补写消息的正文。刻意不再写「不要提及这条提醒」：
 * 这条消息会以 role:'user' 落进持久转录，让它自称普通用户输入并隐瞒来源，
 * 属于对转录完整性的破坏。现在明确告知「这是插件自动补发」。
 */
const NUDGE_TEXT = [
  '【空回合保护 · 插件自动补发】',
  '你上一个回合结束时没有任何可见正文（最后一条助手消息的文字只有零宽占位符或空白），用户界面上看不到你的回答。',
  '请立刻用 1~3 句话把上一回合的结论补出来：做了什么、结果如何、下一步是什么。',
  '直接输出纯文本，不要调用工具。',
].join('\n');

function errText(err) {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
}

/** 严格取整数：非法值（NaN/Infinity/非数字串）一律回落到默认值，0 是合法值。 */
function intOr(value, fallback, min, max) {
  let n = value;
  if (typeof n === 'string' && n.trim() !== '') n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  n = Math.trunc(n);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** enabled 只认「明确的假值」：false / 'false' / 0 / '0'；其余（含 undefined）都算开。 */
function enabledOr(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  }
  return true;
}

/** 一条消息里所有 text 块拼起来，剥掉不可见字符和首尾空白后的可见文本。 */
function visibleText(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  let acc = '';
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') acc += part.text;
  }
  return acc.replace(ZERO_WIDTH, '').trim();
}

/** 按码位计数，避免代理对被算成 2 个字符。 */
function codepointLength(text) {
  return Array.from(text).length;
}

export function apply(ctx, config) {
  const raw = config || {};
  const cfg = {
    enabled: enabledOr(raw.enabled, true),
    injectInstruction: enabledOr(raw.injectInstruction, true),
    instructionText: typeof raw.instructionText === 'string' ? raw.instructionText : '',
    // 判定阈值：可见字符数 < 该值即算空。0 与 1 等价（都是「至少要有一个可见字符」）。
    // 注意：没有 assistant 消息的 completed 回合（visibleChars=0）也算空，这是相对旧版的修正。
    minVisibleChars: Math.max(1, intOr(raw.minVisibleChars, 1, 0, 100000)),
    delayMs: intOr(raw.delayMs, 900, 0, 60000),
    // 0 表示关闭补写（而不是被 || 吞成 3）。
    maxNudgesPerHour: intOr(raw.maxNudgesPerHour, 3, 0, 1000),
    logFile: typeof raw.logFile === 'string' ? raw.logFile.trim() : '',
  };

  // 日志位置优先跟随 DSH_HOME（多 profile / 自定义家目录时才不会写错地方）。
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  const logPath = cfg.logFile !== '' ? cfg.logFile : path.join(dshHome, 'logs', 'empty-turn-guard.log');
  const fallbackLogPath = path.join(os.tmpdir(), 'empty-turn-guard.log');
  const startedAt = Date.now();
  let lastRotateCheck = 0;

  /** 日志超过上限就轮转成 .1，避免长期运行把磁盘写满。 */
  const maybeRotate = () => {
    const now = Date.now();
    if (now - lastRotateCheck < LOG_ROTATE_CHECK_MS) return;
    lastRotateCheck = now;
    try {
      const st = fs.statSync(logPath);
      if (st.size > LOG_MAX_BYTES) fs.renameSync(logPath, logPath + '.1');
    } catch { /* 文件不存在或不可写：忽略 */ }
  };

  // 主日志写在 $DSH_HOME/logs；万一主路径不可写（受限环境/目录被锁），
  // 再退到系统临时目录，避免「插件其实活着但一行日志都没有」的误判。
  const log = (line) => {
    const record = '[' + new Date().toISOString() + '] ' + line + '\n';
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      maybeRotate();
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

  const tag = (session) => {
    try {
      const id = session && typeof session.id === 'string' ? session.id : '';
      return id ? id.slice(0, 8) : 'no-session';
    } catch { return 'no-session'; }
  };

  log('plugin activated: pid=' + process.pid + ' enabled=' + cfg.enabled + ' instruction=' + cfg.injectInstruction + ' dshHome=' + dshHome);

  // ---- A) system prompt 段落 ----
  if (cfg.injectInstruction) {
    try {
      const text = cfg.instructionText.trim() !== '' ? cfg.instructionText : DEFAULT_INSTRUCTION;
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
  const agentsById = new Map(); // session.id -> agent（session 对象身份不稳定时兜底）
  const state = new WeakMap(); // session -> per-session guard state
  const timers = new Set(); // 所有在跑的定时器，便于 dispose 时一次性清掉

  const stateOf = (session) => {
    let s = state.get(session);
    if (!s) {
      s = {
        turn: null,
        assistantMessages: 0,
        visibleChars: 0,
        guardSentForTurn: null,
        /** 已成功投递补写、且该补写对应的回合还没结束。 */
        awaitingGuardTurn: false,
        /** 定时器是为哪个回合排的；回合变了就该丢弃。 */
        pendingTurn: null,
        nudgeTimes: [],
        timer: null,
      };
      state.set(session, s);
    }
    return s;
  };

  const clearTimer = (s, why) => {
    if (!s.timer) return;
    try { clearTimeout(s.timer); } catch { /* ignore */ }
    timers.delete(s.timer);
    s.timer = null;
    s.pendingTurn = null;
    if (why) log('pending nudge CANCELLED (' + why + ')');
  };

  const resetTurnCounters = (s, turn) => {
    s.turn = typeof turn === 'number' ? turn : s.turn;
    s.assistantMessages = 0;
    s.visibleChars = 0;
    s.guardSentForTurn = null;
  };

  const register = (agent) => {
    if (!agent) return false;
    const session = agent.session;
    if (!session) return false;
    const existed = agents.has(session);
    agents.set(session, agent);
    if (typeof session.id === 'string' && session.id !== '') agentsById.set(session.id, agent);
    if (!existed && agents.size % 20 === 0) log('agent registry size=' + agents.size);
    return true;
  };

  /** 先按对象身份找，再按 session.id 找：宿主不同代码路径给的 session 对象可能不是同一个实例。 */
  const agentOf = (session) => {
    const direct = agents.get(session);
    if (direct) return direct;
    const id = session && typeof session.id === 'string' ? session.id : '';
    return id ? agentsById.get(id) : undefined;
  };

  /**
   * 热启用时，会话的 agent 早就建好了，agent/created 不会再触发；
   * 只靠事件订阅会让存量会话永久处于「没有 agent」的惰性状态。
   * 因此启动时主动向宿主 agent 注册表回填一次。
   */
  const backfillAgents = () => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      const list = registry && typeof registry.list === 'function' ? registry.list() : [];
      if (!Array.isArray(list)) return;
      let added = 0;
      for (const agent of list) if (register(agent)) added += 1;
      if (added > 0) log('agent registry backfilled: +' + added + ' (total=' + agents.size + ')');
    } catch (err) {
      log('agent backfill failed: ' + errText(err));
    }
  };

  try {
    ctx.on('agent/created', (payload) => {
      try {
        register(payload && payload.agent ? payload.agent : payload);
      } catch (err) {
        log('agent/created handler error: ' + errText(err));
      }
    });
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent ? payload.agent : payload;
        const session = agent && agent.session;
        if (!session) return;
        const s = state.get(session);
        if (s) {
          clearTimer(s, null);
          s.awaitingGuardTurn = false;
          s.pendingTurn = null;
        }
        agents.delete(session);
        if (typeof session.id === 'string' && session.id !== '') agentsById.delete(session.id);
      } catch (err) {
        log('agent/disposed handler error: ' + errText(err));
      }
    });
  } catch (err) {
    log('agent lifecycle subscription FAILED: ' + errText(err));
  }

  backfillAgents();

  const buildMessage = (text) => ({
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { ...SOURCE },
  });

  const deliver = (session, text) => {
    const agent = agentOf(session);
    if (!agent) {
      log('nudge SKIPPED [' + tag(session) + ']: no live agent bound to session');
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
        log('nudge DELIVERED via ' + label + ' [' + tag(session) + ']');
        return true;
      } catch (err) {
        log('nudge attempt "' + label + '" failed: ' + errText(err));
      }
    }
    return false;
  };

  const pruneBudget = (s, now) => {
    s.nudgeTimes = s.nudgeTimes.filter((t) => now - t < HOUR_MS);
    return s.nudgeTimes.length;
  };

  const scheduleNudge = (session, s, turn, info) => {
    try {
      if (s.timer) clearTimer(s, 'rescheduled');
      s.pendingTurn = turn;
      const delay = cfg.delayMs;
      log('nudge SCHEDULED turn=' + turn + ' delay=' + delay + 'ms [' + tag(session) + '] (' + info + ')');
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (s.timer !== timer) return; // 已被替换或取消
        s.timer = null;
        try {
          // 定时器跑起来时回合可能已经往前走：丢弃过期补写，避免插进别人的回合。
          if (s.pendingTurn !== null && s.turn !== s.pendingTurn) {
            s.pendingTurn = null;
            log('nudge DROPPED: turn moved on (pending=' + turn + ' current=' + s.turn + ') [' + tag(session) + ']');
            return;
          }
          s.pendingTurn = null;
          if (s.awaitingGuardTurn) {
            log('nudge SKIPPED: a guard turn is already in flight [' + tag(session) + ']');
            return;
          }
          if (cfg.maxNudgesPerHour === 0) {
            log('nudge SKIPPED: maxNudgesPerHour=0 [' + tag(session) + ']');
            return;
          }
          // 预算按「真正投递成功」计，取消/失败不占额度。
          if (pruneBudget(s, Date.now()) >= cfg.maxNudgesPerHour) {
            log('hourly nudge budget exhausted (' + s.nudgeTimes.length + ') -> no nudge');
            return;
          }
          const ok = deliver(session, NUDGE_TEXT);
          if (ok) {
            s.awaitingGuardTurn = true;
            s.nudgeTimes.push(Date.now());
          } else {
            // 投递失败绝不留悬空标志，否则下一次真正的空回合会被误判成「连环补写」。
            s.awaitingGuardTurn = false;
            log('nudge NOT DELIVERED -> awaitingGuardTurn cleared [' + tag(session) + ']');
          }
        } catch (err) {
          s.awaitingGuardTurn = false;
          log('nudge timer error: ' + errText(err));
        }
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      s.timer = timer;
      timers.add(timer);
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
          // 新回合自己起来了：空回合早已结束，排队中的补写不再有意义。
          if (s.timer && !s.awaitingGuardTurn) clearTimer(s, 'new turn started');
          resetTurnCounters(s, data.turn);
          return;
        }

        if (event.type === 'user/message') {
          const source = data.source;
          const kind = source && typeof source.kind === 'string' ? source.kind : '';
          if (kind === SOURCE_KIND) return; // 自己排进去的补写消息，不参与判定
          // 宿主每步都会追加一条 source.kind='runtime-context' 的 user/message
          // （dsh-agent-loop），那不是真人在说话，不能拿它取消补写。
          // 只有真人输入（source.kind === 'user'）才取消；source 缺失时保守当作真人。
          const isHuman = kind === '' || kind === 'user';
          if (isHuman) clearTimer(s, 'human message');
          return;
        }

        if (event.type === 'assistant/message') {
          const message = data.message;
          if (!message || message.role !== 'assistant') return;
          if (typeof data.turn === 'number' && s.turn !== data.turn) resetTurnCounters(s, data.turn);
          s.assistantMessages += 1;
          s.visibleChars += codepointLength(visibleText(message));
          return;
        }

        if (event.type !== 'turn/end') return;

        const turn = typeof data.turn === 'number' ? data.turn : s.turn;
        const kind = data && data.reason && typeof data.reason.kind === 'string' ? data.reason.kind : 'unknown';
        // 先取「这个回合是不是补写回合」，再无条件清零：
        // 早退路径（非 completed / 已补过 / 预算耗尽）过去会把标志留在 true，
        // 导致下一次真正的空回合被当成连环补写而静默跳过。
        const wasGuard = s.awaitingGuardTurn === true;
        s.awaitingGuardTurn = false;
        s.pendingTurn = null;

        const empty = s.visibleChars < cfg.minVisibleChars;
        log('turn/end turn=' + turn + ' kind=' + kind + ' steps=' + s.assistantMessages
          + ' visibleChars=' + s.visibleChars + ' empty=' + empty + ' wasGuard=' + wasGuard
          + ' [' + tag(session) + ']');

        if (!empty) return;
        if (kind !== 'completed') {
          log('empty turn but kind=' + kind + ' -> no nudge');
          return;
        }
        if (wasGuard) {
          log('previous turn was already a guard turn and still empty -> stop chaining');
          return;
        }
        if (s.guardSentForTurn === turn) {
          log('already nudged for turn ' + turn + ' -> no nudge');
          return;
        }
        if (cfg.maxNudgesPerHour === 0) {
          log('maxNudgesPerHour=0 -> no nudge');
          return;
        }
        const now = Date.now();
        if (pruneBudget(s, now) >= cfg.maxNudgesPerHour) {
          log('hourly nudge budget exhausted (' + s.nudgeTimes.length + ') -> no nudge');
          return;
        }
        s.guardSentForTurn = turn;
        scheduleNudge(session, s, turn, 'empty completed turn');
      } catch (err) {
        log('session/event handler error: ' + errText(err));
      }
    });
  } catch (err) {
    log('session/event subscription FAILED: ' + errText(err));
    return;
  }

  // 插件卸载/重载时清掉所有定时器，避免定时器在旧实例上继续跑。
  try {
    ctx.effect(() => () => {
      for (const timer of timers) {
        try { clearTimeout(timer); } catch { /* ignore */ }
      }
      timers.clear();
    });
  } catch { /* effect 不可用时忽略 */ }

  log('guard armed (uptime=' + (Date.now() - startedAt) + 'ms)');
}

export default { name, inject, apply };
