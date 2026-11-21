# dsh-interaction · 交互增强

三块能力，一个插件，每块都能在「设置 → 交互增强」里单独开关：

1. **分支式提问**（`ask_flow`）—— 声明一张问题图，按依赖分波提问。选了 A 就只问 A 那条线，选了 B 就问 B 那条线。
2. **跨会话消息**（`session_list` / `session_send` / `session_peek`）—— 主动向另一个会话发消息并唤醒它，发完还能回读对方回复。
3. **文件支持扩展** —— 右侧边栏文档预览：音频波形 + 播放器、图片滚轮缩放 + 顺逆时针旋转、原图预览增强。

## 设置页

设置 → **交互增强**，三张卡片对应上面三块能力；功能内部的参数（跨会话的链路深度 / 每分钟限频）直接挂在各自卡片里。

**开关是拨动开关，点一下立即生效**，没有保存按钮：

- 提问、跨会话开关当场对 AI 生效（工具注销/重注册，不需要重启）。
- 文件支持开关当场切换预览渲染器，已经打开的预览面板可能需要重新打开一次。

设置存在 `~/.dsh/interaction/settings.json`。

## 安装

```sh
# 从 npm 装（装到要用的 profile，一般是 web）
dsh plugin --profile web add @philomelcc/dsh-interaction
```

本地开发时可以直接 link 一个目录：

```sh
dsh plugin --profile web add ./dsh-interaction
```

装完需要重启一次宿主（加载 Host 半），之后改代码可以用
`plugin_manager set_plugin target=include:interaction enabled=false/true` 热重载。
改了 `dsh.client` 声明或新增/删除 client.js 时，需要 `remove_bundle` + `install_bundle` 重建客户端 bundle。

> 依赖的服务：`ctx.userQuestions`（提问链路）和 `ctx.sessionController`（跨会话）都是
> web / desktop 装配层才有的能力；纯 CLI profile 里跨会话工具会给出明确报错。

## 为什么这么做

- 官方 `ask_user_question` 是「一次请求、一次答案」，问题数组里没有分支表达能力。这个插件在**同一个工具调用内多次调用官方 `ctx.userQuestions.ask()`**，逐波收答案再决定下一波问什么。
  - 好处：提问面板完全复用官方 UI，样式、多选、自定义输入、键盘操作原生一致，零前端代码，DSH 升级不易坏。
  - 代价：翻页之间面板会闪一下（官方机制是请求结束即移除卡片）。
- 官方 `ctx.sessionController.prompt()` 本来就支持「向任意会话投递 prompt 并自动 resume 冷会话」（网页切换会话发消息走的就是它）。插件只是把它包成模型能调的工具，再补上防环、限频等护栏。

## 工具

### ask_flow

```jsonc
{
  "intro": "先把部署方式定下来",   // 可选，第一张卡片顶部说明
  "steps": [
    { "id": "deploy", "question": "你打算怎么部署？", "header": "部署方式",
      "options": [{ "label": "A 本地部署" }, { "label": "B 云端部署" }] },
    { "id": "vram",  "question": "本地显存多少？", "when": { "id": "deploy", "in": ["A 本地部署"] } },
    { "id": "cloud", "question": "用哪家云？",     "when": { "id": "deploy", "in": ["B 云端部署"] } }
  ]
}
```

`when` 支持的写法：

| 写法 | 含义 |
|---|---|
| `{ id: 'q1', in: ['A'] }` | 前一步选了 A（多选时任一命中即可） |
| `{ id: 'q1', not_in: ['A'] }` | 前一步没选 A |
| `{ id: 'q1', answered: true }` | 前一步答过就问 |
| `[condA, condB]` | 多个条件同时满足 |

- 没有依赖的问题会在同一波一起问；有依赖的排到后面的波次。
- 用户自定义输入的文本也参与 `in` 匹配。
- 用户关面板 → 整条流程中止，返回 `cancelled: true` 和已经答到的部分。
- 每个问题带 `第 N 步 · 短标题` 的进度 header；第二波起的 `detail` 里会列出「目前已确认」的选项。
- **波内点选项自动跳下一题**（官方卡片行为）：一波 N 题只需最后一次提交，所以无依赖的问题尽量放同层。
- **跨波返回**：第二波起，每个问题的选项末尾会多一项「← 返回上一题」。选了它，当前波作废、退回上一波重问（重问时会提示上次选了什么）；第一波没有上一波所以不显示；最多回退 20 次。回退时会清空 skipped 缓存，让原先被跳过的分支按新答案重新判定。

### session_list / session_send / session_peek

- `session_list`：列会话（标题、id、是否运行、工作区），排除子代理会话和空会话。
- `session_send`：向目标会话投递消息。返回 `accepted`、`mode`、`depth`。
  - 走 `sessionController.resolveAgent()`（冷会话会被 resume）拿到 agent，再用 `agent.followup()` 投递。
  - 消息 source 是 `plugin:interaction`（不是 `user`），所以客户端把它渲染成**可折叠的通知卡片**（默认分支文案「收到执行请求」），一眼能区分是 AI 发的还是用户本人说的；和 dsh-plugin-memory 的做法一致。
  - `mode: 'queue'`（默认）走 `followup`（下一轮）；`mode: 'steer'` 走 `steer`（插进当前回合）。
- `session_peek`：只读目标会话最近几条消息，会过滤掉 runtime-context / time-context 这类系统注入噪声，跨会话消息标成「跨会话」角色。

投递的消息带来源标记，在目标会话里显示成一张可折叠的通知卡片（默认标题「收到执行请求」），点开是这段文本：

```
【跨会话消息 #depth=1 from=session-ab12cd34】
来自会话「交互增强」
目标工作区：C:\...

（正文）
```

## 文件支持扩展

从 `dsh-file-support` 合并进来的浏览器半侧，接的是 `dsh-client-ui-sidebar-documentpreview` 的两个扩展点：

- **音频**：右侧边栏打开 mp3 / wav / flac / ogg / m4a / aac / aiff / wma 等，显示波形 + 播放器（变速、跳转、时间轴）。
- **图片**：滚轮缩放（以光标为中心）、拖动平移、顺/逆时针 90° 旋转、适应窗口、1:1 像素。
- **原图预览增强**：点开会话里的图片时，遮罩层也支持缩放/旋转。
- **草稿附件保持**：切换会话时草稿里已附的文件不丢。

关掉这个开关时这些渲染器会被卸载，右侧预览回到 DSH 自带行为。

## 文件路径点击

会话里出现的本地文件路径（Windows 盘符路径 `C:\...`，或 UNC 路径 `\\server\share\...`）可以直接操作：

- **左键点击** → 用系统默认程序打开该文件
- **右键点击** → 菜单：打开所在目录 / 打开文件 / 复制路径
- 悬停时鼠标变成 pointer 提示可点
- 输入框、代码块里不生效；路径不存在时静默忽略（Host 会先检查存在性，不会弹系统错误框）

实现走 DSH 现成的 `sessionController.openWorkspacePath`：`action: 'reveal'` 交给文件管理器定位，
省略 action 则用操作系统默认关联打开。

## 护栏

| 闸门 | 默认值 | 说明 |
|---|---|---|
| 链路深度 | 3 | 目标会话再往外发会 +1，超过就拒绝，防两个会话无限互叫 |
| 限频 | 3 条 / 60 秒 / 每对会话 | 防止刷屏和烧 token |
| 允许跨工作区 | 是 | 用户 2026-11-17 拍板放开，不再限制同 cwd |
| 整块开关 | 开 | 设置页里对应卡片关掉即可；配置文件里的值是首次安装时的默认值 |

## 配置

运行时的开关以设置页为准，存在 `~/.dsh/interaction/settings.json`，按 profile 共用。
`cordis.patch.yml` 里的 `config.crossSession` 只作为**首次安装的默认值**（设置文件存在后以文件为准）：

```yaml
- insert:
    - id: interaction
      name: '@philomelcc/dsh-interaction'
      config:
        crossSession:
          enabled: true
          maxDepth: 3
          rateLimit: 3
```

## 测试

```sh
node --test test/flow.test.mjs test/interaction.test.mjs
```

纯逻辑（依赖解析、成环检测、波次选择）和工具层（假 ctx 跑 execute、防环、限频）都有覆盖。

## 已知限制

- 提问翻页时面板会闪一下（官方卡片机制）。
- 跨波返回要重新选一次上一波的题（官方卡片提交即结束，没法回填旧答案）。
- legacy 阻塞提问不写进 session projection，聊天记录回看只见工具结果，不见中间卡片。
- 跨会话会真的让目标会话跑一轮，消耗 token；目标会话正在跑时 queue 模式可能要排队。
- 跨会话只支持纯文本。
- 文件支持开关切换后，已经打开的预览面板可能需要重新打开（或刷新页面）才会换成新渲染器。
- 「收到执行请求」这个卡片标题来自官方 locale 的默认分支，插件无法自定义文案。
