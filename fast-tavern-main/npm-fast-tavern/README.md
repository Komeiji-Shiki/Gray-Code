# fast-tavern

**Repo**: [Lianues/fast-tavern](https://github.com/Lianues/fast-tavern)

fast-tavern 是一个**与框架无关**的“提示词组装与调试引擎（prompt engine）”。

它以 `st-api-wrapper` 的**新格式字段**为准，把：
**预设（Preset）/ 世界书（WorldBook）/ 角色卡（CharacterCard）/ 正则脚本（RegexScriptData）/ 宏与变量 / 聊天历史（ChatMessage）**
按固定流程组装，并输出**可调试的多阶段结果**（便于 UI 预览与定位问题）：

- `raw`
- `afterPreRegex`（为兼容保留：当前等同 `raw`）
- `afterMacro`
- `afterPostRegex`（最终）

---

## 功能概览

- **预设组装**：`position=relative` 作为骨架；`position=fixed` 按 `depth/order` 注入到 `chatHistory`
- **世界书触发与注入**：`always/keyword/vector`（vector 通过 hook）；支持概率与递归控制
- **正则脚本**：对齐 `RegexScriptData`（targets/view/trim/{{match}}/macroMode/minDepth/maxDepth）
- **宏与变量**：宏保持简单；变量对齐 `local/global` 且值为 `any`
- **旧格式包装入口**：`buildPromptFromSillyTavern`（自动把 SillyTavern 旧结构转换为新格式后执行）
- **输出多阶段结果**：`stages.tagged/internal/output/perItem`

### system role 策略

- 引擎内部 **保留 `system` role**（不会提前降级）。
- 仅在最终输出（`output` / `stages.output.*`）可通过 `systemRolePolicy` 控制：
  - `keep`：保留 system
  - `to_user`：将 system 降级为 user（保留内容，仅改变角色）

### 变量系统

变量在宏替换阶段按照提示词顺序线性执行：

- **局部变量**：每次 `buildPrompt` 调用独立，不跨调用持久化
- **全局变量**：由调用方维护，从返回结果 `result.variables.global` 获取变化后持久化

---

## 安装

### 从 npm 安装

```bash
npm i fast-tavern
```

### 本地安装（开发期）

```bash
# 在你的项目中
npm i ../fast-tavern
```

---

## 开发与发布

### 构建

```bash
cd npm-fast-tavern
npm i
npm run build
```

### 发布到 npm

1. **更新版本号**：修改 `package.json` 中的 `version`。
2. **构建项目**：执行 `npm run build`。
3. **登录 npm**（若未登录）：`npm login`。
4. **执行发布**：`npm publish --access public`。

---

## 快速开始（最小示例）

```ts
import { buildPrompt, History } from 'fast-tavern';

const result = buildPrompt({
  preset,       // PresetInfo
  character,    // CharacterCard（可选）
  globals: {
    worldBooks,
    regexScripts
  },

  // 聊天记录（ChatMessage[]）
  history: History.openai([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi!' }
  ]),

  // 正则视图：user / model
  view: 'model',

  // 宏变量（可选）
  macros: { user: 'Bob' },

  // 变量（any）
  variables: { score: 1, cfg: { a: 1 } },

  // 输出格式：gemini/openai/text/tagged
  outputFormat: 'openai',

  // system 输出策略
  systemRolePolicy: 'keep'
});

console.log(result.stages.tagged.afterPostRegex); // UI 预览最推荐
console.log(result.stages.output.afterPostRegex); // 最终输出

console.log(result.variables.local);
```

### 旧酒馆格式直接调用（包装入口）

```ts
import { buildPromptFromSillyTavern } from 'fast-tavern';

const result = buildPromptFromSillyTavern({
  preset: legacyPresetSettings, // 旧 ST preset/settings
  character: legacyCharacter,   // 可选，旧 ST character
  globals: {
    worldBooks: legacyWorldbooks,
    regexScripts: legacyRegexes
  },
  history: legacyChat,
  view: 'model',
  outputFormat: 'openai'
});
```

如果你只想做转换，不马上构建，也可单独调用：

- `convertPresetFromSillyTavern` / `convertWorldBookFromSillyTavern`
- `convertRegexFromSillyTavern` / `convertCharacterFromSillyTavern` / `convertHistoryFromSillyTavern`


## 文档

- **格式与组装流程（详细）**：[`docs/FORMAT_ZH.md`](docs/FORMAT_ZH.md)
- **API 文档**：[`docs/API_ZH.md`](docs/API_ZH.md)
- **使用教程（详细示例）**：[`docs/GUIDE_ZH.md`](docs/GUIDE_ZH.md)

---

## License

MIT
