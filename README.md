<h1 align="center">Understand Anything · DSH</h1>

<p align="center">
  <strong>Turn any codebase into an interactive knowledge graph — now for DeepSeek Harness.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek_Harness-4D6BFE" alt="DeepSeek Harness" />
  <a href="https://github.com/Egonex-AI/Understand-Anything/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License: MIT" /></a>
  <a href="https://github.com/Egonex-AI/Understand-Anything"><img src="https://img.shields.io/badge/Upstream-Understand_Anything-d4a574" alt="Upstream" /></a>
</p>

---

## 🙏 致谢 · Credits

本项目是对 **[Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)** 的 DeepSeek Harness（DSH）平台适配。

Understand-Anything 是一个卓越的代码库分析工具——它将 LLM 语义理解与 tree-sitter 静态分析相结合，生成交互式知识图谱，让你能以可视化的方式探索、搜索和提问任何项目。

> 感谢 **[Yuxiang Lin](https://github.com/Egonex-AI)** 和 **[Infinite Universe, Inc.](https://egonex.ai)** 创造并开源了这个工具。  
> 本仓库仅做平台适配工作，所有核心分析引擎、Dashboard UI、多代理管道均来自原版项目。

**如果你在使用 Understand-Anything 时解决了实际问题，请去原版仓库给一个 ⭐：**  
👉 [github.com/Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)

---

## 这是什么？

这是一个 **DSH Bundle**，将 Understand-Anything 连接到 DeepSeek Harness。

原版 Understand-Anything 支持 Claude Code、Cursor、Copilot、Codex、Gemini CLI、Devin 等平台，但**不包括 DSH**。DSH 和 Claude Code 的插件架构有本质区别：

| Claude Code | DeepSeek Harness |
|---|---|
| `hooks.json` 声明式事件 → 外部 `.mjs` 脚本 | Cordis 进程内事件监听器 |
| `PostToolUse` / `SessionStart` 事件 | `tools/result` / `agent/created` 事件 |
| stdin/stdout JSON 通信 | 直接调用 `agent.inject()` 等 API |
| `${CLAUDE_PLUGIN_ROOT}` 环境变量 | 符号链接解析 + 路径候选列表 |

这个 bundle 充当了**桥接层**——用 Cordis 事件实现了原版 hooks 的等价功能。

---

## ✨ 功能

### 已包含

| 功能 | 实现方式 |
|---|---|
| **9 个技能**（`/understand` 等） | 安装脚本自动建立 `~/.dsh/skills/` 符号链接 |
| **自动增量更新** | `tools/result` 监听 → 检测 `git commit` → `agent.inject()` 注入更新提示 |
| **知识图谱过期提醒** | `agent/created` + `agent/pre-step` → 检查 `meta.json` vs `HEAD` |
| **DeepSeek 蓝色主题** | Dashboard 默认色系：`#4D6BFE` 靛蓝替代原版金色 |
| **多平台插件根目录** | SKILL.md 中新增 `~/.dsh/skills/` 路径解析 |
| **一键安装脚本** | `curl | bash` 搞定克隆、构建、链接，最后一步在 DSH 中确认 |

---

## 🚀 安装

### 方式 1：一键安装脚本

```bash
curl -fsSL https://raw.githubusercontent.com/Macavity17/understand-anything-dsh/main/install.sh | bash
```

脚本会自动：
1. 克隆上游 [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) 到 `~/.understand-anything/repo/`
2. `pnpm install && pnpm --filter @understand-anything/core build`
3. 克隆本桥接仓库到 `~/.understand-anything/dsh-bridge/`
4. 建立 `~/.dsh/skills/understand*` 符号链接
5. 在终端打印最后一步指示

### 方式 2：让 DSH 自己安装

打开 DSH，直接把下面这句话粘贴进去：

> 请运行这条命令安装 Understand-Anything：
> `bash <(curl -fsSL https://raw.githubusercontent.com/Macavity17/understand-anything-dsh/main/install.sh)`
> 完成后，再用 plugin_manager 安装 `~/.understand-anything/dsh-bridge` 这个 bundle。

### 最后一步：激活 Bundle

脚本跑完后，在 DSH 对话中说：

```
帮我用 plugin_manager 安装 ~/.understand-anything/dsh-bridge
```

重启 DSH 或开启新会话，bundle 即会激活。之后在任意项目中：

```
/understand                    # 分析代码库
/understand-dashboard          # 打开交互式图谱
/understand-chat 支付流程怎么实现的？  # 向图谱提问
```

### 更新

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Macavity17/understand-anything-dsh/main/install.sh) --update
```

### 卸载

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Macavity17/understand-anything-dsh/main/install.sh) --uninstall
```

---

## 🔧 工作原理

```
┌─────────────────────────────────────────┐
│          DSH 会话                        │
│                                         │
│  用户: "用 understand 分析这个项目"        │
│       ↓                                 │
│  DSH 通过 ~/.dsh/skills/understand      │
│  加载 SKILL.md（符号链接 → 原版仓库）      │
│       ↓                                 │
│  AI 执行技能中的 bash/node 命令           │
│  调用原版的 project-scanner,             │
│  file-analyzer 等代理                    │
│       ↓                                 │
│  生成 .ua/knowledge-graph.json          │
│                                         │
│  ┌─ Bundle hooks (本仓库) ────────────┐ │
│  │                                     │ │
│  │  tools/result 事件                  │ │
│  │  ├─ 检测 git commit                 │ │
│  │  └─ agent.inject("请增量更新图谱")   │ │
│  │                                     │ │
│  │  agent/created 事件                 │ │
│  │  ├─ 检查 meta.json vs HEAD          │ │
│  │  └─ agent.inject("图谱已过期")       │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 与原版 CC hooks 的对应

| CC hooks.json | DSH bundle index.js |
|---|---|
| `PostToolUse` matcher `^(Bash\|exec)$` → `node post-tool-use-auto-update.mjs` | `ctx.on('tools/result')` → `if (tool_name === 'bash' && git commit)` → `agent.inject(...)` |
| `SessionStart` → `node session-start-stale-check.mjs` | `ctx.on('agent/created')` + `agent/pre-step` → `if (isStale)` → `agent.inject(...)` |
| stdin JSON → stdout `hookSpecificOutput` | 直接调用 DSH API |

---

## 📁 仓库结构

```
understand-anything-dsh/
├── README.md           ← 你正在看
├── package.json         ← DSH bundle 声明
├── cordis.patch.yml     ← Cordis 插件行定义
├── index.js             ← Host 插件：Cordis 事件监听器
├── icon.svg             ← DeepSeek 蓝色知识图谱图标
└── locale/
    ├── en.json          ← 英文插件描述
    └── zh.json          ← 中文插件描述
```

---

## 🎨 DeepSeek 蓝色主题

Dashboard 默认主题已从原版的暖金色改为 DeepSeek 蓝：

| 元素 | 原版 | DSH 版 |
|---|---|---|
| 主色调 | `#d4a574` （暖金） | `#4D6BFE` （靛蓝） |
| 暗色调 | `#c9a96e` | `#3D56E0` |
| 亮色调 | `#e8c49a` | `#7B8FF9` |
| 背景 | `#0a0a0a` | `#070b18` （深蓝黑） |
| 表面 | `#111111` | `#0d1428` |

修改位于原版仓库的：
- `packages/dashboard/src/index.css`
- `packages/dashboard/src/themes/presets.ts`
- `packages/dashboard/src/themes/types.ts`

---

## 🤝 贡献

本仓库仅做平台适配，不包含核心分析引擎。

- **Bug / 功能请求** 关于知识图谱分析 → 请提交到 [原版仓库](https://github.com/Egonex-AI/Understand-Anything)
- **Bug / 功能请求** 关于 DSH 桥接 / hooks → 请提交到本仓库 Issue
- **PR** 欢迎 — 请确保修改集中在 Cordis 事件监听器和平台适配层

---

<p align="center">
  <strong>再次感谢 <a href="https://github.com/Egonex-AI">Egonex-AI</a> 创造了 Understand-Anything。</strong>
  <br />
  <em>MIT License &copy; 原版 Yuxiang Lin and Infinite Universe, Inc. · DSH 适配 &copy; 2026</em>
</p>