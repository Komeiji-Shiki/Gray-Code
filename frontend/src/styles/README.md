# GrayCode 前端视觉系统

视觉系统分为三层：

1. `tokens.css`：统一间距、字号、圆角、动效、语义颜色和浮层层级。颜色令牌始终映射到 VS Code 主题变量。
2. `primitives.css`：提供低优先级的 `.gc-*` 公共样式，不覆盖组件的领域布局。
3. `components/common/`：承载可交互控件及其键盘、焦点和 ARIA 行为。

## 使用约定

- 新组件不得直接写状态色十六进制值，使用 `--gc-success / --gc-warning / --gc-danger / --gc-info`。
- 正文不小于 `--gc-font-size-body`；徽标和次要元数据不得低于 `--gc-font-size-micro`。
- 常规卡片使用 `--gc-radius-md`，控件使用 `--gc-radius-sm`，胶囊徽标使用 `--gc-radius-pill`。
- 局部绘图层级保持在 100 以下；粘性栏、浮层、模态框与启动层使用 `--gc-layer-*`。
- 可点击图标必须有可访问名称；自定义控件应优先放到 `components/common/`，不要在业务组件重复实现。
- 动画只使用统一时长和缓动，并提供 `prefers-reduced-motion` 行为。
