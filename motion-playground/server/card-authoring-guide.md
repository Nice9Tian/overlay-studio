# Overlay Studio 卡片制作指南

## 1. 优先使用内置卡片
创建新卡片样式前，先使用 `list_effects` 查看已有卡片是否满足需求。常见可用 kind 举例：
- `punch-pill`：金句观点定格
- `term-card`：术语解释
- `checklist`：清单/步骤打勾
- `ring-metric`：环形数据指标
如果已有合适的 kind，直接调用 `create_preset` 即可，**不要轻易使用完全自定义卡片**。

## 2. 自定义卡片 (custom-card)
如果确认需要新建结构，可使用 `custom-card`。支持 HTML + CSS (通过 Shadow DOM 隔离)。
参数表：
- `theme`: "dark" | "light"
- `position`: "bottom" | "top-left" | "top-right" | "left" | "right" | "top" | "center"
- `title`, `body`: 文案数据槽
- `html`: 允许有限的 HTML。白名单：`div span p b i em strong u s small sup sub br hr h1-h4 ul ol li blockquote code pre img svg path circle rect line g text`。可用占位符 `{{title}}`, `{{body}}`, `{{accent}}`。图片 `src` 仅允许站内路径（`/` 或 `/_media/` 开头）及 `data:image/`。
- `css`: 直接写标签样式，支持 `@keyframes`。不需要写根选择器。
- `enter`: 进场动画 ("fade" | "rise" | "pop" | "none")
- `accent`: 强调色

## 3. 舞台与定位
- 画布尺寸：1920×1080。
- 安全区：人物通常在**画面中央偏下**，请尽量避免遮挡。
- 落位 (`position`)：
  - `top-left` / `top-right` / `left` / `right`：水平边距 120px，垂直边距 96px。
  - `top`：距顶 110px。
  - `bottom`：距底 120px。
  - `center`：绝对居中。

## 4. 视觉风格与可用变量
卡片样式必须使用预设的 CSS 变量，**禁止写死具体的颜色十六进制**，也**禁止 @import 外部字体**（字体会自动继承）。
以下是真实存在的可用变量：
- 颜色色板：`var(--hud-blue)`, `var(--hud-teal)`, `var(--hud-violet)`, `var(--hud-pink)`, `var(--hud-lav)`, `var(--hud-alert)`, `var(--hud-green)`, `var(--hud-orange)`
- 文字颜色：`var(--hud-ink)` (主文字), `var(--hud-muted)` (次要文字), `var(--hud-faint)` (弱文字)
- 背景与通用：`var(--hud-canvas)`, `var(--hud-node)`, `var(--hud-track)`, `var(--hud-person)`
- 玻璃质感：`var(--hud-glass)` (毛玻璃背景), `var(--hud-glass-brd)` (玻璃边框)
- 阴影：`var(--hud-sh)` (文字阴影), `var(--hud-card-sh)` (卡片外阴影)
- 动态强调色：`var(--hud-acc)` (由 `accent` 参数决定的强调色)
- 坐标微调：`var(--hud-ox)`, `var(--hud-oy)`

## 5. 动效实现
- 基础进场：通过 `enter` 参数选择内置进场效果。
- 自定义动画：在 `css` 参数中写 `@keyframes`。
- 动画触发：宿主容器在进场时会获得 `.is-in` 类。在 Shadow DOM 中，可以通过 `:host(.is-in) .my-element { animation: ... }` 来触发动画。
- 曲线与时长：动画时长建议在 0.4s – 0.8s 之间，动画曲线**必须**使用 `cubic-bezier(0.22, 1, 0.36, 1)`（禁止使用 linear）。

## 6. 完整示例
```json
{
  "kind": "custom-card",
  "params": {
    "theme": "dark",
    "position": "bottom",
    "title": "警告信息",
    "body": "请检查您的网络连接",
    "enter": "rise",
    "accent": "alert",
    "html": "<div class=\"box\">\n  <div class=\"title\">{{title}}</div>\n  <div class=\"body\">{{body}}</div>\n</div>",
    "css": ".box {\n  background: var(--hud-glass);\n  border: 1px solid var(--hud-glass-brd);\n  box-shadow: var(--hud-card-sh);\n  padding: 24px 32px;\n  border-radius: 16px;\n  border-left: 4px solid var(--hud-acc);\n  opacity: 0;\n  transform: translateY(20px);\n  transition: opacity 0.6s cubic-bezier(0.22,1,0.36,1), transform 0.6s cubic-bezier(0.22,1,0.36,1);\n}\n:host(.is-in) .box {\n  opacity: 1;\n  transform: translateY(0);\n}\n.title {\n  color: var(--hud-acc);\n  font-size: 28px;\n  font-weight: bold;\n  margin-bottom: 8px;\n}\n.body {\n  color: var(--hud-ink);\n  font-size: 22px;\n}"
  }
}
```

## 7. 创建预设
设计好卡片参数后，最后一步是调用 `create_preset` 登记预设：
- `name`：要能一眼认出用途（如“红色警告底栏”）。
- `kind`："custom-card" 或其它内置 kind。
- `params`：如上 JSON 结构中的 params。
- `description`：简短描述，说明适用场景。
