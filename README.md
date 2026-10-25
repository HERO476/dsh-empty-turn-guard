# dsh-empty-turn-guard

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的**空回合保护**插件：当模型把输出预算全烧在 reasoning 上、回合结束时没有任何看得见的正文时，自动补一条 next-turn 消息让它把结论写出来；同时往系统提示注入一条「每回合必须以可见正文收尾」的规则。

## 它解决什么问题

模型偶发「思考完就结束」：`assistant/message` 的 text 块只剩一个零宽空格（U+200B）占位符，reasoning 却有好几千 token。因为 ZWSP 在长度上「非空」，宿主自带的 `EMPTY_RESPONSE` 重试判定不会触发，回合照常以 `turn/end {kind:"completed"}` 结束 —— 聊天界面上就只剩「已完成分析 / 已调用工具 / 用时 8 分 46 秒」这些过程行，**一个字都看不到**，而且这种回合在日志里是「正常完成」的，事后无法补救。

实测样本：738 个回合里 102 个是空回合（13.8%），其中绝大多数 reason 是 `completed`。

本插件在回合结束时补一道判定，把「完成但没内容」变成「完成且有内容」。

## 行为

1. **检测**：累计本回合所有 `assistant/message` 的 text 块（剥掉 `U+200B–U+200F / U+202A–U+202E / U+2060–U+2064 / U+FEFF / U+00AD` 后 trim）。`turn/end` 时若「有助手消息 且 可见字符数 < minVisibleChars 且 reason.kind === 'completed'」，判定为空回合。
2. **补写**：延迟 `delayMs` 后通过 `agent.send(msg, 'next-turn', true)` 排一条 `plugin:empty-turn-guard` 来源的消息，让模型在下一回合补结论；若 `send` 抛错，依次降级到 `agent.followup(msg)` → `agent.inject(msg)`。
3. **收尾指令**：注册一段 system prompt（name `empty-turn-guard`，order 960，`interpolate: false`），要求每回合以看得见的正文结束、禁止用零宽字符/空白/空行充当回答。
4. **防误伤**：同一回合最多补一次；补写回合再空则停止连环；每会话每小时最多 `maxNudgesPerHour` 次；定时器未触发前收到真人消息立即取消；`plugin:empty-turn-guard` 来源的消息不参与判定。

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
    enabled: true            # false = 只保留收尾指令，不补写
    injectInstruction: true  # false = 不注入 system prompt 段落
    instructionText: ''      # 非空则替换内置那段收尾指令
    minVisibleChars: 1       # 可见字符数下限
    delayMs: 900             # 补写前等待（毫秒）
    maxNudgesPerHour: 3      # 每会话每小时的补写上限
    logFile: ''              # 空 = <home>/.dsh/logs/empty-turn-guard.log
```

## 日志

默认写到 `<home>/.dsh/logs/empty-turn-guard.log`（主路径不可写时兜底到系统临时目录）：

```
[2026-10-25T01:49:13.941Z] plugin activated: pid=17520 enabled=true instruction=true
[2026-10-25T01:49:13.942Z] prompt section registered: order=960 chars=222
[2026-10-25T01:49:13.942Z] guard armed (uptime=1ms)
[2026-10-25T01:58:02.114Z] turn/end turn=3 kind=completed steps=4 visibleChars=812 empty=false
[2026-10-25T02:03:41.507Z] turn/end turn=4 kind=completed steps=6 visibleChars=0 empty=true
[2026-10-25T02:03:41.508Z] nudge SCHEDULED turn=4 delay=900ms (empty completed turn)
[2026-10-25T02:03:42.561Z] nudge DELIVERED via send(next-turn,wakeup)
```

正常回合只需看 `empty=false`；出现 `empty=true` 就应紧跟一条 `nudge DELIVERED`。

## 实现约束

- 只 import Node 内置模块（`node:fs` / `node:os` / `node:path` / `node:crypto`）。插件被装进 profile 的 `node_modules` 后，裸名 `@deepseek-ai/*` 在插件目录下 Node 解析不到，少一个依赖就少一个「插件整个加载失败」的风险面。
- 不导出 `Config` schema（宿主允许无 schema 的 entry），配置在 `apply(ctx, config)` 内部做防御性默认值合并。
- 所有逻辑包在 try/catch 里：任何异常只写日志，不向上抛，不会拖垮宿主回合。

## License

MIT
