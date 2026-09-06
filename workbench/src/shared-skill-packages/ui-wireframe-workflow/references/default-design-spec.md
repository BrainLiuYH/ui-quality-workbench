# 默认 APP UI 设计规范（内置 · 线框阶段）

当用户没有提供完整设计规范时，**直接采用本规范**作为 `docs/design-system.md` 的基础。
本规范覆盖尺寸 / 布局、字体、间距、圆角、图标、线框灰阶色与基础组件规则。

> **本规范面向低保真线框图。** 使用灰阶色表达结构与层级，不收集、不定稿品牌色。品牌配色留给后续高保真流程（如 `ui-design-workflow`）。

---

## 1. 画板与布局（尺寸规范）

```yaml
artboard:
  width: 375px          # 设计基线宽度
  height: 812px         # 设计基线高度
  border: 1px solid #ccc  # 模拟手机边框（展示用）
system_bars:
  status_bar: 44px      # iOS 状态栏（9:41 / 信号 / 电池）
  nav_bar: 44px         # 顶部导航栏
  tab_bar: 50px         # 底部标签栏
  home_indicator: 34px  # 底部页面指示器（安全区）
page_padding:
  default: 14px         # 页边距，可在 8px–24px 间调整
```

## 2. 字体（字体规范）

```yaml
font_family:
  ios:
    zh: "PingFang SC"
    en: "SF UI Text"
  android:
    zh: "Source Han Sans SC"   # 思源黑体
    en: "Roboto"
  stack: '"PingFang SC", "Source Han Sans SC", "Noto Sans SC", system-ui, sans-serif'
rules:
  - 使用系统默认字体，禁用自定义字体；字号为 1 倍图尺寸。
  - 字号优先取 4 的偶数倍，特殊场景可调；金融产品数字重点突出。
  - 文案长短适中，避免过长 / 过短。
type_scale:
  - { name: 主标题 H1,        size: 24px, weight: Medium }
  - { name: 一级标题/导航标题 H2, size: 18px, weight: Medium }
  - { name: 二级标题/重要信息 H3, size: 16px, weight: Medium }
  - { name: 正文 Body,        size: 14px, weight: Medium }
  - { name: 辅助信息 Caption,  size: 12px, weight: Medium }
  - { name: 最小字体/底部标签, size: 10px, weight: Medium }
```

## 3. 间距（8px 基数体系）

```yaml
spacing:
  xs: 4px    # 内边距：小组件内部留白
  sm: 8px    # 组件间距：同类组件分隔（商品/订单列表），2 倍基数
  md: 12px   # 板块间距：不同板块、同组件大块分隔（如"我的"页分区）
  lg: 16px   # 大间距：模块严格分区，使用频次低
  xl: 24px   # 页面/模块间距：信息量大场景，组件强分隔
```

## 4. 圆角（五级梯度）

```yaml
radius:
  full: 9999px  # 全圆(50%)：头像、圆形图标
  xs: 4px       # 微圆角：小字标签、迷你按钮、短输入框
  sm: 8px       # 标准圆角：卡片、弹窗对话框、主行动按钮、常规表单输入框
  md: 12px      # 进阶圆角：中型独立功能模块、分区容器
  lg: 16px      # 大圆角：页面顶层容器、完整弹窗面板、大面积复合图层
apply:
  card: 8px
  dialog: 8px
  popup_layer: 16px
  primary_button: 8px
  input: 8px
```

## 5. 图标（图标规范）

```yaml
icon:
  style: 线性图标（line / outline），视觉重心居中
  principles:
    - 安全区域：图标四周预留空间，避免被文案或其他元素挤压。
    - 裁剪区域：按图标实际边界裁剪导出。
    - 视觉中心：图标视觉重心居中，保证界面平衡美观。
  sizes:
    tab_bar: 24x24px / 32x32px        # 底部标签栏 Tab 图标
    common_function: 16x16px / 24x24px # 通用功能小图标
    modal_empty_action: 自由尺寸（建议 ≤ 120x120px） # 弹窗/空白页/操作图标
    splash_onboarding: 64x64px / 80x80px # 启动页/引导页图标
note: 功能性图标用 FontAwesome / 内联 SVG（线性）；图片位用灰底占位块或简单 SVG，不追求真实摄影图。
```

## 6. 组件基础规则

依据上方令牌派生组件样式：

```yaml
Button:
  radius: 8px            # 主行动按钮；迷你按钮可用 4px
  min_touch: 44px        # 主要移动控件点击区不小于 44px
Card:
  radius: 8px
  padding: 12px–16px
Input:
  radius: 8px            # 短输入框可用 4px
Dialog:
  radius: 8px
Popup/BottomSheet:
  radius: 16px
TabBar:
  height: 50px
  icon: 24x24px（激活态明显区分）
  label: 10px
```

## 7. 颜色（线框灰阶 · 本阶段即用）

```yaml
colors:
  purpose: 低保真线框结构表达，非品牌定稿
  palette:
    bg-100: "#FFFFFF"      # 主背景
    bg-200: "#F5F5F5"      # 次级背景 / 分区底
    bg-300: "#EEEEEE"      # 图片占位 / 弱区块
    text-100: "#111111"    # 主文字
    text-200: "#666666"    # 次文字
    text-300: "#999999"    # 辅助 / 禁用
    border: "#CCCCCC"      # 描边 / 分割线
    ink: "#000000"         # 强调描边 / 激活态
    fill-strong: "#333333" # 主按钮填充（线框感）
    fill-muted: "#E0E0E0"  # 次按钮 / 标签底
  note: 落地为 :root CSS 变量；保持黑白线框感，避免引入品牌彩色。
```
