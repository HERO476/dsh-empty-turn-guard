# Changelog

本文件记录 dsh-empty-turn-guard 的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-10-26

修复评审（技术方案评审团：架构 / 应用安全 / 现实核对）发现的缺陷，重点是空回合补写的状态机。

### 修复

- **补写状态机（高）**：`awaitingGuardTurn` 在三条早退路径上不清零——真人插话取消、补写回合非 `completed`（`aborted` / `error` / `max-tokens`）、三级投递全失败——导致**下一次真正的空回合被误判成「连环补写」而静默跳过**，日志还写 `stop chaining`。现在 `turn/end` 入口先取 `wasGuard` 再无条件清零；投递失败也显式清零。
- **`runtime-context` 被当成真人插话（中）**：宿主每一步都会 append 一条 `source.kind === 'runtime-context'` 的 `user/message`（`dsh-agent-loop`），旧实现把所有非本插件的 `user/message` 都当成真人取消补写，实际上补写几乎必被取消。现在只有 `source.kind === 'user'`（`source` 缺失时保守视为真人）才取消。
- **小时预算被取消操作吃掉（中）**：旧实现「调度即记账」，取消/失败也占额度；现在按**投递成功**记账。
- **零宽字符集过窄（中）**：补上 `U+3164`（韩文填充符，最常被当作「隐形字」）、`U+2800`（盲文空白）、`U+180B–U+180E`、`U+FE00–U+FE0F`、`U+2065`、`U+206A–U+206F`、`U+FFA0`、`U+E0100–U+E01EF`、`U+034F`、`U+061C`、`U+115F`、`U+1160`、`U+17B4`、`U+17B5`、`U+2028`、`U+2029` 等。
- **配置语义**：`maxNudgesPerHour: 0` 现在真的关闭补写（旧实现被 `|| 3` 吞成 3）；`delayMs: "abc"` 等非法值回落默认值（旧实现 `|| 0` 变成 0 毫秒）；`enabled: "false"` 字符串现在真的关闭（旧实现只认布尔 `false`）。
- **回合竞态**：空回合结束后 900ms 内若新回合自己起来，旧实现会把补写插进别人的回合；现在 `turn/start` 取消过期定时器，定时器触发时再校验 `pendingTurn` 是否仍等于当前回合。
- **漏判**：没有任何 `assistant/message` 的 `completed` 回合（`visibleChars === 0`）旧实现因为 `assistantMessages > 0` 前置条件而漏判，现在会补写。
- **热启用惰性**：旧实现只靠 `agent/created` 填 agent 表，插件热启用时存量会话永远没有 agent、补写全被 `SKIPPED`。现在启动时向宿主 `agents` 注册表 `list()` 回填一次。
- **日志**：跟随 `DSH_HOME`（旧实现硬编码 `os.homedir()`）、超过 5 MB 自动轮转、每行带会话 id 前 8 位与 `wasGuard`。

### 变更

- 补写消息正文不再要求模型「不要提及这条提醒」：该消息以 `role:'user'` 落进持久转录，隐瞒来源属于破坏转录完整性。现在明确写「插件自动补发」，并带 `source = { kind: 'plugin:empty-turn-guard', plugin, reason }`。

### 测试

- `test/guard.test.mjs` 从 9 条扩到 18 条，并修正**事件载荷形状**：宿主 `session.append(type, data)` 的 `data` 就是消息本体（`data.source.kind`），旧用例包了一层 `{ message: { source } }`，导致「真人插话取消」「plugin 来源不参与判定」两条用例实际空转。新增：非 completed 后不污染下一回合、投递全失败后可恢复、`runtime-context` 不取消、新回合丢弃过期补写、配置 0/非法值语义、扩展零宽集、热启用回填、卸载清理。

### 明确不做

- `inject = ['systemPrompt']` 保持硬依赖。本版本 `@deepseek-ai/cordis` 的 `Inject.resolve` 只接受数组或「name → config 映射」，**没有 `required`/`optional` 语义**；改成 `{ optional: [...] }` 会被当成「等一个叫 optional 的服务」，插件永不激活。

## [0.1.2] - 2026-10-25

放宽宿主版本门槛：功能无改动。

### 变更

- `engines.dsh` 从 `>=0.2.1-rc.2` 放宽到 `>=0.2.1-rc.1`。
  依据：本插件用到的宿主 API（`ctx.systemPrompt.section`、`agent.send` / `followup` / `inject`、
  `agent/created`、`session/event`、`dsh.bundle.patch` 加载）在 DSH `0.2.1-rc.1` / `rc.2` / `rc.3`
  三个版本的实现**逐字节相同**（`dsh-system-prompt`、`dsh-agent-loop`、`dsh-agent`、`dsh-session`、
  `dsh-app-boot`、`dsh-plugin-manager`、`dsh-web-app` 的 `lib/index.js` md5 三版本一致，差异仅在
  `package.json` 的版本号字段）。所以 rc.1 上代码本来就能跑，旧门槛只是把它挡在门外——
  宿主 `dsh-app-boot` 的版本闸门不满足时会把 bundle 收进 `skippedBundles`，启动只打一行
  `dsh: skipping profile bundle "dsh-empty-turn-guard": …` 然后**静默不加载**。

### 注意

- **不要**把范围写成 `>=0.2.1`。semver 规则里预发布版本不满足「不含预发布标识的同段范围」，
  `0.2.1-rc.3` 对 `>=0.2.1` 判为 `false`，那样会把 rc.1 / rc.2 / rc.3 全部挡掉。

## [0.1.1] - 2026-10-25

发布规范化版本：功能与 0.1.0 一致，补齐工程与元数据。

### 新增

- `test/guard.test.mjs`：9 条契约测试，用 mock ctx 驱动真实 `apply()`，不依赖宿主即可回归。
  覆盖零宽空回合补写、正常回合不干预、非 `completed` 不补写、补写回合再空不连环、
  真人插话取消、`send` 失败降级 `followup`、`plugin:` 来源消息不参与判定。
- `scripts/check-metadata.mjs`：发布前元数据检查，校验字段齐全、`files` 路径真实存在、
  无 `TODO` 占位符、`cordis.patch.yml` 的 `- insert:` 与包名对齐、入口可 `import`。
- `CHANGELOG.md`（本文件）。

### 修正

- 重新统计并修正 README 里的实测样本数据（原 0.1.0 写的是 738 回合 / 102 空 / 13.8%，
  该口径把只有工具调用的步骤也算成了空回合）。准确口径：208 会话 / 766 回合，
  可见正文为空的回合 39 个（5.1%），其中 `completed` 的 8 个（1.2%）才是本插件处理的对象。

### 变更

- `package.json` 补齐发布元数据：`repository` / `homepage` / `bugs` / `author` / `exports` /
  `engines` / `publishConfig` / `scripts`。
- `prepublishOnly` 串联 `check-metadata` 与 `test`，检查不过不允许发布。

## [0.1.0] - 2026-10-25

首个可用版本。

### 新增

- **C 空回合保护**：监听 `session/event`，在 `turn/end`（`reason.kind === 'completed'`）时
  累计本回合所有 `assistant/message` 的可见正文；去掉零宽字符后为空则自动排一条
  `target: 'next-turn'` 的补写消息（`agent.send(msg, 'next-turn', true)`，
  失败依次降级 `followup` → `inject`），让模型在下一回合补出正文。
- **A 收尾指令注入**：通过 `systemPrompt.section({ name, order: 960, interpolate: false })`
  注入 222 字指令，要求每回合以看得见的正文收尾、禁止用零宽字符或空白充当回答。
- 防误伤：同回合最多补写一次、补写回合再空即停、每小时最多 3 次、
  定时器触发前收到真人消息立即取消、`plugin:` 来源消息不参与判定。
- 日志落 `~/.dsh/logs/empty-turn-guard.log`，主路径不可写时兜底到系统临时目录。

### 说明

- 修复目标问题：模型把输出预算烧在 reasoning 上、正文只返回一个 `U+200B`，
  而 DSH 的 `EMPTY_RESPONSE` 判空因「文本非空」不触发，回合被记为 `completed` 但界面空白。
