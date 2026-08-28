# 统一审查数据模型

状态：Draft
日期：2026-08-26

## 1. 模型目标

这套模型需要同时支持 UI 一致性、交互体验、可访问性、响应式和设计系统检查。核心约束是：

- 新模块可以增加 Finding 分类和扩展数据，但不能另建一套问题体系；
- 任何结论都可以追溯到某次运行、固定输入、引擎版本和证据；
- 人工审阅不能覆盖算法原始输出；
- 未来复测时保留历史观察，不用复制或覆盖 Finding；
- `severity`、`priority`、`confidence`、`evidenceLevel` 和 `reviewStatus` 各自表达不同含义。

## 2. 关系模型

```text
Project 1 ─────── * Asset
Asset 1 ───────── * AssetRevision
AssetRevision 1 ─ * Capture
Capture 1 ─────── * Artifact
Project 1 ─────── * Capture
Project 1 ─────── * Scenario
Project 1 ─────── * AuditRun
Project 1 ─────── * Finding

Asset 1 ───────── * Capture
Scenario 1 ────── * AuditRun
AuditRun 1 ────── * FindingOccurrence
Finding 1 ─────── * FindingOccurrence
FindingOccurrence * ── * Evidence
Export * ──────── * AuditRun
Export 1 ──────── * ExportItem
```

V0 的 Project 是隐式的 `local-default`，但所有记录仍带 `projectId`。

## 3. 核心对象

### 3.1 Project

一组连续审查的产品上下文。V0 不显示项目管理界面，只创建一个默认 Project。未来可增加产品、版本、发布批次和成员关系。

### 3.2 Asset

稳定的逻辑来源，例如：

- 用户上传的设计图片；
- 用户上传的实现截图；
- Figma 文件与 Frame 的外部引用。

Asset 本身保持稳定身份；内容变化创建新的不可变 AssetRevision。这样同一个 Figma Frame 或页面来源可以持续演进，同时旧 AuditRun 仍可重放和追溯。

### 3.3 AssetRevision、Capture 与 Artifact

AssetRevision 固定来源的某个版本、内容 hash 和来源时间。Capture 固定该版本在明确执行环境下的一次采集，记录：

- `assetRevisionId`；
- width、height、viewport、DPR；
- 浏览器、平台、语言、主题和测试数据集等 execution context；
- 归一化和色彩空间处理信息。

Capture 内含一个或多个不可变 Artifact。V0 只实现像素图片；后续可加入 DOM、computed style、可访问性树、视频和交互 trace。Asset 是“逻辑来源”，AssetRevision 是“来源版本”，Capture 是“某环境下的采集”，Artifact 是“采集产物”，四者不能合并。

### 3.4 Scenario

页面和状态的稳定语义身份。V0 可表示为：

```text
页面：结算页
状态：默认 / 已填写 / 校验失败
```

viewport、DPR、浏览器和数据集不属于 Scenario 身份，放在 Capture/AuditRun execution context 中。响应式变体可使用独立 `variantId`。未来交互体验模块可在 Scenario 下增加 Step 与 Transition，但不能把步骤直接塞进 Finding。

### 3.5 AuditRun

某个模块在固定输入、规则和引擎版本上的一次执行。每次重新分析都创建新 AuditRun，不覆盖旧运行。

建议状态：

```text
created → validating → ready → running → completed
                └──────────────→ failed
                         └──────→ cancelled
```

### 3.6 Finding

可在未来跨运行关联的问题身份。它保存：

- 带版本的 fingerprint candidate、identity components 和 subject；
- conclusionType，用于区分已证实缺陷、规范不一致、UX 风险、待验证和建议；
- 当前标题、分类、severity 与 priority；
- 当前 resolutionStatus 与 verificationStatus；
- firstSeen、lastSeen 和可选 latestOccurrence 指针；
- revision，用于冻结人工决策版本；
- 面向修复的建议、验收标准和人工备注。

Finding 不保存某一次截图的绝对坐标、裁剪图、差异值或检测置信度。V0 中 Finding 与 Occurrence 保持 1:1，不执行跨运行自动关联。

Schema：[finding.schema.json](./finding.schema.json)

### 3.7 FindingOccurrence

某次 AuditRun 对一个 Finding 的具体观察。它保存：

- 这次使用的 Capture；
- 空间、时间、流程或全局位置，以及预期、实际、测量值和 Evidence；
- 引擎建议的 severity、priority 和置信度；
- evidenceLevel 与检测方法；
- associationMethod 与 associationConfidence，用于和检测置信度区分；
- 人工 reviewStatus、原因和时间。

数据结构允许同一个 Finding 拥有多个 Occurrence，但 V0 不启用这种匹配行为。每个 Occurrence 只能属于一个 AuditRun。

Schema：[finding-occurrence.schema.json](./finding-occurrence.schema.json)

### 3.8 Evidence

支持某个 Occurrence 的不可变证据，例如：

- 设计图裁剪；
- 实现图裁剪；
- 叠加图和热力图；
- 像素或几何测量；
- 后续版本的 DOM、Figma Node、可访问性树或交互轨迹。

Evidence 必须记录来源 Artifact、生成方法、坐标系统和内容校验值。一段 Evidence 可以支持多个 Occurrence，因此关系按多对多实现。

### 3.9 Rule

规则定义与版本。规则决定候选问题如何产生和建议严重度，但不直接决定团队 priority。

### 3.10 Export

一次导出是不可变快照，需要记录：

- 一个或多个 AuditRun 和筛选条件；
- 每个 ExportItem 的 `{findingId, findingRevision, occurrenceId}` 快照；
- 导出格式、schemaVersion、时间和生成器版本；
- 是否包含 pending、dismissed 或 ignored 项。

V0 默认只包含 `reviewStatus=confirmed`。

### 3.11 后续状态对象

以下对象不进入 V0，但不能用现有字段草率替代：

- `FindingDecisionEvent`：记录 severity、priority、标题、建议和状态的每次人工变化；
- `Suppression`：按 rule、subject、scenario 和可选 environment 持久屏蔽，带范围与失效时间；
- `VerificationAttempt`：记录某次复测 detected / not-detected / indeterminate、目标 Run、方法和证据。

`verificationStatus=passed` 只有存在成功的 VerificationAttempt 时才允许写入；“没有生成 Occurrence”本身不能充当修复证据。

## 4. 六个容易混淆的字段

| 字段 | 回答的问题 | 主要来源 |
|---|---|---|
| `severity` | 问题本身有多严重？ | 规则或引擎建议，允许人工调整 |
| `priority` | 团队应该先处理哪个？ | 业务上下文和人工决策 |
| `confidence` | 本次判断有多可靠？ | 当前 Occurrence 的检测器 |
| `evidenceLevel` | 结论来自测量、观察还是推断？ | 当前 Occurrence 的证据来源 |
| `reviewStatus` | 人是否接受本次候选结论？ | 人工审阅 |
| `conclusionType` | 这是缺陷、风险、待验证还是建议？ | 模块建议，允许人工纠正 |

人工确认一个 `inferred` 结论后，它仍然是 inferred，只是 `reviewStatus=confirmed`。这两个维度不能合并。

## 5. 生命周期

### 5.1 Occurrence 审阅

```text
pending ─┬─→ confirmed
         ├─→ dismissed
         └─→ ignored
```

- `dismissed`：判断为误报或结论不成立；
- `ignored`：差异真实存在，但当前 Occurrence 不进入修复清单；
- dismissed 和 ignored 都必须填写原因。

分析前的 `excludedRegion`、本次误报 dismissed、本次接受差异 ignored、跨运行 Suppression 和后续 Finding `wont-fix` 是五种不同语义。

### 5.2 Finding 处理与验证

`resolutionStatus`：

```text
not-applicable → open → fixed
                    ├→ wont-fix
                    └← reopened
```

`verificationStatus`：

```text
not-requested → pending → passed
                       └→ failed
```

V0 中 resolutionStatus 固定为 `not-applicable`，verificationStatus 固定为 `not-requested`；是否导出只看当前 Occurrence 的 reviewStatus。修复和验证状态不在 V0 界面编辑。

## 6. Fingerprint 与关联策略

以下关联策略只用于后续复测版本；V0 只计算 fingerprintCandidate，不复用旧 Finding，也不对该字段建立唯一约束。未来关联优先级从高到低：

1. 稳定 DOM、组件或 Figma Node 身份；
2. Scenario + 语义标签 + 规则；
3. Scenario + 归一化空间桶 + 规则；
4. 无法可靠关联时创建新 Finding，并标记关联不确定。

建议输入：

```text
moduleId
+ ruleId or category
+ scenarioId
+ subject.anchorType
+ subject.key
```

Finding 需要保存 `fingerprintVersion`、不可变 identityComponents 和 legacyFingerprints。Occurrence 保存 observedFingerprint、associationMethod 与 associationConfidence；历史 Occurrence 的 fingerprint 不要求永远等于 Finding 的当前主 fingerprint。

不要把标题、自然语言建议、引擎置信度或绝对像素坐标放进 fingerprint；这些值会随版本和表达变化。

## 7. 一致性校验

Application Service 保存数据前至少检查：

- Occurrence 引用的 Finding、AuditRun、Capture 和 Evidence 全部存在；
- Finding 与 Occurrence 的 projectId、moduleId 一致；
- `latestOccurrenceId` 非空时必须属于该 Finding；`lastSeenRunId` 只指最后一次 detected，不等同于最后一次 evaluated；
- bbox 位于目标 Capture 边界内，normalizedBbox 的 `x + width` 和 `y + height` 不超过 1；
- `reviewStatus=ignored` 必须有 ignoreReason；
- `reviewStatus=dismissed` 必须有 dismissReason；
- V0 中 Finding 的 resolutionStatus 始终为 not-applicable，verificationStatus 始终为 not-requested；
- V0 中 `priority=p0` 时 prioritySource 必须为 human；`priority=unset` 时 prioritySource 必须为 unset；
- Evidence 和 Capture 的内容校验值不可在创建后变化；
- ExportItem 引用的 findingRevision 和 occurrence snapshot 必须可重放；
- 外部模块扩展数据必须使用命名空间，且不能覆盖核心字段。

## 8. 示例

- [example.finding.json](./example.finding.json)
- [example.finding-occurrence.json](./example.finding-occurrence.json)

示例刻意展示：问题已被人工确认，但证据仍保持 `measured`，两种状态没有混为一谈。
