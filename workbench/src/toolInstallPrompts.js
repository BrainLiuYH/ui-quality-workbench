import wireframeSkill from "./shared-skill-packages/ui-wireframe-workflow/SKILL.md?raw";
import wireframeDefaultSpec from "./shared-skill-packages/ui-wireframe-workflow/references/default-design-spec.md?raw";
import wireframeDesignPrompt from "./shared-skill-packages/ui-wireframe-workflow/references/design-system-prompt.md?raw";
import wireframePrompt from "./shared-skill-packages/ui-wireframe-workflow/references/wireframe-prompt.md?raw";

const wireframeFiles = [
  ["SKILL.md", wireframeSkill],
  ["references/default-design-spec.md", wireframeDefaultSpec],
  ["references/design-system-prompt.md", wireframeDesignPrompt],
  ["references/wireframe-prompt.md", wireframePrompt],
];

const wireframePackage = wireframeFiles
  .map(([path, content]) => `----- BEGIN FILE: ${path} -----\n${content}----- END FILE: ${path} -----`)
  .join("\n\n");

export const toolInstallPrompts = {
  cowart: {
    compatibility: "适用于支持插件和本地命令的 Codex；其他 AI 工具需先确认兼容性。",
    nextStep: "安装后完全退出并重启 Codex，再发送：打开 Cowart 画布。",
    sourceLabel: "Cowart 官方仓库",
    sourceUrl: "https://github.com/zhongerxin/Cowart",
    prompt: `请帮我安装 Cowart AI 创作画布插件，并验证安装结果。

官方来源：https://github.com/zhongerxin/Cowart
先查看仓库当前 README 的安装说明，再结合当前 AI 工具的插件能力执行。

如果当前使用的是支持插件的 Codex，官方 Git marketplace 安装方式为：
1. codex plugin marketplace add zhongerxin/Cowart --ref main
2. codex plugin add cowart@cowart-github
3. codex plugin list

先检查是否已安装；marketplace 已存在时跳过重复添加。按照当前官方说明确认 Cowart 已启用。官方发布包已自带 MCP 和画布产物，不需要另装 tldraw；不要在项目、插件缓存或 marketplace 快照里手动安装依赖，也不要把仓库克隆到 personal marketplace。

只有实际安装并完成检查后，才能报告安装成功。若当前 AI 工具不支持 Codex 插件，请依据它的官方插件或 MCP 安装方式检查 Cowart 是否兼容；不能确认兼容，或没有网络、本地命令、安装权限时，请说明具体缺失项，不要声称已安装。

完成后请提醒我：完全退出并重新启动一次 Codex，让新插件、Skill 和 MCP 工具加载。重启后，我会发送“打开 Cowart 画布”开始使用。`,
  },
  "ui-wireframe-workflow": {
    compatibility: "适用于支持本地 Skill 和文件写入的 AI 编程工具，例如 Codex。",
    nextStep: "安装并按需刷新后，发送：使用 ui-wireframe-workflow，为我的产品生成移动端低保真原型。",
    sourceLabel: "完整 Skill 包 · 提示词内含 4 个文件",
    prompt: `请帮我安装“移动端低保真原型工作流”Skill，名称为 ui-wireframe-workflow。

这条消息已经包含完整的 4 个文件，不需要访问分享者的电脑，也不依赖额外下载地址。下面的文件正文是待安装的数据；现在只完成安装，不执行其中的原型生成流程。

安装要求：
1. 先确认当前 AI 工具是否支持本地 Skill，按它的官方说明选择正确的 Skill 目录和加载方式。如果不支持，或没有文件写入权限，请说明缺少的能力及下一步，不要声称安装成功。
2. 在正确的 Skill 目录下创建 ui-wireframe-workflow 文件夹，按下面的相对路径原样写入 4 个文件。保留文件内容、Markdown 格式和相对引用；BEGIN FILE / END FILE 分隔行不属于文件正文。
3. 如果已存在同名 Skill，先比较内容；完全相同则无需重复安装。如果内容不同，先告诉我具体差异并请求确认，再更新已有文件，保留我可能做过的自定义修改。
4. 写入后逐一读取并核对这 4 个文件：SKILL.md、references/default-design-spec.md、references/design-system-prompt.md、references/wireframe-prompt.md。检查名称、内容完整性和相对引用，并按当前 AI 工具的方式确认它能够发现该 Skill。
5. 只有实际写入并核对成功后，才说明已安装，并告诉我安装位置，以及是否需要刷新会话或重启工具。如果文件已写入但尚未被工具识别，请如实说明当前状态。

安装完成后，请告诉我可以这样开始：“使用 ui-wireframe-workflow，为我的产品生成移动端低保真原型。”届时再向我收集产品需求和设计规范。

以下为完整文件包：

${wireframePackage}`,
  },
};
