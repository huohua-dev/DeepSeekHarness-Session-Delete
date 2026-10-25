# DeepSeekHarness Session Delete（删除会话）

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/ansellwan/deepseekharness-session-delete)
[![npm](https://img.shields.io/npm/v/dsh-session-clean?label=npm)](https://www.npmjs.com/package/dsh-session-clean)
[![downloads](https://img.shields.io/npm/dm/dsh-session-clean?label=downloads)](https://www.npmjs.com/package/dsh-session-clean)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

DSH 有归档、重命名、分叉，却**没有删除会话**。这个插件在侧栏每个会话的 `⋯` 菜单里补上一项红色「删除会话」，点之前先弹确认框。删就是真删：不会给你留个"看起来删了、过两天又冒出来"的尾巴。

![会话菜单中的「删除会话」](https://raw.githubusercontent.com/Ansellwan/DeepSeekHarness-Session-Delete/main/docs/demo.png) ![删除确认框](https://raw.githubusercontent.com/Ansellwan/DeepSeekHarness-Session-Delete/main/docs/demo-confirm.png) ![会话运行中，删除自动置灰](https://raw.githubusercontent.com/Ansellwan/DeepSeekHarness-Session-Delete/main/docs/demo-busy.png)

## 安装

**主测试目标是 DeepSeek Harness 桌面版。** 浏览器形态的 web profile（`dsh web`）按设计应当可用——插件只用到 Web 面 API，没有任何桌面端专属调用——但**未单独实测**；Web 端用户请自行尝试，欢迎反馈结果。

```bash
# 从 npm 安装（推荐）—— 桌面版，已实测的主目标
dsh plugin --profile desktop add dsh-session-clean

# 浏览器形态 profile（dsh web）—— 按设计可用，但未单独实测
dsh plugin --profile web     add dsh-session-clean

# 从 GitHub 安装（桌面版）
dsh plugin --profile desktop add github:Ansellwan/DeepSeekHarness-Session-Delete
```

安装后**重启 DSH**（软件形态没有热刷新；`dsh web` 服务重启进程即可）。

**升级**（add 不会自动升版，须显式版本号）：

```bash
dsh plugin --profile desktop add dsh-session-clean@<新版本号>
```

**卸载**：

```bash
dsh plugin --profile desktop remove dsh-session-clean
```

## 它能做什么

- 每个会话的 `⋯` 菜单里多一项红色「**删除会话**」（排在置顶 / 重命名 / 分叉 / 归档之后）
- 会话正在干活时（回复中、等你审批 / 回答）菜单项会变淡；确认框会写明它在忙什么（回合 / 子代理 / 后台任务 / 提醒），可以选「**停止并删除**」，并且还要再确认一次
- **已归档的会话一样能删**——清库存最好用
- 删除前弹一次确认框，写明会一并删除几个子代理会话、保留几个分叉会话，确认后才动手
- 侧栏底部多一个「**清理分组**」入口：选一个分组、看清会话数量、确认一次，整组会话一次删完

## 清理整个分组

点侧栏底部的「清理分组」，选一个分组，点「清空」，整组会话一次性删掉。列表里还有一行「未分组」，装的是不属于任何分组的会话。

![清理分组面板：选一个分组，点清空](https://raw.githubusercontent.com/Ansellwan/DeepSeekHarness-Session-Delete/main/docs/demo-cleanup.png)

- 组里有会话正在跑（回复中、等你确认、子代理 / 后台任务 / 提醒），整批都不删，按钮是灰的；预检请求本身失败会单独提示，不会误报成「正在运行」
- 分组再大也能清（实测 230+ 个会话的分组），不再有 200 个的上限；子代理会话跟着各自的主会话一起删
- 已归档的会话也会一起删；行上写明「共 N 个会话 · M 个不在列表」，看到多少就删多少
- 分组本身留着，只是变成空分组。想连分组一起删，用确认框里的「清空并移除分组」；只要有一个会话没删成功，分组就**不会**被移除，并列出失败的会话
- 清理时会显示进度，结束告诉你删了几个；如果正在看的会话被删了，会自动切到同分组的新会话

![清空确认框](https://raw.githubusercontent.com/Ansellwan/DeepSeekHarness-Session-Delete/main/docs/demo-cleanup-confirm.png) ![清理完成](https://raw.githubusercontent.com/Ansellwan/DeepSeekHarness-Session-Delete/main/docs/demo-cleanup-done.png)

### 两条“删分组”的路，故意分开

官方「删除工作区」与本插件的面板做的是不同的事，本插件**从不替官方动作做决定**：

| 你做的操作 | 会话 | 分组 |
|---|---|---|
| 官方 **删除工作区** | 保留——下沉到「未分组」 | 注销 |
| 面板 → **清空** | 删除 | 保留，变成一个可以新建会话的空分组 |
| 面板 → **清空并移除分组** | 删除 | 注销 |

所以“把这个项目彻底清掉”是面板里的一个动作：选中分组 → 选「清空并移除分组」→ 确认一次（确认框仍会写明会话数量）。如果只想清掉对话、留着文件夹以后继续用，就选「清空」。

## 删除到底做了什么

1. **数据真的没了，删了找不回来**（和「归档」不一样：归档只是收起来）
2. **正开着的会话也能删**：删完侧栏里立刻就没有它了，不用重启，刷新页面也不会回来；如果删的正是你正在看的那个会话，界面会自动切到同工作区的新会话，不会停在一个已被删除的对话上
3. **万一这次删不彻底**，插件只会先把它藏起来，并且**直接告诉你**——不会假装已经删干净

## 会删掉什么，不会删什么

| | |
|---|---|
| ✅ 会删 | 这段对话本身 |
| ✅ 会删 | 它派出的**子代理会话**（任意层级；包括 `subagent_fork` 那种复制了完整父会话历史的子代理） |
| ✅ 会删 | 上面这些会话的标题 / 大纲 / token 统计等缓存（`session_projcache`），以及工具输出过长时落盘的溢出文件（spill） |
| ✅ 会删 | 它们在侧栏里的登记（分组、置顶、归档）——全部经 DSH 官方工作区注册表的公开方法修改 |
| ✅ 会删 | 绑定在这些会话上的**提醒**（未触发的和已结束的都删） |
| ❌ 不动 | 从它**分叉（fork）**出去的会话——分叉复制了前缀、自成一体，删原会话不影响它们；确认框会写明有几个 |
| ❌ 不动 | **附件不会删除**：`~/.dsh/attachments/` 里的原件按内容寻址存一份，多个会话（包括分叉）可能共用，按会话删会连累别的对话 |
| ❌ 不动 | 本插件自己的日志（`~/.dsh/logs/session-delete.log`，只记会话 id 与结果、不记标题；超过 1 MB 轮转一份） |
| ❌ 不动 | 其他插件自己抄到各自数据库里的副本 |

另外，DSH 进程退出前，内存里还会留一个空的 Agent 对象（官方没提供清理它的接口）。它不会再出现在任何列表里，重启后彻底消失。

## 常见问题

- **删了还能恢复吗？** 不能。没有回收站，也没有撤销。
- **正在回复的会话能删吗？** 默认不能，会被拦下并列出在忙什么。确认框里可以选「停止并删除」：插件走 DSH 官方归档流程先停掉回合、子代理、后台任务和提醒，等它们真正停下再删；停不下来（超时）就什么都不删，并恢复原来的置顶 / 归档状态。
- **提示"先藏起来"是什么意思？** 说明当前 DSH 版本不支持彻底移除，插件只能先把它隐藏，并如实告诉你；这一行会在**重启 DSH 后彻底消失**。插件宁可说清楚，也不会假装删成功。
- **删的时候正在看这个会话怎么办？** 能删，但删完窗口会空着，点开别的会话即可。
- **会误删别的会话吗？** 不会。只动这个会话和它的子代理会话自己的文件；分叉会话和附件都不碰。
- **删完要不要重启才生效？** 不用。
- **会联网吗？** 不会，没有任何网络请求、没有遥测。

## 权限与隐私

- 只在你自己的 DSH 进程里开一个**仅本机**可用的接口，并走 DSH 官方同一道连接信任检查，外部连不进来
- 只删这个会话（及其子代理会话）自己的文件：会话日志目录（位置取自 DSH 持久化后端的配置，默认 `~/.dsh/sessions/…`）、`~/.dsh/storages/session_projcache/…`，以及临时目录里属于它们的溢出文件目录；注册表与提醒只通过 DSH 官方服务修改
- 无网络请求、无遥测、无外部服务

## 兼容性

| | |
|---|---|
| DeepSeek Harness | 桌面版 `0.2.1-rc.3` —— 1.7.0 已实测（隔离 DSH home 端到端）。1.6.x 及更早按 `0.2.0-rc.2` 写成，在 0.2.1 上忙碌检查失效、子代理会话不删，请升级 |
| Profile | **desktop：已实测、正式支持。** Web 形态 profile（`dsh web` 浏览器形态）：按设计可用（只用到 Web 面 API，无桌面端专属调用），但**未单独实测——请自行尝试并反馈遇到的问题** |
| Node | ≥ 18（DSH 运行时自带） |
| 能力分类 | 界面与体验 |

## 技术说明（普通用户可跳过）

- **客户端半** `client.js`：向官方 slot 列表 `sidebar.workspaces.session.menu.item` 注册 `order: 500` 的菜单行（与内置 pin=100 / rename=200 / fork=300 / archive=400 同一列表，官方支持的扩展点）；忙碌状态来自宿主注入的 `useSessionStatus` 快照；确认弹窗挂在框架级 `shell.overlay` 槽位，菜单关闭不会连带销毁。
- **宿主半** `index.js`：注册私有路由 `/_dsh-session-clean`（disposer 由 `ctx.effect` 持有，可停用 / 重载），按固定顺序删除——① 用 `sessionPersistence.list()` 的会话头收集子代理子树（`origin: 'subagent'` 沿 `parentSession` 递归），分叉只计数 → ② 对子树每个会话跑官方 `workspace/session-activity`（turn / subagent / job / schedule）并看 `agent.status`，有活动就 409 → ③ `workspaceRegistry.archiveSession(id, { stopActivity })` 停活动、清置顶、冻结会话，带停止时轮询直到活动清空 → ④ 经 schedule 服务删提醒 → ⑤ 仍驻留的会话先 flush 再卸载，从叶到根 → ⑥ `WorkspaceEntity.detachSession` 移出工作区 → ⑦ 删会话目录（取自持久化后端的 `locate` / `root`）、`session_projcache` 记录、spill 目录，均有界重试 → ⑧ 删干净的会话 `unarchiveSession` 清掉归档标记。注册表**只走公开方法**：直接写存储域会被注册表的内存缓存在下一次官方写入时整体覆盖回去。
- **卸载活会话**用的是框架自己的拆除原语 `SessionStore.liveEntryFor(session).detach()`（即属主卸载时执行的同一段 `store.delete` + `session/disposed`）。该事件被会话控制器转成 `api-session/removed`，客户端据此**真的把那一行删掉**，同时关闭该会话的日志写入器，因此对话记录不会被重新落盘。`liveEntryFor` / `detachEntered` 属于内部成员（不在生成的 API catalog 里），所以每一步都先做能力探测，失败就保持官方归档状态作为「如实汇报的隐藏」（响应 `hidden: true`），不做无声的假删除，重启后由启动清理经 `unarchiveSession` 收尾。
- **投影缓存为什么必须单独处理**：它是「写回型自愈缓存」，且该域真正的表名是 `sessions`、键是完整会话 id。必须通过活动域删键（而不是只删文件），否则域内存里的那行还在，下一次检查点就会把文件重新写出来。
- 不修改 `app.asar`，不 patch 任何官方装载行，升级 DSH 不受影响。

## 许可证

MIT
