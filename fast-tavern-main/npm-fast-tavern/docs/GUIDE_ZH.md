### fast-tavern 使用教程（详细示例 + 输出示例）

本教程用 3 个循序渐进的例子，演示如何用 `fast-tavern` 组装提示词，并读取各阶段输出。

---

### 示例 0：最小跑通（只有 preset + history）

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
  outputFormat: 'tagged',
});

console.log(result.stages.tagged.raw);
console.log(result.stages.tagged.afterMacro);
console.log(result.stages.tagged.afterPostRegex);
```

**输出示例（关键行）**：

```json
[
  { "tag": "Preset: Main", "target": "slashCommands", "role": "system", "text": "Hello {{user}}" },
  { "tag": "History: user", "target": "userInput", "role": "user", "text": "Hi", "historyDepth": 0 }
]
```

宏后（afterMacro）：

```json
[
  { "tag": "Preset: Main", "target": "slashCommands", "role": "system", "text": "Hello Bob" }
]
```

> 说明：`afterPreRegex` 目前等同 `raw`（为了兼容阶段字段保留）。

---

### 示例 1：世界书（keyword + 插槽 positionMap）+ 注入 fixed

这个例子演示：
- `WorldBookEntry.activationMode='keyword'` 用 `key` 命中
- `position='beforeChar'` 作为插槽条目，插入到 `charBefore` 占位块之前
- `position='fixed'` 作为注入条目，按 `depth/order` 注入到 chatHistory 内

```ts
import { buildPrompt, History } from 'fast-tavern';

const preset = {
  name: 'Default',
  utilityPrompts: {},
  other: {},
  regexScripts: [],
  prompts: [
    { identifier: 'charBefore', name: 'Char Before', enabled: true, role: 'system', content: '<<CHAR_BEFORE>>', depth: 0, order: 0, trigger: [], position: 'relative' },
    { identifier: 'main', name: 'Main', enabled: true, role: 'system', content: 'MAIN', depth: 0, order: 0, trigger: [], position: 'relative' },
    { identifier: 'chatHistory', name: 'Chat', enabled: true, role: 'system', content: '', depth: 0, order: 0, trigger: [], position: 'relative' },
  ],
};

const worldBooks = [
  {
    name: 'wb',
    entries: [
      {
        index: 1,
        name: 'WB slot',
        content: 'WB_SLOT',
        enabled: true,
        activationMode: 'keyword',
        key: ['trigger'],
        secondaryKey: [],
        selectiveLogic: 'andAny',
        order: 0,
        depth: 0,
        position: 'beforeChar',
        role: null,
        caseSensitive: false,
        excludeRecursion: false,
        preventRecursion: false,
        probability: 100,
        other: {}
      },
      {
        index: 2,
        name: 'WB fixed',
        content: 'WB_FIXED',
        enabled: true,
        activationMode: 'always',
        key: [],
        secondaryKey: [],
        selectiveLogic: 'andAny',
        order: 0,
        depth: 1,
        position: 'fixed',
        role: 'system',
        caseSensitive: false,
        excludeRecursion: false,
        preventRecursion: false,
        probability: 100,
        other: {}
      }
    ]
  }
];

const result = buildPrompt({
  preset,
  globals: { worldBooks, regexScripts: [] },
  history: History.openai([
    { role: 'user', content: 'trigger: hi' },
    { role: 'assistant', content: 'ok' }
  ]),
  view: 'model',
  outputFormat: 'tagged',
  options: {
    // positionMap：把 beforeChar 插入到哪个 prompt.identifier
    positionMap: { beforeChar: 'charBefore' }
  }
});

console.log(result.stages.tagged.afterPostRegex.map((x) => x.text));
```

**输出示例（texts 视图）**：

```json
[
  "WB_SLOT",
  "<<CHAR_BEFORE>>",
  "MAIN",
  "trigger: hi",
  "WB_FIXED",
  "ok"
]
```

---

### 示例 2：正则脚本（trim/{{match}}/macroMode=escaped/minDepth）

这个例子演示：
- `trimRegex + {{match}}`
- `macroMode='escaped'`：Find Regex 里的宏值做正则转义
- `minDepth/maxDepth`：只作用于历史消息（`userInput/aiOutput`）的某个深度范围

```ts
import { buildPrompt, History } from 'fast-tavern';

const preset = {
  name: 'Default',
  utilityPrompts: {},
  other: {},
  regexScripts: [
    {
      id: 'trim',
      name: 'trim',
      enabled: true,
      findRegex: 'apple',
      replaceRegex: '**{{match}}**',
      trimRegex: ['le'],
      targets: ['slashCommands'],
      view: ['model'],
      runOnEdit: false,
      macroMode: 'none',
      minDepth: null,
      maxDepth: null
    }
  ],
  prompts: [
    { identifier: 'main', name: 'Main', enabled: true, role: 'system', content: 'I like apple', depth: 0, order: 0, trigger: [], position: 'relative' },
    { identifier: 'chatHistory', name: 'Chat', enabled: true, role: 'system', content: '', depth: 0, order: 0, trigger: [], position: 'relative' },
  ],
};

const result = buildPrompt({
  preset,
  globals: { worldBooks: [], regexScripts: [] },
  history: History.openai([{ role: 'user', content: 'hi' }]),
  view: 'model',
  outputFormat: 'tagged'
});

console.log(result.stages.tagged.afterPostRegex);
```

**输出示例（关键行）**：

```json
[
  { "tag": "Preset: Main", "target": "slashCommands", "role": "system", "text": "I like **app**" }
]
```

---

### 获取“各阶段提示词”该用哪一个？

- **做 UI 预览**：`result.stages.tagged.*`（带 tag/target/role，最直观）
- **做最终请求**：
  - `outputFormat='openai'`：取 `result.stages.output.afterPostRegex`（`{role,content}` 结构）
  - `outputFormat='gemini'`：取 `result.stages.output.afterPostRegex`（`{role,parts}` 结构）
  - 下游不接受 system：设置 `systemRolePolicy='to_user'`
- **定位是哪条规则/宏改了内容**：`result.stages.perItem`

