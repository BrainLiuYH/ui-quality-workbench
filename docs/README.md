# UI 质量工作台设计文档

这组文档记录首版范围、Skill/Plugin 形态、扩展架构和统一问题模型，作为产品设计与实现的共同基线。其中架构和蓝图包含规划内容，不能单独作为当前功能清单；实际能力边界以根目录 README 与 Skill 文档为准。

## 阅读顺序

1. [V0 产品蓝图](./v0-blueprint.md)：用户、范围、主流程、页面结构、状态和验收标准。
2. [技术架构](./architecture.md)：**规划稿**。描述 Plugin/Skill 目标结构、MCP Bootstrap、CLI、本地 Daemon、模块契约和实施顺序，不代表这些组件均已实现。
3. [统一数据模型](./data-model.md)：Project、Capture、AuditRun、Finding、Occurrence、Evidence 和生命周期。
4. [Finding Schema](./finding.schema.json) 与 [FindingOccurrence Schema](./finding-occurrence.schema.json)：Draft 2020-12 实现起点，仍需迁移、兼容性和运行时校验测试。
5. [Finding 示例](./example.finding.json) 与 [Occurrence 示例](./example.finding-occurrence.json)：一条已确认的 UI 间距问题。

## 当前 V0 决策

- 工作台首版只显示“UI 一致性走查”一个模块；
- Core 使用设计图片 + 实现截图；具体 Figma Frame 导入作为 Beta，失败时必须回退图片上传；
- 用户必须先确认两图对齐，自动分析只产生候选问题；
- 默认只导出人工确认的问题；
- UI 不暴露项目和版本管理，但数据层保留隐式 Project；
- V0 中 Finding 与 FindingOccurrence 保持 1:1；后续才启用跨运行关联；
- 当前先交付可独立安装的 Codex Skill；完整 Plugin 与其他 AI Host 的 MCP/CLI 适配保留为后续规划，不承诺通用 Skill 格式。

## 当前已实现现状

- 已实现本地图片选择与拖拽、Figma PAT 单节点图片导入、宽度等比归一化、输入可比性门槛、启发式差异候选、人工复核和清单导出。
- 已实现开发 URL 自动截图，但能力限定为使用隔离 Chromium 系浏览器截取指定尺寸的**当前视口**；它不继承登录状态，不操作页面，也不滚动拼接全页。
- 当前交付形态是可独立安装和运行的 Codex Skill；完整 Plugin、MCP/CLI 通用适配仍属于架构规划。

## V0 之后

显式项目/版本、复测、DOM/Figma 节点增强、交互体验审查和第三方任务系统均在验证首个闭环后再评估。
