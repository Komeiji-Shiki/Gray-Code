### fast-tavern API 文档（可用函数/示例/响应示例）

本项目为纯函数式“提示词组装引擎”。所有 API 均从包入口导出：

```ts
import * as FT from 'fast-tavern';
```

> 类型以 `src/core/types.ts` 为准；本文只列常用 API（你也可以直接看 `src/index.ts` 的导出）。

---

### 1) `buildPrompt(params)`（主入口）

**用途**：输入预设/世界书/正则/角色卡/历史/变量，输出**多阶段**提示词与调试信息。

**签名（概念）**：

```ts
buildPrompt(params: BuildPromptParams): BuildPromptResult
```

**示例代码**：

```ts
import { buildPrompt, History } from 'fast-tavern';

const preset = {
  name: 'Default',
  utilityPrompts: {},
  other: {},
  regexScripts: [],
  prompts: [
    { identifier: 'main', name: 'Main', enabled: true, role: 'system', content: 'Hello {{user}}', depth: 0, order: 0, trigger: [], position: 'relative' },
    { identifier: 'chatHistory', name: 'Chat', enabled: true, role: 'system', content: '', depth: 0, order: 0, trigger: [], position: 'relative' },
  ],
};

const result = buildPrompt({
  preset,
  globals: { worldBooks: [], regexScripts: [] },
  history: History.openai([{ role: 'user', content: 'Hi' }]),
  view: 'model',
  macros: { user: 'Bob' },
  variables: { score: 1 },
  outputFormat: 'openai',
  systemRolePolicy: 'keep',
});

console.log(result.stages.tagged.afterPostRegex);
console.log(result.stages.output.afterPostRegex);
```

**响应示例（摘选）**：

```json
{
  "outputFormat": "openai",
  "systemRolePolicy": "keep",
  "activeWorldbookEntries": [],
  "mergedRegexScripts": [],
  "variables": { "local": { "score": 1 }, "global": {} },
  "stages": {
    "tagged": {
      "raw": [{ "tag": "Preset: Main", "target": "slashCommands", "role": "system", "text": "Hello {{user}}" }],
      "afterPreRegex": [{ "tag": "Preset: Main", "target": "slashCommands", "role": "system", "text": "Hello {{user}}" }],
      "afterMacro": [{ "tag": "Preset: Main", "target": "slashCommands", "role": "system", "text": "Hello Bob" }],
      "afterPostRegex": [{ "tag": "Preset: Main", "target": "slashCommands", "role": "system", "text": "Hello Bob" }]
    }
  }
}
```


### 1.1) `buildPromptFromSillyTavern(params)`（旧酒馆格式包装入口）

**用途**：你直接给 SillyTavern 旧结构（preset/worldbook/regex/character/history），内部会先转换成新格式，再调用 `buildPrompt`。

**签名（概念）**：

```ts
buildPromptFromSillyTavern(params: BuildPromptFromSillyTavernParams): BuildPromptResult
```

**示例代码**：

```ts
import { buildPromptFromSillyTavern } from 'fast-tavern';

const result = buildPromptFromSillyTavern({
  preset: {
    name: 'LegacyPreset',
    prompts: [
      {
        identifier: 'main',
        name: 'Main',
        enabled: true,
        role: 'system',
        content: 'Hello {{user}}',
        injection_depth: 0,
        injection_order: 0,
        injection_trigger: [],
        injection_position: 0,
      },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    extensions: { regex_scripts: [] },
  },
  globals: {
    worldBooks: [],
    regexScripts: [],
  },
  history: [{ is_user: true, mes: 'Hi' }],
  view: 'model',
  macros: { user: 'Bob' },
  outputFormat: 'openai',
});
```

可单独使用的转换函数（均从包入口导出）：

- `convertPresetFromSillyTavern`
- `convertWorldBookFromSillyTavern`
- `convertWorldBooksFromSillyTavern`
- `convertRegexFromSillyTavern`
- `convertRegexesFromSillyTavern`
- `convertCharacterFromSillyTavern`
- `convertHistoryMessageFromSillyTavern`
- `convertHistoryFromSillyTavern`

---
---

### 2) `History.*`（构造聊天历史）

**用途**：快速创建 `ChatMessage[]`。

- `History.openai(messages)`：传 `{ role, content }` 风格
- `History.gemini(messages)`：传 `{ role, parts }` 风格
- `History.text(text)`：快捷生成一条 user(parts) 消息

示例：

```ts
import { History } from 'fast-tavern';

const h1 = History.openai([{ role: 'assistant', content: 'OK' }]);
const h2 = History.gemini([{ role: 'user', parts: [{ text: 'hi' }] }]);
const h3 = History.text('hello');
```

---

### 3) 世界书

#### 3.1 `normalizeWorldbooks(input)`

**用途**：把多文件/多形态输入归一化为 `WorldBookEntry[]`（并过滤非法条目）。

示例：

```ts
import { normalizeWorldbooks } from 'fast-tavern';

const entries = normalizeWorldbooks([
  { name: 'wb', entries: [/* WorldBookEntry[] */] },
  [/* WorldBookEntry[] */],
]);
```

#### 3.2 `getActiveEntries(params)`

**用途**：根据历史上下文激活条目（`always/keyword/vector` + probability + recursion）。

示例（vector hook）：

```ts
import { getActiveEntries, normalizeWorldbooks } from 'fast-tavern';

const globalEntries = normalizeWorldbooks(worldBooks);
const active = getActiveEntries({
  contextText: '...最近对话...',
  globalEntries,
  characterWorldBook: character?.worldBook ?? null,
  options: {
    vectorSearch: ({ entries, contextText }) => {
      // 你可以在这里接入 embedding/向量库：
      // 返回命中的 entry.index 集合
      return new Set(entries.slice(0, 1).map((e) => e.index));
    },
  },
});
```

---

### 4) 正则脚本

#### 4.1 `normalizeRegexes(input)`

**用途**：把多文件/多形态输入归一化为 `RegexScriptData[]`。

#### 4.2 `applyRegex(text, params)`

**用途**：对单条文本按 `RegexScriptData` 语义执行正则（targets/view/trim/{{match}}/macroMode/minDepth/maxDepth）。

补充语义：
- 处理顺序固定为：**宏 -> 正则**
- `replaceRegex` 每次替换得到的结果里如果含宏，会立即执行（支持 `variableContext`）
- `macroMode` 仅作用于 `findRegex`：
  - `none`: 不执行宏，按宏字面量查找
  - `raw`: 先执行宏，不转义
  - `escaped`: 先执行宏，再做正则转义

示例：

```ts
import { applyRegex } from 'fast-tavern';

const out = applyRegex('I like apple', {
  scripts: [{
    id: 't',
    name: 't',
    enabled: true,
    findRegex: 'apple',
    replaceRegex: '**{{match}}**',
    trimRegex: ['le'],
    targets: ['slashCommands'],
    view: ['model'],
    runOnEdit: false,
    macroMode: 'none',
    minDepth: null,
    maxDepth: null,
  }],
  target: 'slashCommands',
  view: 'model',
});
// out === 'I like **app**'
```

#### 4.3 `mergeRegexRules({ globalScripts, presetScripts, characterScripts })`

**用途**：拼接三类正则脚本列表（global + preset + character）。

---

### 5) 宏与变量

#### 5.1 `replaceMacros(text, options)`

**用途**：执行宏替换（包含变量宏）。

```ts
import { replaceMacros, createVariableContext } from 'fast-tavern';

const ctx = createVariableContext({ score: 1 }, {});
const out = replaceMacros('S={{getvar::score}}', { macros: { user: 'Bob' }, variableContext: ctx });
// out === 'S=1'
```

#### 5.2 `createVariableContext(local?, global?)`

**用途**：创建变量上下文（`any` 值）。

#### 5.3 `Variables.*`（对齐 wrapper 语义）

可用函数：
- `Variables.get(ctx, { name, scope? }) -> { value }`
- `Variables.list(ctx, { scope? }) -> { variables }`
- `Variables.set(ctx, { name, value, scope? }) -> { ok }`
- `Variables.delete(ctx, { name, scope? }) -> { ok }`
- `Variables.add(ctx, { name, value, scope? }) -> { ok }`
- `Variables.inc(ctx, { name, scope? }) -> { ok }`
- `Variables.dec(ctx, { name, scope? }) -> { ok }`

---

### 6) 输出转换/渠道函数

#### 6.1 `convertMessagesIn(input, format?)`

把 `openai/gemini/tagged/text` 转为内部 `ChatMessage(parts)[]`。

#### 6.2 `convertMessagesOut(internal, format)`

把内部 `ChatMessage(parts)[]` 转为 `gemini/openai/text`（`tagged` 无法逆向恢复 tag/target）。

#### 6.3 `Channels.*`

通过 `import { Channels } from 'fast-tavern'` 访问 detect/gemini/openai/tagged/text 的细粒度转换函数。

