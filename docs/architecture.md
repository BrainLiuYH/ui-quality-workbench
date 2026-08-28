# UI 质量工作台 V0 技术架构

状态：Draft
日期：2026-08-26

## 1. 先纠正一个关键前提

“安装一次 Skill，就能在 Codex 和所有其他 AI 工具中运行”目前不是一个可靠前提。不同 AI Host 的 Skill 格式、工具调用方式、文件权限和浏览器能力并不统一。

因此建议把产品拆成可替换的适配层：

```text
Codex / 其他 AI Host / 人工 CLI
              │
      Plugin + focused Skills
              │
          MCP 或 CLI
              │
      Local Application Service
         ├── Domain Core
         ├── Audit Modules
         ├── Persistence
         └── Exporters
              │
         Local Web App
```

- **Codex 本地环境**：安装一个 Plugin；Plugin 内聚合 Skills、MCP Server 和启动器。
- **支持 MCP 的其他 AI Host**：连接同一个 MCP Server，另写一层轻量提示或 Skill 适配。
- **只支持命令行的 AI Host**：调用同一套 CLI。
- **没有 AI Host**：用户仍可直接启动本地服务并使用 Web App。

可移植的核心应是领域协议、MCP/CLI 和本地应用，不是某个客户端专属的 Skill 文本。

### 1.1 V0 支持矩阵

| 运行环境 | V0 支持级别 | 说明 |
|---|---|---|
| Codex Desktop / 本地 Codex | 主要验收目标 | 可以启动本地进程、调用 MCP/CLI 并打开本地工作台 |
| 独立浏览器 + CLI | 完整降级路径 | 不需要 AI Host，手动启动工作台 |
| 其他可访问本地 MCP/CLI 的 AI Host | 适配目标 | 需要单独适配和验收，不承诺仅复制 SKILL.md 就能运行 |
| ChatGPT Web 或其他云端 Agent | 不进入 V0 | 不能假设云端运行时可以访问用户电脑的 localhost；需要远程服务或安全隧道方案 |

因此首版宣传语应写“优先支持 Codex 本地环境，并提供 MCP/CLI 适配层”，而不是“支持所有 AI 工具”。

V0 通过本地或仓库 Marketplace 测试和分发，不以公共 Universal Plugin 上架为验收目标。公共分发需要另行验证远程 MCP、各产品表面能力和本机数据访问方案。

## 2. V0 运行形态

```text
Codex
  └── .mcp.json 启动本地 stdio MCP Bootstrap
          ├── workbench_status
          ├── ensureDaemon()
          │     ├── 校验受保护的 lock/state
          │     ├── 连接兼容的已有 Daemon
          │     └── 或启动当前 Plugin 自带的 Daemon
          └── 将审查工具代理给 Daemon

CLI ───────────────────→ Daemon HTTP / local control channel
Browser ───────────────→ Daemon HTTP + Web App

Daemon
  ├── Application Services 与领域核心
  ├── Audit Module Runtime
  ├── SQLite 与对象存储
  └── Web App 静态资源
```

`.mcp.json` 启动的是轻量 Bootstrap，不是依赖 Daemon 已经运行的 MCP Adapter。否则 `workbench_open` 会出现“需要先启动服务，才能调用启动服务工具”的循环依赖。

进程规则：

- Skill 永远不直接创建进程，只调用 Bootstrap 暴露的工具；
- Bootstrap 和 `ui-quality serve` 是唯一可以创建 Daemon 的入口；
- 一个 OS 用户只运行一个兼容版本的 Daemon，使用原子锁避免重复启动；
- state 文件记录 pid、port、instanceId 和 protocolVersion，仅当前 OS 用户可读；
- Bootstrap 每次先验证 pid 与 health，崩溃后遗留的 stale state 可安全替换；
- 版本不兼容且旧实例有运行中任务时返回 `DAEMON_VERSION_CONFLICT`，不能强制覆盖；
- 没有运行任务、浏览器会话或近期请求时，Daemon 可按可配置空闲时间退出；
- `workbench_open` 只返回一次性登录 URL，不假定 Host 一定能够或应该自动打开浏览器。

Skill 不应写死 `localhost:4310`。Bootstrap 负责发现或创建实例，并返回实际地址；固定端口可能冲突，也无法准确反映服务是否可用。

## 3. 推荐仓库结构

```text
ui-quality-workbench/
├── src/
│   ├── apps/workbench-web/
│   ├── services/
│   │   ├── daemon/
│   │   ├── mcp-bootstrap/
│   │   └── cli/
│   ├── packages/
│   │   ├── contracts/
│   │   ├── domain/
│   │   ├── module-sdk/
│   │   ├── visual-audit/
│   │   └── exporters/
│   └── skills/
│       ├── open-ui-workbench/
│       ├── audit-ui-implementation/
│       └── triage-ui-findings/
├── dist/
│   └── ui-quality-workbench/
│       ├── .codex-plugin/plugin.json
│       ├── .mcp.json
│       ├── skills/
│       ├── runtime/
│       │   ├── mcp-bootstrap
│       │   ├── daemon
│       │   └── ui-quality
│       └── web/
└── docs/
```

`src/` 是开发源码，`dist/ui-quality-workbench/` 才是可安装 Plugin 根目录。构建检查必须验证 manifest、Skills、`.mcp.json`、Bootstrap、Daemon 和 Web 静态资源之间的路径全部有效。

V0 不需要先搭建复杂的多语言 monorepo。优先选择一套能在 Web、HTTP、MCP 和 CLI 之间共享类型的主语言；视觉算法通过模块边界隔离，未来再按性能需要替换为 WASM、Rust 或独立进程。

## 4. Plugin 与 Skills 的职责

### 4.1 Plugin 是安装单元

Plugin 聚合以下内容：

- 三个小而明确的 Skills；
- 本地 MCP Server 和 CLI 入口；
- 工作台启动器；
- 版本、平台要求和隐私说明。

不要把完整 Web App 源码、图像分析逻辑或大段通用知识塞入 `SKILL.md`。Skill 只负责意图识别、流程编排和结果解释。

### 4.2 `open-ui-workbench`

用于“打开 UI 工作台”“继续上次走查”“查看审查记录”。它负责：

- 查询本地服务健康状态；
- 调用 `workbench_open`，由 MCP Bootstrap 启动或复用 Daemon；
- 取得实际工作台地址；仅在 Host 明确支持且用户要求时请求打开；
- 在可用时定位到指定 AuditRun。

### 4.3 `audit-ui-implementation`

用于“对比设计稿与实现截图”“做一次 UI 走查”。它负责：

- 调用工具验证设计来源和实现来源是否完整；
- 根据 MCP Server 返回的结构化结果解释 Figma 授权、Frame 和导入错误；
- 通过工具创建并运行 AuditRun；
- 输入不完整或需要人工对齐时，把用户带到向导或工作区；
- 明确区分测量、观察、推断和人工确认。

V0 只允许以下输入组合：

```text
设计：Figma Frame 或上传图片
实现：上传截图
```

### 4.4 `triage-ui-findings`

用于“查看高优问题”“忽略误报”“导出修复清单”。它负责：

- 读取和筛选候选问题；
- 在用户明确要求后更新 reviewStatus、priority 和备注；
- 批量操作前向用户展示影响范围；状态校验、权限和审计由 Local Service 强制执行；
- 默认只导出人工确认的问题。

后续的交互体验审查应新增 `audit-interaction-flow` Skill 和对应审查模块，而不是继续扩张 UI 一致性 Skill。

## 5. 统一接口层

HTTP API、MCP 和 CLI 必须调用同一组 Application Services，不能各自实现一套业务规则。

### 5.1 V0 MCP 工具

| 工具 | 作用 |
|---|---|
| `workbench_status` | 返回版本、健康状态、地址和数据目录状态 |
| `workbench_open` | Bootstrap 启动或复用 Daemon，并返回短时一次性登录 URL |
| `source_validate` | 校验 Figma Frame URL、图片、尺寸与元数据 |
| `source_import_figma_frame` | 导入具体 Figma Frame 并生成不可变 Capture |
| `source_register_upload` | 根据 Web 上传产生的 uploadId 或 Host 资源句柄生成 Capture，不接受任意本机路径 |
| `audit_create` | 保存一次审查的输入、场景、规则和 excludedRegion |
| `audit_run` | 幂等地创建异步任务，立即返回 runId、jobId 和 status |
| `audit_get` | 返回阶段、进度、摘要、警告和结构化错误 |
| `audit_cancel` | 请求取消仍在运行的任务，并保留可诊断状态 |
| `findings_list` | 分页筛选 Finding 及其当前 Occurrence |
| `finding_update` | 在服务端校验状态机后更新人工审阅、优先级、备注或原因，并写审计记录 |
| `audit_export` | V0 导出 Markdown 或 JSON；格式能力由服务端白名单控制 |

工具需要有版本化 input/output schema、稳定错误码、简洁文本摘要和分页字段。错误码至少包括 `FIGMA_AUTH_REQUIRED`、`FRAME_NOT_SPECIFIED`、`IMAGE_DECODE_FAILED`、`ALIGNMENT_REQUIRED` 和 `DAEMON_VERSION_CONFLICT`。结果不返回 Token、完整本地数据路径或非必要图片内容；即使不打开 Web UI，AI 也能完成基础查询与导出。

### 5.2 V0 CLI

```text
ui-quality serve
ui-quality status
ui-quality open
ui-quality audit create --design <file-or-figma-frame> --implementation <file>
ui-quality audit run --audit <id>
ui-quality findings list --audit <id>
ui-quality finding update <id> --review-status confirmed
ui-quality export --audit <id> --format markdown
```

CLI 是不支持 MCP 的 AI 工具、自动化脚本和人工诊断的降级路径。所有命令支持 `--json`、稳定退出码和非交互模式；stdout 只写结果，诊断写 stderr。`<file>` 只能来自用户显式参数，并执行 canonical path、符号链接、真实文件类型和大小校验。敏感凭据不能出现在进程参数或日志中。

## 6. 领域对象

V0 界面不提供项目管理，但数据层仍创建一个隐式的本地 Project。以后增加多项目和版本管理时无需迁移所有审查记录。

| 对象 | 作用 | V0 约束 |
|---|---|---|
| Project | 连续审查的产品上下文 | 只有隐式本地 Project |
| Asset | 稳定的逻辑来源，如某个 Figma Frame 或上传入口 | 版本变化产生新 AssetRevision |
| AssetRevision | 来源在某一时刻的不可变版本 | 保存来源版本、内容 hash 和时间 |
| Capture | 某个 AssetRevision 在明确环境下冻结的一组采集结果 | V0 至少包含像素 Artifact，并记录 viewport、DPR、来源和校验值 |
| Artifact | Capture 内的不可变图片、DOM、样式、视频或轨迹 | V0 只实现图片 |
| Scenario | 页面与状态的稳定语义身份 | V0 表示单页面单状态 |
| AuditRun | 某个模块在固定输入和配置上的一次运行 | 永不覆盖旧运行 |
| Finding | 可在未来跨运行关联的问题身份和当前处理状态 | V0 只保证单次 AuditRun 内稳定，不自动跨运行合并 |
| FindingOccurrence | 某次 AuditRun 对 Finding 的一次观察 | 保存坐标、证据、置信度和 reviewStatus |
| Evidence | 支撑 Occurrence 的原图、裁剪、热力图或测量 | 创建后不可变 |
| Rule | 产生候选问题的规则定义 | 保存规则和版本 |
| Export | 某时刻对筛选结果的不可变输出快照 | 记录筛选条件与 schemaVersion |

### 6.1 关系

```text
Project
├── Asset ──→ AssetRevision ──→ Capture ──→ Artifact
├── Scenario ──→ Capture pair
├── AuditRun ──→ FindingOccurrence ──→ Evidence
├── Finding ──→ FindingOccurrence (1..n)
└── Export ──→ selected Finding revision + Occurrence snapshots
```

`Asset`、`Capture`、`Artifact` 和 `Evidence` 不能混成一个对象：稳定逻辑来源、某版本与环境下的采集、采集内的图片/DOM/轨迹、以及支持结论的裁剪或测量有不同生命周期。V0 的 Capture 只有图片 Artifact，后续可增加 DOM、computed style、可访问性树、视频和交互 trace。

### 6.2 Finding 身份

Finding fingerprint candidate 建议由稳定语义构成：

```text
moduleId
+ category or ruleId
+ scenario identity
+ stable element identity
  or normalized spatial bucket when no element identity exists
```

绝对截图坐标不能单独作为 fingerprint。响应式变化、裁剪和对齐偏移会让坐标变化，但问题可能仍是同一个。

V0 只计算并保存 `fingerprintCandidate`，每个新候选都创建新的 Finding，Finding 与 Occurrence 保持 1:1。自动跨运行关联、1:n Occurrence、fixed/reopened 和复测在后续版本启用；底层字段只是兼容预留，不进入 V0 验收。

完整模型见 [data-model.md](./data-model.md)、[finding.schema.json](./finding.schema.json) 和 [finding-occurrence.schema.json](./finding-occurrence.schema.json)。

## 7. 审查模块契约

V0 使用内部静态注册表，不开放第三方动态模块市场。

```ts
interface AuditModule {
  manifest: {
    id: string;
    version: string;
    displayName: string;
    supportedInputKinds: string[];
    findingNamespaces: string[];
  };

  validate(context: AuditContext): Promise<ValidationResult>;
  prepare(context: AuditContext): Promise<PreparedAudit>;
  run(
    input: PreparedAudit,
    signal: AbortSignal
  ): AsyncIterable<AuditModuleEvent>;
}
```

`AuditModuleEvent` 至少支持 `progress`、`warning`、`occurrence-draft`、`artifact` 和 `completed`；失败通过统一错误对象结束，不能伪装成 completed。

模块通过事件产生 `FindingOccurrenceDraft`。领域核心负责：

1. 校验证据是否完整；
2. 计算或验证 fingerprintCandidate；
3. V0 为每个草稿创建新 Finding；后续版本才启用跨运行关联；
4. 保存 Occurrence 与 Evidence；
5. 维护人工修改记录。

模块必须遵守：

- 不直接写 Web UI 状态；
- 不自行定义另一套 Finding 结构；
- 每条候选 Occurrence 至少引用一条 Evidence；
- 运行配置、规则版本和引擎版本可追溯；
- 取消或失败的运行不能显示为完成；
- 相同输入与相同版本应尽可能产生稳定结果。

### 7.1 UI 一致性模块流水线

```text
输入校验
  → 图片解码与 EXIF 处理
  → 视口和尺寸归一
  → 人工确认或自动图像配准
  → excludedRegion 遮罩
  → 确定性像素差
  → 差异区域聚合
  → 规则分类与置信度计算
  → FindingOccurrenceDraft
  → 单次运行内区域去重 + 创建 1:1 Finding
  → 人工审阅
```

AI 可以辅助解释、分类和生成修复建议，但不能取代像素差、尺寸测量和证据生成，也不能把推断值写成确定测量值。

## 8. 本地持久化

```text
app-data/
├── runtime/
│   ├── daemon.lock
│   └── daemon.state
├── workbench.sqlite
├── objects/
│   └── <sha256>
└── trash/
```

- SQLite 保存元数据、状态、版本和操作历史；
- 大文件使用内容寻址对象存储，避免重复保存相同截图；
- AssetRevision、Capture、Artifact、Evidence 和 Export 创建后不可原地修改；
- 人工审阅与优先级变化写入 append-only 事件或审计表；
- Web App 的 LocalStorage 只可保存无关紧要的界面偏好，不能作为主数据源；
- schema migration 必须可回滚或先备份数据库。
- V0 默认不自动清理审查记录；用户删除后先进入本地 trash，只有显式清空时才物理删除；
- 内容寻址对象只有在没有任何活跃记录、导出或 trash 引用后才能回收；
- 数据库备份可能仍包含已删除元数据，设置页必须说明备份保留范围。

## 9. 本地安全与隐私

- V0 只绑定 `127.0.0.1` 的随机端口，不监听 `0.0.0.0`，避免双栈产生两个 Origin；
- `workbench_open` 生成短时一次性 nonce；浏览器用它换取 `HttpOnly`、`SameSite=Strict` Cookie 后立即重定向到不含 nonce 的干净 URL；
- 设置 `Referrer-Policy: no-referrer`，CORS 只允许当前工作台的实际 Origin，不使用通配符；
- MCP/CLI 使用独立的进程凭据或本地控制通道，不复用浏览器 Cookie；
- lock、state 和进程凭据文件权限限制为当前 OS 用户；
- 上传文件校验 MIME、真实文件签名、尺寸和大小上限；
- Web 上传先生成不可猜测的 uploadId，MCP 不接受任意绝对路径；对象存储拒绝 `..`、symlink 和路径替换；
- Figma 凭据放入系统凭据存储，不写入仓库、项目 JSON 或浏览器 LocalStorage；
- 外部 AI 分析默认关闭，开启前明确显示将发送整图还是裁剪区域；
- 日志默认不记录图片内容、Figma Token、完整授权 URL 或敏感查询参数；
- 导出默认写入应用导出目录；写入其他位置必须来自用户明确选择并做路径校验；
- 数据删除前列出将受影响的审查、截图和导出数量。

V0 不含 URL 自动抓取，因此暂时不承担 SSRF、登录态和浏览器自动化隔离的额外风险；这些能力进入后续版本时需要独立威胁建模。

## 10. 实施顺序

1. 固定 V0 支持矩阵、Bootstrap/Daemon 进程拓扑和本地威胁模型。
2. 创建最小 Plugin、`.mcp.json`、Bootstrap、Daemon 与 `status/open` 垂直冒烟测试。
3. 用 CLI 贯通同一 Application Service，并验证版本不匹配、端口冲突和 stale lock 恢复。
4. 固化 V0 所需领域字段、JSON Schema、错误码和数据库迁移机制。
5. 完成“上传双图 → 自动保存 → 人工查看 → 最小 JSON/Markdown 导出”的薄闭环。
6. 增加尺寸校验、有限对齐、excludedRegion、像素差、区域聚合、Evidence 和人工审阅。
7. 以 Beta 能力接入 Figma Frame 导入和授权降级路径，图片上传闭环不能依赖 Figma。
8. 完善分页、取消、审计与三个 Skills，执行安装、重启、崩溃恢复和端到端验收。

V0 之后再依次评估：开发 URL 自动截图、显式项目/版本管理、复测、DOM/Figma 节点增强、交互体验审查和第三方任务系统。

## 11. 当前架构决策

| 决策 | 原因 | 代价 |
|---|---|---|
| stdio MCP Bootstrap 启动/代理 Daemon | 消除“先有服务才能调用启动工具”的循环依赖 | 增加一个轻量常驻适配层 |
| V0 只显示一个审查模块 | 先验证完整闭环，避免空工作台 | 首版看起来不像“大平台” |
| 实现侧只上传截图 | 降低浏览器自动化、登录态和安全复杂度 | 用户需要手动截取正确状态 |
| 使用三个 focused Skills | 触发边界和职责更清楚 | 安装包内文件数量更多 |
| Project 在数据层存在、界面隐藏 | 保留未来扩展能力 | V0 存在一个用户感知不到的领域对象 |
| Finding 与 Occurrence 分离 | 保留历史证据并支持未来复测 | 查询和迁移比单表更复杂 |
| MCP、CLI、Web 共用领域核心 | 提高跨 Host 可移植性 | 需要先设计稳定协议 |

## 12. 已核实的平台事实与架构推断

以下事实已通过 2026-08-26 的 OpenAI 官方文档核实：

- Plugin 是 ChatGPT 和 Codex 可发现、安装和分发的包；
- 一个 Plugin 可以包含一个或多个 Skills、MCP Server，或两者；
- Plugin 需要 `.codex-plugin/plugin.json`，分发内置 MCP Server 时可使用 `.mcp.json`；
- Skill 是工作流指导层，MCP Server 负责实时数据、鉴权、受控动作和结构化工具结果。

参考：[Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)、[Skills](https://developers.openai.com/plugins/concepts/skills)、[Package your plugin](https://developers.openai.com/plugins/build/plugins)。

“其他 AI Host 通过 MCP 或 CLI 适配”是本项目的跨平台架构建议，不是 OpenAI 对第三方客户端兼容性的保证。
