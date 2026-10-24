# DSH 本机快速模式插件

独立的本地 bundle，通过 DSH 的 `dsh.bundle.patch` 声明 `fast` 预设。
插件源码保存在本目录，以 `link:` 依赖接入 desktop profile，不修改应用包、内置模块或服务器。

## 行为

- 简单状态查询默认只涉及当前 DSH 会话，目标一批工具调用，最多补查一批。
- 证据足够后立即回答，不自动盘点其他客户端或扫描应用归档。
- 复杂开发、明确要求的全面调查不受上述简单查询目标限制。
- 思考强度只在请求未指定时补 `low`，保留会话显式选择。
- 第三步开始每两步通过 `agent/pre-step` 注入一次收尾提醒，新用户输入重置计数。
- 查询批次规则是提示词约束，不是强制步数上限。

当前使用的 WorkBuddy `deepseek-v4.1-flash` 不支持 `off`，因此保留默认 `low`。
支持 `off` 的其他模型可以使用界面提供的档位；本插件不覆盖该选择。

## 文件

- `cordis.patch.yml`：预设声明、工具组成和 persona，作为配置的唯一来源。
- `fast-tuning.mjs`：通过 Cordis 的 `agent/request` 接口补充缺省档位，按步骤注入收尾提醒。
- `fast-tuning.test.mjs`：验证用户选择、默认值、预设隔离、错误传播与回合提醒。
- `verification.json`：本次原始问题的前后实测统计，不包含原始会话内容。

运行 `npm test` 验证中间件。

## 本次验证

2026-10-24，使用相同问题“现在有哪些mcp服务”，模型均为
`workbuddy-global / deepseek-v4.1-flash / low`：

| 版本 | 耗时 | 模型步骤 | 工具调用 |
| --- | ---: | ---: | ---: |
| 原会话 | 155.124 秒 | 39 | 67 |
| 仅静态规则 | 32.499 秒 | 9 | 13 |
| 最终插件 | 10.103 秒 | 3 | 2 |

最终新会话日志确认规则已加载，第三步收到 `fast-mode-budget` 收尾提醒并完成回答。
6 项中间件测试通过。原会话当时尚未配置 MCP，复测时已有 chrome-devtools 配置，
因此这不是严格控制其他变量的基准测试；单次耗时不能保证所有问题都有同样表现。
此次查询已满足两批调用目标，暂未加入强制取消，避免复杂开发任务被截断。

## 安装与更新

在 DSH 的插件管理器中添加 `link:/Users/linda/code/dsh/fast-mode-config`。
插件须同时出现在 profile 的 `dependencies` 与 `dsh.profile.bundles` 中。
若已有内嵌的同名 `fast` 声明，先备份并移除旧声明，避免重复预设 ID。

本机首次安装遇到桌面内置 pnpm 11 与已有 pnpm 10 store 冲突，因此使用现有
pnpm 10 添加链接，再在 profile 的 bundle 列表注册。未修改全局 pnpm 配置。

普通应用更新不会直接改写本目录的源码；链接与 bundle 注册均保存在用户 profile。
本地目录需要持续保留，删除、移动或重建 profile 后需要重新添加链接。
DSH 仍处于预览期，升级可能改变 Cordis 接口或预设配置格式；升级后需运行测试、
重启应用并新建快速模式会话验证。此机制避免应用文件覆盖，不保证跨版本接口永远兼容。
已有会话可能继续使用创建时的预设快照，验证配置变更应新建会话。

## 回滚

优化前的 desktop profile 文件保存在 `/Users/linda/.dsh/backups/fast-mode-20261024/`。
首次迁移的完整回滚需在退出 DSH 后恢复该目录中的 `cordis.patch.yml`、`package.json`、
`pnpm-lock.yaml` 与 `fast-tuning.mjs`，再启动应用。恢复整份 profile 会撤回备份之后的其他设置，
因此有后续配置改动时应只针对本插件移除依赖、bundle 条目并恢复旧预设声明。

后续仅回滚本插件版本可使用 Git，再重启 DSH、新建会话验证。
源码仓库不保存账号、凭据、完整 profile 或原始会话。
