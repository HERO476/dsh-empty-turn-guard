# dsh-empty-turn-guard

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的**空回合保护**插件：当模型把输出预算全烧在 reasoning 上、回合结束时没有任何看得见的正文时，自动补一条 next-turn 消息让它把结论写出来；同时往系统提示注入一条「每回合必须以可见正文收尾」的规则。

## 它解决什么问题

模型偶发「思考完就结束」：`assistant/message` 的 text 块只剩一个零宽空格（U+200B）占位符，reasoning 却有好几千 token。因为 ZWSP 在长度上「非空」，宿主自带的 `EMPTY_RESPONSE` 重试判定不会触发，回合照常以 `turn/end {kind:"completed"}` 结束 —— 聊天界面上就只剩「已完成分析 / 已调用工具 / 用时 8 分 46 秒」这些过程行，**一个字都看不到**，而且这种回合在日志里是「正常完成」的，事后无法补救。

实测样本（本机 208 个会话、766 个回合，2026-10-25 重统计）：有助手消息但可见正文为空的回合共 39 个（5.1%）；其中 `completed` 的有 8 个（占 649 个 completed 回合的 1.2%）—— 这 8 个正是本插件要救的目标，其余空回合集中在 `interrupted`(19) / `error`(6) / `aborted`(3) / `max-tokens`(3)，本就不该补写。

本插件在回合结束时补一道判定，把「完成但没内容」变成「完成且有内容」。

## 行为

1. **检测**：累计本回合所有 `assistant/message` 的 text 块（剥掉 `U+00AD / U+034F / U+061C / U+115F / U+1160 / U+17B4 / U+17B5 / U+180B–U+180E / U+200B–U+200F / U+2028–U+202E / U+2060–U+2065 / U+206A–U+206F / U+2800 / U+3164 / U+FE00–U+FE0F / U+FEFF / U+FFA0 / U+E0100–U+E01EF` 后 trim）。`turn/end` 时若「可见字符数 < minVisibleChars 且 reason.kind === 'completed'」，判定为空回合 —— **没有任何 assistant 消息的 completed 回合也算空**（0 < 1），这类回合以前会漏判。
2. **补写**：延迟 `delayMs` 后通过 `agent.send(msg, 'next-turn', true)` 排一条 `plugin:empty-turn-guard` 来源的消息，让模型在下一回合补结论；若 `send` 抛错，依次降级到 `agent.followup(msg)` → `agent.inject(msg)`。消息正文明确写出「插件自动补发」，不自称普通用户输入。
3. **收尾指令**：注册一段 system prompt（name `empty-turn-guard`，order 960，`interpolate: false`），要求每回合以看得见的正文结束、禁止用零宽字符/空白/空行充当回答。
4. **防误伤**：同一回合最多补一次；补写回合再空则停止连环；每会话每小时最多 `maxNudgesPerHour` 次（按**投递成功**计，取消/失败不占额度）；定时器未触发前收到**真人消息**（`source.kind === 'user'`）立即取消，宿主每步注入的 `runtime-context` 消息不算真人；新回合自己起来时丢弃过期补写；`plugin:empty-turn-guard` 来源的消息不参与判定。

非 `completed` 的回合（`interrupted` / `error` / `aborted` / `max-tokens` / `blocked`）一律不补写。

## 安装

### 作为 profile bundle（推荐）

```jsonc
// <DSH_HOME>/profiles/<你的 profile>/package.json
{
  "dependencies": {
    "dsh-empty-turn-guard": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其他 bundle
        "dsh-empty-turn-guard"
      ]
    }
  }
}
```

然后在该 profile 目录执行安装（pnpm / npm 皆可），并重启 DSH。

> ⚠️ **只在本包自带的 `cordis.patch.yml` 里 `insert` 是不够的**：DSH 的插件图由 `dsh.profile.bundles` 里每个包各自的 `cordis.patch.yml` 组合而成，profile 根部的 `cordis.patch.yml` 只是**对已有 entry 的配置覆盖层**。没写进 bundles 时条目静默无效，也不会报错（踩过这个坑）。

### 配置（可选）

在 profile 的 `cordis.patch.yml` 里覆盖默认值：

```yaml
- id: empty-turn-guard
  name: dsh-empty-turn-guard
  config:
    enabled: true            # false = 只保留收尾指令，不补写（字符串 "false" 也认）
    injectInstruction: true  # false = 不注入 system prompt 段落
    instructionText: ''      # 非空则替换内置那段收尾指令
    minVisibleChars: 1       # 可见字符数下限（<1 按 1 处理）
    delayMs: 900             # 补写前等待（毫秒，0–60000，非法值回落 900）
    maxNudgesPerHour: 3      # 每会话每小时的补写上限（0 = 关闭补写）
    logFile: ''              # 空 = <DSH_HOME>/logs/empty-turn-guard.log
```

配置做严格解析：`maxNudgesPerHour: 0` 是**关闭补写**，不会被默认值吞成 3；`delayMs: "abc"` 这类非法值回落到默认值；`enabled: "false"`（字符串）与 `false` 等价。

## 日志

默认写到 `<DSH_HOME>/logs/empty-turn-guard.log`（未设 `DSH_HOME` 时是 `~/.dsh/logs/…`；主路径不可写时兜底到系统临时目录；超过 5 MB 自动轮转为 `.1`）：

```
[2026-10-25T01:49:13.941Z] plugin activated: pid=17520 enabled=true instruction=true dshHome=C:\Users\me\.dsh
[2026-10-25T01:49:13.942Z] prompt section registered: order=960 chars=222
[2026-10-25T01:49:13.942Z] guard armed (uptime=1ms)
[2026-10-25T01:58:02.114Z] turn/end turn=3 kind=completed steps=4 visibleChars=812 empty=false wasGuard=false [5f884825]
[2026-10-25T02:03:41.507Z] turn/end turn=4 kind=completed steps=6 visibleChars=0 empty=true wasGuard=false [5f884825]
[2026-10-25T02:03:41.508Z] nudge SCHEDULED turn=4 delay=900ms [5f884825] (empty completed turn)
[2026-10-25T02:03:42.561Z] nudge DELIVERED via send(next-turn,wakeup) [5f884825]
```

正常回合只需看 `empty=false`；出现 `empty=true` 就应紧跟一条 `nudge DELIVERED`。`[...]` 是会话 id 前 8 位，`wasGuard` 表示该回合是不是补写回合。

## 实现约束

- 只 import Node 内置模块（`node:fs` / `node:os` / `node:path` / `node:crypto`）。插件被装进 profile 的 `node_modules` 后，裸名 `@deepseek-ai/*` 在插件目录下 Node 解析不到，少一个依赖就少一个「插件整个加载失败」的风险面。
- 不导出 `Config` schema（宿主允许无 schema 的 entry），配置在 `apply(ctx, config)` 内部做防御性默认值合并。
- 所有逻辑包在 try/catch 里：任何异常只写日志，不向上抛，不会拖垮宿主回合。
- 宿主门槛 `engines.dsh = ">=0.2.1-rc.1"`：本插件用到的宿主 API 在 `0.2.1-rc.1` / `rc.2` / `rc.3` 三个版本里实现完全一致，所以门槛只设到 rc.1。**不要写成 `>=0.2.1`**——semver 里预发布版本不满足不含预发布标识的同段范围，`0.2.1-rc.3` 对 `>=0.2.1` 判为 `false`，会连 rc 版本一起挡掉。门槛不满足时宿主会把整个 bundle 静默跳过（启动只留一行 `skipping profile bundle`）。
- `inject = ['systemPrompt']` 是 cordis 的**硬依赖**，不做「可选依赖」改造：本版本 `@deepseek-ai/cordis` 的 `Inject.resolve` 只接受「数组」或「name → config 映射」，没有 `required`/`optional` 语义；写成 `{ optional: [...] }` 会被当成「等一个叫 optional 的服务」，插件将永不激活。

## License

MIT
