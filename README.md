# archgate · 架构闸门

一个 Claude Code mod：让 Claude 先画出项目的架构图，声明这次要改哪些模块，**你确认后才能改代码**；改到范围外的文件会被直接拦截，测试和检查的真实结果自动记录。

```
画架构图 (archgate_map) → 提交计划 (archgate_plan) → 你在面板里确认 → 只在范围内改 → 跑检查 → 收尾 (archgate_complete)
```

## 安装

在 Claude Code 终端会话里输入：

```
/plugin install archgate --marketplace aarontan-bot/Claude-mod
```

提示 `Add marketplace?` 时输入 `y`，再按 Enter 选择 user 作用域。需要 Claude Code 2.1.287 或更高版本。

本地开发时也可以直接加载这个文件夹：

```sh
claude --plugin-dir /path/to/Claude-mod
```

## 用法

直接对 Claude 说：

```
用 archgate 画出这个项目的架构，然后给登录接口加限流
```

Claude 会：

1. 读源码，调用 `archgate_map` 记录模块、每个模块负责的文件路径、源码依据（带行号）和模块间的依赖关系。
2. 调用 `archgate_plan` 声明要改的模块、文件和验证命令，然后停下来等你。
3. 你在 **archgate 面板** 里按 `确认实施`（或输入 `/archgate approve`），Claude 自动继续。
4. 改代码时，范围外的文件会被拒绝写入；Claude 必须重新提交更大的计划并再次取得确认。
5. 跑完检查后调用 `archgate_complete` 收尾。没跑过、或最后一次失败的检查会标记为 **未验证**。

### 在网页或 App 的云端会话里

面板、状态栏和提示由显示会话的客户端绘制，claude.ai 网页和 App 可能都不显示。这时：

- 输入 `/archgate` 或 `/archgate status`，面板里的内容会以文字形式显示在对话里。
- 用 `/archgate approve` 确认，用 `/archgate reject 原因` 驳回。App 发来的命令同样算你本人的操作；由其他插件或 Claude 发起的命令不算数。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/archgate` | 打开面板，并以文字显示面板内容 |
| `/archgate approve` | 确认当前计划（只有你本人在输入框里输入才算数，Claude 无法替你确认） |
| `/archgate reject <原因>` | 驳回计划，原因会告诉 Claude |
| `/archgate status` | 以文字显示面板内容 |
| `/archgate report` | 重新生成 HTML 报告 |
| `/archgate off` / `on` | 本会话暂停 / 恢复闸门 |

### 面板

```
archgate 架构闸门
shop · 第 2 版 · 6 个模块
计划 #3 · 实施中
给登录接口加限流
✗ DB  db · 1          ← 范围外改动
● Auth  auth · 2      ← 已改动
◆ API  api            ← 计划内
△ Web  web            ← 可能受影响（调用方）
检查
✓ npm test
○ npm run lint
[ 确认实施 ] [ 驳回 ] [ 生成报告 ]
```

### 设置

在 `/config` 里调整（或 settings.json 的 `pluginConfigs.archgate.options`）：

| 选项 | 取值 | 说明 |
| --- | --- | --- |
| `mode` | `on-demand`（默认）/ `auto` | 按需：提交计划后闸门才生效。自动：每次改代码都必须先有已确认的计划。 |
| `enforcement` | `block`（默认）/ `warn` / `off` | 拦截 / 只提醒（放行但告诉 Claude 和你）/ 只记录 |
| `language` | `zh`（默认）/ `en` | 面板、状态栏和报告的语言 |

## 生成的文件

都在项目的 `.archgate/` 目录下，由 mod 自己写入，Claude 不能直接编辑：

| 文件 | 内容 | 建议 |
| --- | --- | --- |
| `map.json` | 架构图：模块、归属路径、依据、依赖关系、版本号和绘制时的 git 提交 | 提交到仓库，团队共享 |
| `activity.jsonl` | 记录：每条注明是 Claude **声明**的（计划、收尾）还是 mod **观测**到的（改动、拦截、检查结果、你的确认） | 可加入 `.gitignore` |
| `report.html` | 独立 HTML 报告：架构图（按计划状态着色）、计划、实际改动、检查结果、模块表、记录。支持深浅色。 | 可加入 `.gitignore` |

## 借鉴了什么

archgate 是独立实现，没有复制下面两个项目的代码，只借鉴了思路（两者都是 MIT 许可）：

**[Qiuner/birdview](https://github.com/Qiuner/birdview)**

- 模块用文件路径声明归属，改动按归属对应到模块
- 先展示方案、等确认、再实施；同一已确认范围内不重复询问
- 区分"计划范围"和"可能受影响的模块"
- 区分 Agent 声明的内容和实际验证结果；没跑的检查就是未验证
- 按需 / 自动两种触发模式

**[tt-a1i/archify](https://github.com/tt-a1i/archify)**

- 追踪影响范围（reach）：沿依赖关系找出改动可能波及的上游调用方
- 每个结论附源码依据和行号，并在写入时核对文件和行号是否存在
- 记录绘图时的 git 提交，之后用来判断架构图是否过期
- 对比两个版本的架构图（delta）
- 生成可直接用浏览器打开的独立 HTML

**mod 独有、两个 skill 都做不到的部分**

- 真正拦截写入：birdview 自己说明了它"不是强制写入锁"，archgate 在 `Edit`/`Write`/`NotebookEdit` 执行前直接拒绝
- 自动观测：不需要 Claude 手写记录，mod 看到每一次改动和每一条检查命令的真实结果
- 确认只能由人完成：面板按钮，或你本人输入的 `/archgate approve`
- 计划和架构图摘要自动注入系统提示，不用每次让 Claude 读很长的 skill 文档
- 实时面板和状态栏

## 局限

- 只拦截 `Edit`、`Write`、`NotebookEdit`。通过 Bash 写文件（`sed -i`、`>` 重定向等）不会被拦截。
- 检查命令的成功或失败依据 Bash 工具是否报错来判断。
- 计划和确认状态只在当前会话内保存，新会话需要重新提交计划；架构图保存在 `map.json`，跨会话保留。
- 面板里的架构图是文字列表；图形版本请看 `report.html`。

## 开发

```sh
claude plugin validate .   # 检查清单和 hooks 模块
claude plugin test .       # 运行 test/ 下的测试
```

代码结构：

```
hooks/register.tsx   hooks：工具、闸门、Bash 观测、命令、面板、系统提示
hooks/lib/paths.ts   路径规范化和 glob 匹配
hooks/lib/map.ts     架构图校验、归属、影响范围、版本对比、覆盖率
hooks/lib/gate.ts    计划校验和改动判定
hooks/lib/report.ts  HTML 报告
hooks/lib/prompt.ts  注入系统提示的内容
hooks/lib/i18n.ts    中英文文案
types/index.d.ts     $.state 类型约定
```
