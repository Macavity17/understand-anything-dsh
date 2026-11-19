# Understand Anything · DSH

DeepSeek Harness adapter for [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything).

## Credits and scope

Understand-Anything's analysis engine, dashboard, role definitions, deterministic helpers and multi-stage workflows are upstream work by **Yuxiang Lin / Egonex-AI and Infinite Universe, Inc.** This repository supplies a DSH Host bridge, execution guidance, installer and a reproducible DeepSeek-blue theme. It does not claim authorship of those upstream components. Please support the original project.

Redistributed theme payloads retain the upstream MIT license in [LICENSE.upstream](theme/LICENSE.upstream). The theme manifest pins upstream **v2.9.8**, commit `b861852dda79273bd9d2e01c3160d42e2df510d2`.

## Current release: 1.1.0

This revision is published on `main`, so the remote curl installer serves the same tree. Live activation after a DSH restart is still being verified; see the upgrade caveat below.

Tested runtime: DSH Desktop `0.2.2-rc.3`, Electron `44.7.0`, macOS; upstream `2.9.8`. Other DSH versions, Windows and all upstream language parsers are not certified.

### Implemented

- Host uses the actual `agents`, `tools`, `workingDirectory`, `skills` services.
- Nine independent `ua-understand*` aliases, globally contributed through `ctx.skills.registerProvider`; no changes to the user's `~/.dsh/skills` or original same-name skills.
- Original skill body, paths, resource base and invocation policies preserved. A DSH guide precedes the **complete original body**, translating role delegation and specifying the original full/incremental gates (not enforcing the model's execution).
- For projects with `config.json` `autoUpdate: true`, notices are queued after a successful synchronous shell changes Git HEAD, or when a new agent starts in a project whose saved graph commit differs (the same two moments upstream's `SessionStart` and `PostToolUse` hooks use). Staleness is never probed on every step, the analyzed commit is read from the small `meta.json` (falling back to the graph only when that file has no hash), and both reads stay cached until the files change. Notices carry the producer-owned `understand-anything-dsh` source kind that session format v4 requires, and are deduplicated per project/HEAD across sibling agents.
- Hook failures are contained: `ua_status` reports `injectErrors`, `hookErrors`, `lastError` and `duplicatesSuppressed`, and an injection refused by the Host is retried on the next check instead of being recorded as delivered.
- The notice pins the unattended branches of upstream's `hooks/auto-update-prompt.md`, which `skills/understand/SKILL.md` does not cover because it is the interactive `/understand` procedure: a missing graph/meta or an already-current commit stops instead of starting a full analysis or asking the user, and a hook never detects or persists `outputLanguage`. A skill load carries no mode flag, so the notice is the only channel that can tell the model it is running unattended.
- `ua_status` reports discovery, upstream path and graph metadata without running analysis.
- Installer prepares a pinned upstream, replays three hash-checked theme files, installs frozen dependencies and builds **core and normal dashboard**. It neither installs the bundle from shell nor starts a server.

### Important limits

- This is an instruction-preserving adapter, **not an enforced autonomous pipeline executor**. A model must follow the complete skill, read every referenced role, validate artifacts and respect failure/save gates. Adapter installation does not prove a project's full analysis or tour has completed.
- Hooks queue context for the next admitted step; they do not wake an idle agent, launch a hidden model run, or grant permission for builds/deletions. They require explicit per-project opt-in.
- HEAD detection applies to the shell's declared `workdir` (or the calling agent's session directory). Commands that switch to another repository inside shell text, and background job completions, are not directly observed; later stale checks can still notice a differing saved commit in the session project.
- Alias conflicts or incomplete initial skill discovery fail activation rather than silently overwrite another provider. A nearer preset scope can still shadow global aliases. Sessions without the skill tool cannot load them.
- Theme preimage/version mismatch is a hard error. The installer does not pull, overwrite user edits, grant build-script approval, bypass tokens, or guess compatibility.
- Build currently warns that Kotlin parser's build script is ignored and that the ELK chunk is large. Core/dashboard building successfully is not evidence that every language parser works.
- No graph, architecture, tour or lessons are fabricated during installation. The earlier shadcn demo remains a structural preview, not a complete upstream analysis.

## Install from this local checkout

Requirements: Node.js **>=22**, pnpm **>=10**, and Git for a new clone. Use a trusted checkout containing all files, not a standalone old script.

```bash
./install.sh
```

Defaults:

- Upstream: `$HOME/.understand-anything/repo`
- Bridge: directory containing this script

The DSH dependency tool may provide bundled executables. For that environment:

```bash
NODE_BIN=/absolute/path/to/node \
PNPM_SCRIPT=/absolute/path/to/pnpm.mjs \
./install.sh
```

The script prints the next AI tool action, not a fictional shell `plugin_manager` command. Ask DSH:

> Inspect installed bundles, then install this checkout with `plugin_manager` action `install_bundle`. If the old version is installed, remove **only** `@local/understand-anything-dsh` first, then install this checkout again. Report the returned activation status and verify the plugin is active and `ua-understand` can load; do not equate package installation with success.

For a nondefault upstream, configure the Host's `upstreamRoot` to the absolute **understand-anything-plugin directory**, not the repository root. The declared Config supports this field. Do not rewrite the user's complete profile patch from plugin code.

Resolution order: explicit `upstreamRoot`, `UNDERSTAND_PLUGIN_ROOT`, prepared default, resolved original skill symlink, universal plugin symlink. Unsupported explicit roots fail rather than fall back to a different checkout.

### Upgrade caveat

The old Host waited for a nonexistent `agent` service. Version 1.1.0 uses a new exported `host-v2` entry and retains a compatibility root export. Local package replacement may still require a **full DSH application restart**, not a browser refresh or merely a new session, to clear package/module resolution caches.

In this development session the reinstall returned a cached import path under the old removed working-directory checkout, while fresh Electron resolution and isolated Host activation pointed at the correct projects checkout and passed. Until the live DSH is restarted and rechecked, **live activation remains unverified**. Do not work around this by recreating the obsolete installation directory.

### Updating / removing

```bash
./install.sh --update
./install.sh --uninstall
```

`--update` means rerun preparation/build of the supported pinned version; it never does `git pull/fetch/checkout`. To upgrade versions, review new upstream changes and add a verified manifest first. `--uninstall` only prints the bundle removal instructions. It deletes no user skill, graph or repository. Bundle removal disposes its registered aliases and watchers.

## 中文快速上手

### 1. 准备上游（终端）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Macavity17/understand-anything-dsh/main/install.sh)
```

脚本会复用或克隆钉在 **v2.9.8**（commit `b861852dda79273bd9d2e01c3160d42e2df510d2`）的上游、按冻结锁文件安装依赖、构建 core 与 dashboard，然后打印下一步。它**不创建 `~/.dsh/skills` 符号链接**（技能由 bundle 的 Host 注册），也**不会自己安装 bundle**。

使用完整仓库而非下载的单独脚本时，直接在仓库里 `./install.sh`，`BRIDGE_DIR` 默认为当前仓库；单独脚本则默认把 bridge 放到 `~/.understand-anything/dsh-bridge`。

### 2. 让 DSH 安装 bundle（对话里）

把这句话发给 DSH：

```
先用 plugin_manager 的 list_bundles 看已装了什么；如果已有旧的 @local/understand-anything-dsh，
先只移除它，再用 install_bundle 安装本地目录 <你的 checkout 路径>。装完报告激活状态，
并确认 ua-understand 技能能加载；不要把"包安装成功"当成"插件已生效"。
```

上游不是默认位置时，安装后把 bundle 的 `upstreamRoot` 配成 `<UA_DIR>/understand-anything-plugin`（是 plugin 子目录，不是仓库根目录）。

### 3. 重启

**完整退出并重新打开 DSH 应用**——不是开新会话，也不是刷新浏览器。旧的模块解析缓存不清掉，新版 `host-v2` 导出不会生效。

### 4. 验证

在任意项目里让会话调用 `ua_status` 工具，应返回 `catalogComplete: true`、九个 `ua-understand*` 技能，以及 `hookDiagnostics` 字段。它只报告绑定与发现状态，**不代表某个项目已经分析完成**。

### 5. 使用

DSH 里的技能不是斜杠命令，用法是让会话加载对应技能：

```
用 ua-understand 分析当前项目
用 ua-understand-chat 回答：支付流程是怎么实现的？
用 ua-understand-dashboard 打开交互式图谱
```

自动更新默认关闭；让会话加载 `ua-understand` 并明确提供 `--auto-update` 参数，才会写入 `.ua/config.json` 的 `autoUpdate: true`。开启后，仅在 shell 真正改变了 Git HEAD、或新会话发现图谱落后于 HEAD 时注入一次提醒；它不会唤醒空闲会话，也不会自行启动模型分析。

### 更新与卸载

```bash
./install.sh --update     # 只重新准备与构建，不执行 git pull/fetch/checkout
./install.sh --uninstall  # 只打印移除 bundle 的步骤，不删除技能、图谱或仓库
```

## Usage after activation

Use the adapter aliases, not the legacy filesystem entries:

| Skill | Purpose |
|---|---|
| `ua-understand` | Full/incremental codebase analysis |
| `ua-understand-dashboard` | Original token-protected dashboard |
| `ua-understand-chat` | Graph-backed questions |
| `ua-understand-diff` | Change impact |
| `ua-understand-explain` | Explain a component |
| `ua-understand-domain` | Business/domain view |
| `ua-understand-figma` | Original Figma pipeline (requires its own services/access) |
| `ua-understand-knowledge` | Knowledge pipeline |
| `ua-understand-onboard` | Onboarding |

Example human request:

> Load `ua-understand`, then analyze `/absolute/project/path` using `--full --language zh`. Follow the entire original skill; read and pass full role definitions to DSH subagents. Do not bypass architecture, tour normalization, review or final save gates. Stop and report if a required stage fails.

Loading a skill alone does not authorize execution. Fresh child prompts must include absolute roots, language directive, complete role definition and phase inputs. File analyzers remain at most five concurrent; code lessons retain twelve-file batches. Use actual completion notices and inspected artifacts, not guessed progress.

For the dashboard, use the real generated `/?token=…` URL from its startup log. Do not set `VITE_DEMO_MODE=true` or use a plain static server as a substitute for the original protected data endpoints.

## 试运行后的加固（本地改动，尚未发布）

DeepSeek v4 Pro 的 AutoGen 全仓库试运行未通过：原始扫描结果被当成完整 scanner 结果、依赖图缺失，子代理被传入缩短的角色指令和错误输入路径，之后又自写合并器、跳过架构/导览/审查/基线保存阶段并误报成功。图谱不是一个只需修 UI 的合格产物。

新增两个**只读工具**，保留原始上游技能和确定性脚本：

- `ua_prepare_batch({projectRoot, batchIndex, plan?, mode?})`：按真实 batchIndex 读取权威批次和完整角色，返回可直接交给子代理的完整 prompt。校验扫描元数据、依赖输入、文件归属和语言；不写文件、不启动模型。`mode` 默认 `full`，普通增量明确传 `incremental`，符号修复传 `plan: "symbol-retry"`。不能从残留文件是否存在猜测本轮模式。
- `ua_validate({projectRoot, stage, batchIndexes?, plan?, mode?})`：`stage` 为 `batches` / `candidate` / `published`。每波完成后传 `batchIndexes` 先验收，再发下一波；最终合并前省略它检查全部批次。严格检查上游 schema、所有权、导入边、引用、层/导览和图谱/元数据/指纹基线；返回 `valid: false` 与具体问题，不自动补字段、删边或修图。增量及符号修复要传与 preparation 相同的 `mode` / `plan`。

这两个工具当前面向 **codebase 分析**，不是 knowledge/design/domain 的替代验收器。它们也不是强制流水线：模型仍可能忽略工具或绕过指令。因此工具/回归测试通过不等于 DeepSeek v4 Pro 再次全流程实测已通过。

另一个实际偏差：试运行启动了远端预构建 viewer，它不包含本地的 DeepSeek 蓝主题。Dashboard 的 DSH 指引现明确选择上游已有的本地 fallback，保留正常数据接口与 token 模式；不通过新建静态页面、关闭鉴权或运行 DSH 替代服务器来绕过错误。

重试时先用 `working_directory` 切换会话项目（只在 bash 中 `cd` 不会改变 hook 所用的会话工作区），明确语言 `--language zh`。中文只影响描述、摘要等人类文本，不翻译 JSON 字段、枚举、ID 或路径。大仓库先确认范围；不要根据生产 Python 文件数量估算含 .NET、前端、测试、文档的全仓库成本。

## 第二次实测后的修复（本地未发布）

较小的 autogen-core 试运行仍有偏离：完整 batch prompt 被缩短、失败验收被越过、assemble-review/代码课程被遗漏，最终没有执行 published 验收。现有图谱有 325 节点/417 边，但验收仍发现短 commit hash 与两个文件覆盖缺失；不能把它算成完整分析通过。

- 新增 `ua_prepare_dashboard({projectRoot})`：只读验证三个主题文件已经完全应用补丁（pending=0）及本地 Vite，返回精确命令。通过 managed background bash 执行本地 `scripts/start-dashboard.mjs`；无远端下载、无 shell `&`、不关闭 token。
- 通过 DSH 原生 `tools.guard` 阻止识别到的远端 UA viewer、准备后被缩短的 batch prompt、已失败波次之后的新 batch，以及未经全部批次验收的已识别 merge。已识别的后续角色同样要求完整原文。防护是有限的，不声称能阻止任意 bash 脚本绕过或强制模型执行每一阶段。
- batch prompt 渲染为原始多行文本；工具结果截断时必须读完整 spill 文件，不可重写简版。验收增加按批次/类别分组的计数及样本，避免把前50条错误当成全部错误类别。
- 使用 `scripts/extract-import-map.mjs --plugin-root <root> <input> <output>` 包装原始 helper：在确切版本/hash 下仅修正 Python import roots，解决 tests → src 布局漏连及 `import logging` 误连包内 logging。上游文件保持不变，不支持的 helper 失败关闭。
- 扫描排除本轮分析数据，Python helper 提前使用 >=3.10 的已验证解释器；阶段 ledger 明确包含 assemble-review、课程尝试和最终验收，禁止提前清理。

第二次测试只验证了本地 Dashboard 的主题资源和 token，尚未修正浏览器保存偏好对默认值的覆盖。以下是第三次反馈后的修复。

## 第三次实测：主题启动优先级与伪导览

最新试运行没有派发 architecture-analyzer、tour-builder 或 code-lesson-writer。协调代理在合并后用目录/count 脚本生成5个步骤，每个大目录取前10个节点；它不是原始导览角色的产物。输入节点也含 Module/Class/name 模板和被错误标为 file 的方法。不能靠“让导览写长一点”修好这些问题。

- 品牌 launcher 设 `VITE_DSH_THEME=deepseek`；第四个可复现主题补丁覆盖 ThemeContext。旧 gold 偏好和异步 metadata 不再覆盖品牌启动，不删除保存偏好，页面内选择仍有效。支持精确的旧三文件补丁升级；其他用户编辑先拒绝、后写入。
- `ua_prepare_phase({projectRoot,role,mode?,mergeReport?,detailedFiles?})` 返回完整角色和原始阶段模板：assemble-review、architecture/addenda、tour/README/entrypoint、≤12文件 lessons。它只准备 prompt，不跑模型、不编写课程、不发布文件；root 继续执行原始 normalization/publication。
- `subagent` 和 `subagent_fork` 均受完整 prompt / 失败 wave 防护。active full run 的 candidate/published 验收额外检查已准入的完整角色派发请求、当前 phase 文件、原始归一化层/导览一致性。源码扫描/批次内容变化会撤销旧阶段凭据。它们仍只证明有限的执行请求与产物一致性，不证明子代理完成或语义正确。
- 拒绝已知 name/count 摘要模板、伪 whole-file 方法身份、重复 whole-file 覆盖、目录/count 导览、每步超出1–5个真实 ID。不会通过填默认文案、删跨批次边或提高字数来伪造语义验收。
- 同一 active full run 的 Dashboard 准备/已识别 launcher 必须有通过的 published 验收，且 graph/meta/fingerprints/lesson 内容必须仍与该次检查一致。独立只读检查没有历史执行凭据时会明确标示 `phaseEvidence.checked:false`，不伪造证明。

现场已应用第四主题补丁、重新构建并重启品牌 Dashboard，HTTP 验证模式/资源/原图/token；测试覆盖旧gold、StrictMode、迟到metadata和手动picker。现有5步稀疏导览和原始会话均保留，没有替它生成“模型已完成”的新故事。浏览器最终画面仍需刷新确认；新工具/Host 代码仍需完整重启 DSH。

## Verification

From a source checkout:

```bash
node --test test/*.test.mjs tests/*.test.mjs
UA_PLUGIN_ROOT=/absolute/upstream/understand-anything-plugin \
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" \
  --test test/skills-dsh.mjs test/host-dsh.mjs test/contract-v4.mjs
```

Current checks: **126 isolated tests**, plus **4 installed-Electron integration/contract tests**, pass. The Host contract exercises the preparation/validation tools using the real upstream Zod schemas, including rejection of the trial's missing node fields and layer/tour collections. Integration uses the actual installed Cordis skill/tool registries and filesystem parser, checks activation, all nine byte-preserved skill bodies, metadata and cleanup. A third-party original `understand` remains untouched. Installer was also run with real dependencies and actual core/dashboard builds, not just mocked commands.

After a full DSH restart, separately verify:

1. Plugin row `understand-anything-dsh` is `active`, not `pending` or import-failed.
2. In the same/new session, load `ua-understand`; resource base must be the prepared pinned checkout, and the complete original phases must follow the DSH guide.
3. Invoke `ua_status`; check nine aliases and complete discovery. This is status, not analysis certification.
4. Run a small authorized project through the full pipeline and verify semantic nodes/edges, layers, normalized tour, lessons and save baselines. The DeepSeek v4 Pro AutoGen trial **failed**; the revised adapter still needs a fresh end-to-end model acceptance test.
5. Visually verify dashboard/theme and localized plugin metadata. Build/HTTP/unit-test success does not certify rendered UI.
