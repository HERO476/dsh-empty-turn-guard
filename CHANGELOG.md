# Changelog

本文件记录 dsh-empty-turn-guard 的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
