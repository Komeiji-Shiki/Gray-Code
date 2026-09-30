# GrayCode 前端视觉系统

视觉系统分为三层：

1. `tokens.css`：统一间距、字号、圆角、动效、语义颜色和浮层层级。桌面与 Web 平台的颜色由 `shared/appearance.ts` 的品牌色板经 `shared/appearanceTokens.ts` 写入根元素；`tokens.css` 里从 `--vscode-*` 推导的默认值只服务保留的 VS Code 宿主入口。
2. `primitives.css`：提供低优先级的 `.gc-*` 公共样式，不覆盖组件的领域布局。
3. `components/common/`：承载可交互控件及其键盘、焦点和 ARIA 行为。

## 使用约定

- 组件样式只引用 `--gc-*` 语义 token：不直接引用 `--vscode-*` 或外壳旧变量，不写十六进制色值（`FrontendSystem.test.ts` 会拦截）。缺少的颜色角色先加到 `tokens.css` 与色板。状态色使用 `--gc-success / --gc-warning / --gc-danger / --gc-info`，对应底色与描边用 `-bg / -border`。
- 正文不小于 `--gc-font-size-body`；徽标和次要元数据不得低于 `--gc-font-size-micro`。
- 平面风格，结构直角、部件小圆角：标题栏、侧栏、分栏、标签栏保持直角；徽章与标签用 `--gc-radius-xs`（4px），按钮、输入、菜单项用 `--gc-radius-sm`（6px），卡片用 `--gc-radius-md`（8px），输入区容器、弹窗与菜单用 `--gc-radius-lg`（10px），`--gc-radius-pill` 只给开关类控件；不要在页面里另写圆角数值。圆形状态指示点和头像按其用途保留。
- 配置的数值影响与使用场景应就近说明。设置说明使用正文级字号与正常行高，避免长说明仍使用过小的元数据字号。
- 局部绘图层级保持在 100 以下；粘性栏、浮层、模态框与启动层使用 `--gc-layer-*`。
- 可点击图标必须有可访问名称；自定义控件应优先放到 `components/common/`，不要在业务组件重复实现。
- 文字按钮、图标按钮、可选卡片和交互式文本分别使用 `.gc-button`、`.gc-icon-button`、`.gc-choice-card`、`.gc-link-button`；状态反馈使用 `.gc-feedback`。
- 不要用 `rgba(var(--gc-*), alpha)` 调整颜色透明度；变量值是完整颜色，应使用 `color-mix(in srgb, var(--gc-*) 10%, transparent)`。
- 新弹窗必须复用 `components/common/Modal.vue`，由公共组件负责层级、滚动锁、焦点陷阱、Escape 和焦点归还。
- 动画只使用统一时长和缓动，并提供 `prefers-reduced-motion` 行为。
