# 安全与可靠性问题修复说明

## 1. 文档目的

本文整理本轮审计确认的问题、影响范围、根因、建议修复方式、测试要求和最终验收标准。所有事项均已修复完成并通过验证，最终状态见第 23 节。

本轮目标包括：

1. 消除 `fast-xml-parser` 已知严重漏洞，并保持 XML 工具调用的原有解析语义。
2. 修复批量工具部分成功时，成功结果无法传给模型的问题。
3. 更新 XML 工具模式中过时的调用示例。
4. 修复失效的 VS Code 测试调试配置。
5. 修复 Sub-Agent 注册、执行器调用和对话接续边界问题。
6. 处理 `node-notifier` 引入的 `uuid` 生产依赖告警。
7. 为所有修改增加回归测试，并完成类型检查、构建和生产依赖审计。

---

## 2. 当前工作区状态

在本文创建前，已经执行：

```powershell
npm install fast-xml-parser@5.10.1 --save
```

因此当前已经发生以下依赖层变更：

- `package.json` 中的 `fast-xml-parser` 已升级到 `^5.10.1`。
- `package-lock.json` 已重新生成对应依赖树。
- 本地 `node_modules` 中实际安装版本为 `fast-xml-parser@5.10.1`。

当前还不能把该事项视为修复完成，原因如下：

- XML 解析器尚未增加禁用自定义实体处理的防御配置。
- 尚未完成升级后的 XML 解析、校验、CDATA、属性和数字字符串回归测试。
- `pnpm-lock.yaml` 尚未同步。
- 尚未完成最终 `npm audit --omit=dev`、类型检查和构建验证。

除上述依赖安装产生的文件变更外，本文创建前尚未修改业务源码。

---

## 3. 问题总览

| 编号 | 优先级 | 问题 | 当前结论 |
| --- | --- | --- | --- |
| F-01 | 高 | `fast-xml-parser@4.5.3` 存在 Critical、High、Moderate 漏洞 | ✅ 已修复：依赖 5.10.1 + `processEntities: false` / `maxNestedTags: 100` + 危险键过滤 + 安全输入测试 |
| F-02 | 高 | 批量工具部分失败时，LLM 只能看到顶层错误 | ✅ 已修复：共享序列化器错误分支保留 `data.results`/`data.message`/批量统计，新增 10 项回归测试 |
| F-03 | 高 | XML 工具指南中的 `read_file`、`write_file` 示例过时 | ✅ 已修复：指南与 XML/JSON 测试夹具更新为真实 schema |
| F-04 | 中 | `.vscode/launch.json` 的 `Extension Tests` 指向不存在的入口 | ✅ 已修复：替换为可运行的 Jest 调试配置 |
| F-05 | 中 | `SubAgentRegistry.isEnabled()` 将未注册代理判断为启用 | ✅ 已修复：未注册代理返回 false，新增 registry 单元测试 |
| F-06 | 中/高 | `continueFromRunId` 未校验当前对话归属 | ✅ 已修复：接续前校验 conversationId 归属，跨对话拒绝且不泄漏信息 |
| F-07 | 中 | `node-notifier` 传递依赖 `uuid@8.3.2` 触发生产审计告警 | ✅ 已修复：改为 VS Code 原生通知适配器，移除直接依赖，生产审计归零 |
| F-08 | 中 | Registry 注册的自定义 Sub-Agent executor 被正式调用路径忽略 | ✅ 已修复：正式路径优先调用显式注册 executor，request 透传动态会话上下文 |
| F-09 | 中 | 已持久化的 Sub-Agent run 在重载或内存淘汰后无法接续 | ✅ 已修复：内存未命中时只加载当前对话持久化快照，恢复后仍做归属/终态校验 |
| F-10 | 中 | 全部配置代理禁用但 General Worker 启用时，`subagents` 工具可能整体被隐藏 | ✅ 已修复：两处声明过滤统一 `hasAvailableSubAgent()` 判断 |
| F-11 | 低 | npm 与 pnpm 锁文件中的 XML 解析器版本曾经不一致 | ✅ 已修复：两份锁文件均锁定 `fast-xml-parser@5.10.1` |

---

## 4. F-01：`fast-xml-parser` 严重安全漏洞

### 4.1 证据与调用链

项目会解析模型或兼容服务生成的 XML 工具调用：

- `backend/tools/xmlFormatter.ts` 创建 `XMLParser`。
- `backend/tools/xmlFormatter.ts` 的 `parseXMLToolCalls()` 将提取出的 `<tool_use>` 内容交给 `xmlParser.parse()`。
- `backend/tools/promptToolParser.ts` 的失败诊断路径调用 `XMLValidator.validate()`。

旧的实际安装版本为：

```text
fast-xml-parser@4.5.3
```

审计报告包含以下类别的已知漏洞：

- DOCTYPE 实体名称正则注入。
- XML 实体递归或膨胀造成拒绝服务。
- 数字实体绕过膨胀限制。
- XMLBuilder 注入问题。

虽然项目当前没有调用 `XMLBuilder`，但解析器和校验器处理的内容来自模型输出，不能视为可信输入。

### 4.2 5.10.1 API 核验结论

本地安装的 `fast-xml-parser@5.10.1` 公开 `XMLParser` API 仍保留项目正在使用的配置：

- `ignoreAttributes`
- `attributeNamePrefix`
- `textNodeName`
- `parseAttributeValue`
- `parseTagValue`
- `trimValues`

因此不需要改用包内实验性的 v6 解析器，也不需要重写现有 XML 参数处理逻辑。

5.10.1 还提供了以下安全相关配置：

- `processEntities`
- `maxNestedTags`
- 自定义实体数量、展开次数和展开长度限制

项目的 XML 工具调用协议不需要 DOCTYPE 或自定义实体，所以没有必要允许解析这些内容。

### 4.3 建议修复

#### 依赖升级

正式依赖固定为：

```json
"fast-xml-parser": "^5.10.1"
```

同步更新：

- `package-lock.json`
- `pnpm-lock.yaml`

#### 解析器防御配置

保留原有字符串语义，并关闭工具协议不需要的自定义实体处理：

```ts
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    processEntities: false,
    maxNestedTags: 100
});
```

其中：

- `parseTagValue: false` 防止 `"1.10"` 变成 `1.1`。
- `parseAttributeValue: false` 防止属性值被自动转换。
- `processEntities: false` 禁止处理工具协议不需要的 DOCTYPE 自定义实体。
- `maxNestedTags` 为模型输出增加嵌套深度限制。

建议在进入解析器前明确拒绝 `<DOCTYPE`、`<!ENTITY` 一类声明。这样即使未来解析器配置发生变化，工具协议仍不会接受不属于协议的 XML 功能。

### 4.4 不建议的方案

不建议仅在调用点捕获异常后返回空结果。该做法不能阻止 CPU 或内存消耗型攻击，也会掩盖安全问题。

不建议继续保留 4.x 并依赖输入“通常来自模型”这一假设。兼容服务、提示词注入和模型输出都可能产生恶意或异常 XML。

### 4.5 测试要求

需要覆盖：

1. 普通 `<tool_use>` 解析。
2. `tool_name` 或参数节点带属性。
3. CDATA 中包含 `</tool_use>`。
4. `"1.10"`、`"007"`、纯数字文件内容保持字符串。
5. 批量对象数组仍能往返。
6. `XMLValidator.validate()` 的错误对象仍包含 `err.msg` 和 `err.line`。
7. DOCTYPE 和自定义实体不会被展开。
8. 超深嵌套输入被拒绝或安全失败。
9. 现有 XML 工具解析测试全部通过。

### 4.6 验收标准

- `npm ls fast-xml-parser` 只显示 5.10.1 或更高安全版本。
- `npm audit --omit=dev` 不再报告 `fast-xml-parser` 漏洞。
- XML 解析测试全部通过。
- 数字字符串没有发生自动类型转换。
- DOCTYPE 自定义实体不会进入工具参数。

---

## 5. F-02：部分成功结果被 LLM 序列化器截断

### 5.1 证据与根因

批量 `read_file` 在部分失败时会返回完整结果：

```ts
{
    success: false,
    error: '1 file failed to read',
    data: {
        results: [
            { success: true, path: 'a.txt', content: '成功内容' },
            { success: false, path: 'missing.txt', error: 'ENOENT' }
        ],
        successCount: 1,
        failCount: 1,
        totalCount: 2
    }
}
```

工具层没有丢失成功内容。问题发生在：

```text
backend/modules/channel/formatters/toolResponseFormatter.ts
```

`serializeToolResultForLLM()` 看到顶层 `response.error` 后立即返回：

```text
Error: 1 file failed to read
```

当前错误分支只额外处理 `data.output`，不会继续序列化：

- `data.results`
- `data.message`
- 批量统计字段

因此前端可以显示完整结果，而模型只能看到顶层错误。

### 5.2 影响范围

该问题不只影响 `read_file`，还可能影响：

- 批量 `write_file`。
- `delete_file`、`create_directory` 等部分成功工具。
- `search_in_files` 替换被取消但已有部分修改结果的情况。
- `apply_diff` 返回逐项失败详情的情况。
- 其他同时返回 `error` 和 `data` 的工具。

模型看不到成功结果后，可能重复执行已经完成的文件读取或写入。

### 5.3 第二个相关缺陷

当前 `data.results` 分支使用：

```ts
results.every(hasTextContentFields)
```

这会把结果数组分为“所有项都有文本”和“其他情况”。

部分成功的 `read_file` 是混合数组：

- 成功项有 `content`。
- 失败项只有 `path`、`success`、`error`。

因此即使去掉错误分支的提前返回，混合数组仍会落入 `JSON.stringify(data)`。这会重新引入大段文本中的反斜杠二次转义问题。

所以修复必须同时处理：

1. 错误分支不再丢弃 `data`。
2. 混合 `results` 数组按项目逐项格式化。

### 5.4 建议修复

在共享的 `serializeToolResultForLLM()` 中实现，不为 `read_file` 添加特例。

建议规则如下。

#### 错误信息始终保留在最前

```text
Error: 1 file failed to read
```

如果是用户取消，再保留：

```text
[cancelled by user]
```

#### `data.results` 逐项处理

- 如果所有项目都是纯结构化数据，继续输出格式化 JSON，保持现有行为。
- 如果至少有一个项目包含原始文本，则每个项目独立格式化。
- 文本项目通过 `formatResultItem()` 原样输出文本。
- 非文本失败项目输出路径、`FAILED` 和错误详情。
- 同时保留 `successCount`、`failCount`、`totalCount` 等批量摘要。

建议模型侧结果示例：

```text
Error: 1 file failed to read

Partial results:
[successCount=1, failCount=1, totalCount=2]

[a.txt, 2 lines]
   1 | first line
   2 | second line

[missing.txt, FAILED | {"error":"ENOENT"}]
```

#### 保留 `data.output` 特殊处理

命令执行失败需要继续输出：

```text
Error: Command exited with code 1

Output:
实际 stderr/stdout
```

该行为不能因通用修复而退化。

#### 补充 `data.message`

对于删除、创建目录和补丁工具，应把 `data.message` 作为可读信息附加到错误结果后。

### 5.5 修改文件

主要修改：

- `backend/modules/channel/formatters/toolResponseFormatter.ts`

新增测试：

- `backend/__tests__/channel/toolResponseFormatter.test.ts`

三个渠道 formatter 已共用该函数，通常不需要分别改动：

- Anthropic formatter。
- OpenAI formatter。
- OpenAI Responses formatter。

### 5.6 测试要求

至少覆盖：

1. `read_file` 一项成功、一项失败。
2. 成功内容包含 Windows 路径反斜杠，不发生二次转义。
3. 失败项的 `ENOENT` 对模型可见。
4. `successCount`、`failCount`、`totalCount` 可见。
5. `execute_command` 失败时 `data.output` 保持原有格式。
6. `response.cancelled` 仍显示取消标记。
7. `data.message` 不再丢失。
8. 全成功文本数组输出不变。
9. 全结构化数组输出不变。
10. 没有 `data` 的普通错误仍只输出错误信息。

### 5.7 验收标准

- 部分失败时，模型同时看到顶层错误、成功结果和失败详情。
- 成功文本不会因 JSON 序列化产生额外反斜杠。
- 命令执行错误输出不发生回归。
- 修复对所有共享 formatter 生效。

---

## 6. F-03：XML 工具指南示例过时

### 6.1 `read_file` 示例问题

当前指南使用：

```xml
<parameters>
  <paths>
    <item>file1.txt</item>
    <item>src/main.ts</item>
  </paths>
</parameters>
```

但当前正式接口是：

- 单文件：`path`
- 批量文件：`files: [{ path, startLine?, endLine? }]`

不存在 `paths` 参数。

参数规范化会移除未知的 `paths`，最终调用缺少有效路径。

### 6.2 `write_file` 示例问题

当前指南使用：

```xml
<parameters>
  <files>
    <item>
      <path>file1.txt</path>
      <content>Hello, World!</content>
    </item>
  </files>
</parameters>
```

但当前 `write_file` 正式接口是顶层：

- `path`
- `content`

不存在 `files` 参数。

### 6.3 建议修复后的示例

#### 单文件读取

```xml
<tool_use>
  <tool_name>read_file</tool_name>
  <parameters>
    <path>src/main.ts</path>
  </parameters>
</tool_use>
```

#### 批量读取

```xml
<tool_use>
  <tool_name>read_file</tool_name>
  <parameters>
    <files>
      <item>
        <path>file1.txt</path>
      </item>
      <item>
        <path>src/main.ts</path>
      </item>
    </files>
  </parameters>
</tool_use>
```

#### 写入文件

```xml
<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>file1.txt</path>
    <content>Hello, World!</content>
  </parameters>
</tool_use>
```

#### 含代码或 XML 特殊字符的写入

```xml
<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>index.html</path>
    <content><![CDATA[<html>
  <body>if (a < b && c > d) { ... }</body>
</html>]]></content>
  </parameters>
</tool_use>
```

### 6.4 连带测试修复

现有部分测试夹具也使用过时形状。虽然这些测试只验证解析器往返，仍然会把错误调用形式固化为示例。

需要同步更新：

- `backend/__tests__/tools/xmlFormatter.test.ts`
- `backend/__tests__/tools/promptToolParser.test.ts`

JSON 模式中的相关旧夹具也应改为真实 schema，避免同一个测试文件继续传播过时参数。

### 6.5 修改文件

- `backend/tools/xmlFormatter.ts`
- `backend/__tests__/tools/xmlFormatter.test.ts`
- `backend/__tests__/tools/promptToolParser.test.ts`

### 6.6 验收标准

- XML 指南不再出现 `read_file.paths`。
- XML 指南不再出现 `write_file.files`。
- 示例经 `parseXMLToolCalls()` 解析后与真实工具 schema 一致。
- 示例参数通过 `normalizeToolArgs` 和参数校验。



---

## 7. F-04：VS Code 的 `Extension Tests` 调试配置不可用

### 7.1 证据

`.vscode/launch.json` 当前包含：

```json
{
    "name": "Extension Tests",
    "type": "extensionHost",
    "request": "launch",
    "args": [
        "--extensionDevelopmentPath=${workspaceFolder}",
        "--extensionTestsPath=${workspaceFolder}/dist/test/suite/index"
    ],
    "outFiles": [
        "${workspaceFolder}/dist/test/**/*.js"
    ]
}
```

但仓库中不存在：

```text
test/suite/index.ts
```

构建配置 `esbuild.config.js` 只有一个入口：

```js
entryPoints: ['extension.ts']
```

所以构建只会生成 `dist/extension.js`，不会生成 `dist/test/suite/index.js`。

项目也没有配置 `@vscode/test-electron` 或其他 Extension Host 测试运行器。当前真正可运行的测试框架是：

- 后端和扩展逻辑：Jest。
- 前端：Vitest。

### 7.2 建议修复

不建议为了保留一个从未实现的配置而新增完整 Extension Host 测试体系。本轮应把失效配置替换为可运行的 Jest 调试配置：

```json
{
    "name": "Debug Backend Tests (Jest)",
    "type": "node",
    "request": "launch",
    "program": "${workspaceFolder}/node_modules/jest/bin/jest.js",
    "args": [
        "--config",
        "jest.backend.config.js",
        "--runInBand"
    ],
    "console": "integratedTerminal",
    "internalConsoleOptions": "neverOpen"
}
```

这种处理不会伪装成 Extension Host 集成测试，而是准确反映仓库现有测试能力。

如果以后确实需要 Extension Host 测试，应单独完成：

1. 添加 `@vscode/test-electron`。
2. 创建测试 runner 和 `test/suite/index.ts`。
3. 为测试入口增加独立构建配置。
4. 在 CI 中运行 Extension Host 测试。

### 7.3 修改文件

- `.vscode/launch.json`

### 7.4 验收标准

- 调试配置不再引用不存在的文件。
- 在 VS Code 中选择 Jest 调试配置可以启动现有测试。
- 原有三个扩展运行配置不受影响。

---

## 8. F-05：`SubAgentRegistry.isEnabled()` 对未注册代理返回 `true`

### 8.1 根因

当前实现：

```ts
isEnabled(type: SubAgentType): boolean {
    const entry = this.agents.get(type);
    return entry?.config.enabled !== false;
}
```

未注册代理的 `entry` 是 `undefined`，表达式结果为：

```ts
undefined !== false // true
```

这与方法名称和 Registry 其他查询方法的语义不一致。

### 8.2 建议修复

```ts
isEnabled(type: SubAgentType): boolean {
    const entry = this.agents.get(type);
    return entry !== undefined && entry.config.enabled !== false;
}
```

### 8.3 测试要求

新增 Registry 单元测试，覆盖：

1. 未注册代理返回 `false`。
2. 注册且未显式禁用的代理返回 `true`。
3. 注册且 `enabled: true` 返回 `true`。
4. `setEnabled(false)` 后返回 `false`。
5. 注销后返回 `false`。

### 8.4 修改文件

- `backend/tools/subagents/registry.ts`
- 新增 `backend/__tests__/tools/subagentRegistry.test.ts`

### 8.5 验收标准

`isEnabled()` 只有在代理存在且未被禁用时返回 `true`。

---

## 9. F-06：Sub-Agent 对话接续缺少会话归属校验

### 9.1 证据与影响

`continueFromRunId` 当前只校验：

- run 是否存在。
- run 是否处于终态。

旧 run 快照已经包含：

```ts
conversationId?: string
```

当前工具上下文也包含：

```ts
context.conversationId
```

但接续时没有比较二者。

事件总线中的快照 Map 是全局共享的。只要当前对话知道另一个对话中的 `runId`，就可能把另一个对话的完整 transcript 作为 `baseContents` 注入当前 run。

影响包括：

- 不同聊天标签页之间泄漏子代理上下文。
- 当前任务继承其他项目或对话的路径、代码和结论。
- 新 run 将旧对话 transcript 复制到当前对话的持久化数据中。
- 历史内容中出现旧 runId 时，模型可能误接续错误运行。

### 9.2 产品语义结论

现有数据模型已经把 run 绑定到 `conversationId`，主工具调用也天然位于某个对话中。因此合理默认语义应为：

> `continueFromRunId` 只能接续当前主对话所属的 Sub-Agent run。

如果未来需要跨主对话接续，应设计明确的导入或复制功能，并要求显式用户操作，而不是通过一个可猜测或可复用的 runId 隐式完成。

### 9.3 建议修复

在默认 executor 读取旧快照后，创建新 run 前执行归属校验：

```ts
const currentConversationId = request.conversationId ?? context.conversationId;

if (
    oldSnapshot.conversationId &&
    currentConversationId &&
    oldSnapshot.conversationId !== currentConversationId
) {
    return {
        success: false,
        runId,
        error: `Cannot continue from run "${request.continueFromRunId}": the run belongs to a different conversation.`
    };
}
```

安全原则：

- 双方 conversationId 都已知且不同时，必须拒绝。
- 从当前对话持久化数据恢复的旧记录会补上当前 conversationId。
- 非聊天入口没有 conversationId 时可以保持现有兼容行为，但应避免在正常工具调用链中缺失 conversationId。

### 9.4 请求上下文传递

为了让默认 executor 和自定义 executor 都能获得每次调用的会话上下文，建议给 `SubAgentRequest` 增加可选字段：

```ts
conversationId?: string;
conversationStore?: SubAgentRunConversationStore;
promptModeSnapshot?: ResolvedPromptModeSnapshot;
```

工具处理器在每次调用时填入这些字段。默认 executor 优先读取 request 中的本次调用值，再回退到创建 executor 时的静态 context。

### 9.5 测试要求

至少覆盖：

1. 同一 conversationId 的终态 run 可以接续。
2. 不同 conversationId 的 run 被拒绝。
3. 跨会话拒绝发生在新 run 创建和持久化之前。
4. 正在运行的 run 仍然不能接续。
5. 不存在的 run 仍返回明确错误。
6. 旧持久化记录恢复后带有当前 conversationId，并可在当前对话接续。

### 9.6 验收标准

- 当前对话无法接续其他对话的 run。
- 拒绝结果不包含旧 transcript 内容。
- 同一对话的原有接续能力不受影响。

---

## 10. F-09：重载或内存淘汰后，已持久化 run 无法接续

### 10.1 根因

当前接续逻辑只调用：

```ts
subAgentRunEventBus.getSnapshot(runId)
```

该方法只查询内存 Map。

虽然终态 run 已经保存到 conversation metadata，但 `subagents` 工具调用路径不会在查找失败时调用：

```ts
loadConversationSnapshots(conversationId, conversationStore)
```

内存快照还存在数量上限，终态 run 可能被淘汰。因此下面两种情况会错误地返回 `run not found`：

- 扩展重载后接续旧 run。
- run 被内存保留上限淘汰后接续。

### 10.2 建议修复

接续查找顺序应为：

1. 查询内存快照。
2. 如果未找到，并且当前调用有 `conversationId` 和 `conversationStore`，只加载当前对话的持久化快照。
3. 再次查询目标 run。
4. 执行 F-06 的 conversationId 归属校验。
5. 校验终态后复制 transcript。

伪代码：

```ts
let oldSnapshot = subAgentRunEventBus.getSnapshot(runId);

if (!oldSnapshot && currentConversationId && currentConversationStore) {
    await subAgentRunEventBus.loadConversationSnapshots(
        currentConversationId,
        currentConversationStore
    );
    oldSnapshot = subAgentRunEventBus.getSnapshot(runId);
}
```

必须先限定为当前对话的 store，再进行恢复，不能为了查找 runId 扫描所有对话。

### 10.3 已知限制

事件总线当前以 `runId` 作为全局 Map 键，而不是 `(conversationId, runId)` 复合键。如果不同对话出现完全相同的 runId，安全做法是拒绝不匹配的内存快照，而不是覆盖或误接续。

本轮可以先完成安全校验和当前对话恢复。若以后需要彻底消除 runId 跨对话碰撞，应把事件总线索引改为复合键，这属于更大范围的数据模型调整。

### 10.4 测试要求

- 内存无快照、当前对话 metadata 有终态 run 时可以恢复并接续。
- 恢复过程不会加载其他 conversationId 的记录。
- 恢复出的快照仍执行会话归属和终态校验。

---

## 11. F-08：自定义 Sub-Agent executor 被正式调用路径忽略

### 11.1 根因

Registry 支持：

```ts
register(config, executor?)
```

`getByName()` 也会返回 `entry.executor`。

但正式工具处理路径只检查 executor 是否存在，随后仍调用：

```ts
executeSubAgent(agentEntry.config, ...)
```

`executeSubAgent()` 内部无条件创建：

```ts
createDefaultExecutor(config, ...)
```

所以自定义 executor 从未被调用。

当前 `get()` 和 `getByName()` 还会惰性创建默认 executor，并写回 Registry。这会让“显式注册的自定义 executor”和“Registry 临时创建的默认 executor”无法区分。

### 11.2 影响

- Registry 对外暴露的扩展能力实际无效。
- 将来模块注册自定义 executor 时不会报错，而是被静默忽略。
- 测试或扩展方可能误以为自定义执行逻辑已经生效。
- Registry 中缓存的默认 executor 缺少每次调用的 conversationId 等动态上下文。

### 11.3 建议修复

#### Registry 只保存显式注册的 executor

`get()` 和 `getByName()` 不再隐式创建并写回默认 executor：

```ts
get(type: SubAgentType): SubAgentRegistryEntry | undefined {
    return this.agents.get(type);
}
```

```ts
getByName(name: string): SubAgentRegistryEntry | undefined {
    return [...this.agents.values()].find(
        entry => entry.config.name === name && entry.config.enabled !== false
    );
}
```

`entry.executor` 的含义恢复为：调用 `register(config, executor)` 时显式注入的执行器。

如果保留公开的 `getExecutor()`，它可以在没有自定义 executor 时根据当前全局静态上下文创建默认 executor，但不要把该实例当作正式工具调用的动态会话执行器缓存。

#### 正式工具路径优先使用自定义 executor

`executeSubAgent()` 接收一个可选 executor：

```ts
async function executeSubAgent(
    config: SubAgentConfig,
    ...,
    customExecutor?: SubAgentExecutor
)
```

运行时选择：

```ts
const runtimeExecutor = customExecutor ?? createDefaultExecutor(...);
```

普通配置代理：

```ts
executeSubAgent(
    agentEntry.config,
    ...,
    agentEntry.executor
)
```

General Worker 没有自定义 executor，继续使用默认 executor。

#### 每次请求携带动态上下文

无论默认还是自定义 executor，都应收到：

- `conversationId`
- `conversationStore`
- `promptModeSnapshot`
- `runId`
- `continueFromRunId`

这样自定义 executor 不需要依赖 Registry 创建时的静态闭包，也能遵守会话边界和持久化要求。

### 11.4 测试要求

1. 注册自定义 executor 后，前台调用实际调用该函数。
2. 自定义 executor 的结果进入正常 ToolResult。
3. 后台调用同样使用自定义 executor。
4. 自定义 executor 收到当前调用的 conversationId 和 conversationStore。
5. 未注册自定义 executor 时仍创建默认 executor。
6. General Worker 继续使用默认 executor。
7. 自定义 executor 抛错时返回明确错误或后台任务错误。

### 11.5 修改文件

- `backend/tools/subagents/registry.ts`
- `backend/tools/subagents/types.ts`
- `backend/tools/subagents/subagents.ts`
- `backend/tools/subagents/executor.ts`
- `backend/__tests__/tools/subagentsTool.test.ts`
- `backend/__tests__/tools/subagentRegistry.test.ts`
- Sub-Agent 接续相关测试文件

### 11.6 验收标准

Registry 中显式注册的 executor 在正式 `subagents` 工具调用中真正生效，默认代理和 General Worker 的行为保持不变。

---

## 12. F-10：General Worker 可用时，`subagents` 工具仍可能被隐藏

### 12.1 问题

工具声明过滤逻辑目前只根据：

```ts
subAgentRegistry.countEnabled()
```

判断是否还有可用代理。

General Worker 是运行时虚拟代理，不在 Registry 的已启用计数中。如果用户禁用所有配置代理，但保持：

```ts
generalWorkerEnabled !== false
```

工具描述仍可能把 General Worker 视为可用，但声明过滤阶段会把整个 `subagents` 工具隐藏。

### 12.2 建议修复

抽取统一可用性判断：

```ts
function hasAvailableSubAgent(): boolean {
    const settings = getSubAgentsSettings();
    return subAgentRegistry.countEnabled() > 0
        || settings.generalWorkerEnabled !== false;
}
```

所有工具声明过滤位置使用同一个判断，避免描述生成与工具可见性采用不同规则。

已发现相关位置：

- `backend/modules/channel/ChannelManager.ts`
- `backend/modules/channel/ToolDeclarationResolver.ts`

### 12.3 测试要求

- Registry 无启用代理、General Worker 启用时，`subagents` 工具仍可见。
- Registry 无启用代理、General Worker 禁用时，工具被隐藏。
- 配置代理存在时保持原有行为。

---

## 13. F-07：`node-notifier` / `uuid` 生产依赖告警

### 13.1 当前依赖树

```text
node-notifier@10.0.1
└── uuid@8.3.2
```

`npm audit --omit=dev` 当前报告：

- `uuid`：Moderate，`GHSA-w5hq-g745-h8pq`。
- `node-notifier`：因传递依赖 `uuid` 被标记为 Moderate。

告警涉及在 v3/v5/v6 UUID API 传入 buffer 时缺少边界检查。项目代码没有直接调用 UUID API，但生产依赖树仍处于有告警状态。

### 13.2 上游状态

调查结果：

- `node-notifier` 最新正式版本仍为 `10.0.1`。
- 该版本发布于 2022 年。
- 它仍声明 `uuid: ^8.3.2`。
- 当前没有可直接升级的已维护安全版本。

`npm audit` 建议降级到 `node-notifier@6.0.0`。该建议只是审计工具根据依赖范围推导出的树变更，不代表 6.0.0 更适合当前项目，也会造成不合理的主版本降级，因此不应采用。

### 13.3 不建议使用全局 `uuid` override

可以通过 npm overrides 强行把 `uuid` 提升到 11.1.1，但这会让 `node-notifier` 在其声明范围之外运行，跨越多个主版本。

即使 `node-notifier` 当前只调用 `uuid.v4()`，该方案仍把兼容性风险留给项目维护者，而且 pnpm 还需要另一套 override 配置。相比之下，移除停更的直接生产依赖更清晰。

### 13.4 建议修复：改用 VS Code 原生通知

项目运行在 VS Code 扩展宿主中，可以使用 `vscode.window.showInformationMessage()` 或 `showWarningMessage()` 展示通知，并提供“打开聊天”操作按钮。

建议把现有 adapter 重构为 VS Code 原生实现：

```ts
export class VSCodeNotificationAdapter implements WindowsToastAdapter {
    async show(request: WindowsToastRequest): Promise<WindowsToastShowResult> {
        const openAction = request.onClick ? 'Open Chat' : undefined;
        const selected = await vscode.window.showInformationMessage(
            request.title,
            { detail: request.message },
            ...(openAction ? [openAction] : [])
        );

        if (selected === openAction) {
            await request.onClick?.();
        }

        return { shown: true };
    }
}
```

实际实现应避免把显示 Promise 一直等待到用户关闭通知后才算“已显示”。可以把通知调用启动后立即返回 `shown: true`，并异步处理操作按钮结果，保持工具调用不会长时间挂起。

### 13.5 行为差异

VS Code 原生通知与 `node-notifier` 的 Windows toast 有以下差异，需要在实现和文档中明确：

- “打开聊天”通过通知操作按钮触发，而不是点击通知任意区域触发。
- 通知声音由 VS Code 和系统设置管理，扩展 API 不能逐条强制静音或播放声音。
- 通知属于 VS Code 原生通知体系，窗口未聚焦时是否显示系统级横幅由用户的 VS Code 与 Windows 通知设置决定。

虽然存在这些差异，但该方案：

- 不需要停更的外部通知包。
- 不需要复制原生二进制和传递依赖到 VSIX。
- 与 VS Code 扩展生命周期和命令系统一致。
- 可以消除生产依赖审计告警。

如果产品必须保证独立 Windows Toast、逐条声音控制和点击整个通知回调，则应另行选择有维护状态的 Windows 通知库并做专门验证，不能继续依赖已停更的 `node-notifier`。

### 13.6 连带清理

移除直接依赖后需要同步清理：

- `package.json` 中的 `node-notifier`。
- npm 和 pnpm 锁文件中的生产依赖关系。
- `backend/modules/notifications/WindowsToastAdapter.ts` 中的 `require('node-notifier')`。
- `esbuild.config.js` 中的 `nativePackages` 和复制传递依赖逻辑。
- 只为 `node-notifier` 创建的运行时加载探针。
- 与旧打包方式相关但已失效的注释。

Jest 可能仍把 `node-notifier` 作为可选开发依赖记录在完整锁文件中，但 `npm audit --omit=dev` 不应再把它视为生产依赖。

### 13.7 测试要求

1. 通知适配器调用 VS Code 原生 API。
2. 选择“打开聊天”后执行 `graycode.openChat`。
3. 不要求打开聊天时不添加操作按钮。
4. 通知 API 抛错时返回 `shown: false` 和错误信息。
5. 非 Windows 平台的工具语义保持现有行为，或同步将工具命名和说明改为跨平台 VS Code 通知。
6. 构建产物不再包含 `dist/node_modules/node-notifier`。
7. `npm audit --omit=dev` 不再报告 `node-notifier` 或 `uuid` 生产告警。

### 13.8 验收标准

- 生产依赖中没有 `node-notifier` 和 `uuid@8.3.2`。
- 通知功能仍能显示内容并提供打开聊天操作。
- VSIX 构建不再依赖复制 `node-notifier` 原生资源。

---

## 14. F-11：npm 与 pnpm 锁文件一致性

### 14.1 问题

调查前曾出现：

- `package-lock.json` 锁定 `fast-xml-parser@4.5.3`。
- `pnpm-lock.yaml` 锁定 `fast-xml-parser@4.5.6`。
- 本地实际安装为 4.5.3。

这会导致 npm、pnpm 和 CI 环境安装出不同依赖树。

### 14.2 建议修复

完成依赖调整后分别更新并核对：

```powershell
npm install
pnpm install --lockfile-only
```

如果项目正式只支持一种包管理器，应删除另一份锁文件并在 README 中说明。当前仓库同时保留两份锁文件，因此本轮应先保持二者同步。

### 14.3 验收标准

- 两份锁文件都解析到 `fast-xml-parser@5.10.1` 或同一安全版本。
- 生产依赖都不再包含直接的 `node-notifier`。
- npm 和 pnpm 的冻结锁文件安装都能成功。


---

## 15. 建议实施顺序

建议按以下顺序实施，避免依赖变更和行为修复互相干扰。

### 第一组：XML 安全与协议正确性

1. 保留 `fast-xml-parser@5.10.1`。
2. 同步 npm 和 pnpm 锁文件。
3. 在 XML 解析器配置中禁用自定义实体处理并限制嵌套深度。
4. 必要时在协议入口明确拒绝 DOCTYPE 和 ENTITY 声明。
5. 更新 `read_file`、`write_file` XML 指南示例。
6. 更新 XML 和 JSON 模式中的过时测试夹具。
7. 执行 XML 相关测试、类型检查和安全输入测试。

### 第二组：LLM 工具结果序列化

1. 重构 `serializeToolResultForLLM()` 的结果数组处理。
2. 错误分支继续序列化 `data.results`、`data.output` 和 `data.message`。
3. 增加共享 formatter 单元测试。
4. 执行 OpenAI、Anthropic 和 Responses formatter 回归测试。

### 第三组：Sub-Agent 正确性和会话边界

1. 修复 `SubAgentRegistry.isEnabled()`。
2. 移除 Registry 查询方法中对默认 executor 的隐式缓存。
3. 让正式工具路径优先调用显式注册的自定义 executor。
4. 给 executor request 传递每次调用的会话上下文。
5. 在接续时先从当前对话持久化记录恢复，再执行 conversationId 校验。
6. 修复 General Worker 可用性与工具声明过滤不一致。
7. 增加 Registry、工具调用、接续和重载恢复测试。

### 第四组：通知依赖和构建清理

1. 用 VS Code 原生通知适配器替代 `node-notifier`。
2. 保留打开聊天操作。
3. 删除直接生产依赖和构建复制逻辑。
4. 更新通知适配器测试。
5. 构建后确认不再生成 `dist/node_modules/node-notifier`。
6. 执行生产依赖审计。

### 第五组：开发体验和最终验证

1. 替换失效的 `Extension Tests` 调试配置。
2. 执行相关测试和全量后端测试。
3. 执行前端测试。
4. 执行 TypeScript 类型检查。
5. 执行完整构建。
6. 执行 `npm audit --omit=dev`。
7. 检查最终 diff，确认没有无关变更。

---

## 16. 逐文件修改清单

### 16.1 依赖与构建

| 文件 | 计划修改 |
| --- | --- |
| `package.json` | 保留 `fast-xml-parser@^5.10.1`；移除直接生产依赖 `node-notifier` |
| `package-lock.json` | 更新 XML 解析器依赖树；移除生产通知依赖树 |
| `pnpm-lock.yaml` | 与 package.json 和 npm 锁文件同步 |
| `esbuild.config.js` | 删除 `node-notifier` external/native package 复制逻辑和过时说明 |
| `.vscode/launch.json` | 用可运行的 Jest 调试配置替换失效 Extension Tests 配置 |

### 16.2 XML 工具协议

| 文件 | 计划修改 |
| --- | --- |
| `backend/tools/xmlFormatter.ts` | 增加实体和嵌套安全配置；更新 read/write 示例 |
| `backend/tools/promptToolParser.ts` | 核对 validator 返回形状；必要时增强 DOCTYPE 失败说明 |
| `backend/__tests__/tools/xmlFormatter.test.ts` | 更新夹具；补安全和字符串语义测试 |
| `backend/__tests__/tools/promptToolParser.test.ts` | 更新 XML/JSON 真实参数示例；补 validator 回归测试 |

### 16.3 工具结果序列化

| 文件 | 计划修改 |
| --- | --- |
| `backend/modules/channel/formatters/toolResponseFormatter.ts` | 通用处理部分成功、混合数组、output 和 message |
| `backend/__tests__/channel/toolResponseFormatter.test.ts` | 新增共享序列化器测试 |
| 现有 formatter 测试 | 必要时补一项渠道集成断言 |

### 16.4 Sub-Agent

| 文件 | 计划修改 |
| --- | --- |
| `backend/tools/subagents/registry.ts` | 修复 isEnabled；理清自定义与默认 executor 语义 |
| `backend/tools/subagents/types.ts` | 给请求增加动态会话上下文字段 |
| `backend/tools/subagents/subagents.ts` | 正式调用自定义 executor；传递会话上下文 |
| `backend/tools/subagents/executor.ts` | 当前会话恢复、归属校验和安全接续 |
| `backend/modules/channel/ChannelManager.ts` | 统一 General Worker 可用性判断 |
| `backend/modules/channel/ToolDeclarationResolver.ts` | 统一 General Worker 可用性判断 |
| `backend/__tests__/tools/subagentRegistry.test.ts` | 新增 Registry 行为测试 |
| `backend/__tests__/tools/subagentsTool.test.ts` | 更新 mock；验证自定义和默认 executor 路径 |
| Sub-Agent executor 测试 | 增加同会话、跨会话和持久化恢复测试 |

### 16.5 通知

| 文件 | 计划修改 |
| --- | --- |
| `backend/modules/notifications/WindowsToastAdapter.ts` | 改为 VS Code 原生通知实现，或重命名为更准确的适配器名称 |
| `backend/modules/notifications/WindowsAgentStopNotificationService.ts` | 使用新适配器，保持打开聊天行为 |
| `backend/tools/notification/show_windows_notification.ts` | 使用新适配器；必要时更新工具说明中的平台语义 |
| `backend/__tests__/notifications/show_windows_notification.test.ts` | 保留工具层测试并补原生 adapter 测试 |
| 通知服务相关测试 | 验证点击操作、错误和去重行为 |

### 16.6 文档

| 文件 | 计划修改 |
| --- | --- |
| `CHANGELOG.md` | 记录安全升级、部分结果修复、Sub-Agent 边界和通知依赖调整 |
| `AUDIT_REMEDIATION.md` | 实施完成后更新每项状态和最终验证结果 |

---

## 17. 测试矩阵

### 17.1 XML

建议针对性命令：

```powershell
npx jest --config jest.backend.config.js --runInBand `
  backend/__tests__/tools/xmlFormatter.test.ts `
  backend/__tests__/tools/promptToolParser.test.ts `
  backend/__tests__/tools/coerceToolArgs.test.ts `
  backend/__tests__/tools/validateToolArgs.test.ts
```

验证内容：

- 5.10.1 API 和 TypeScript 类型正常。
- CDATA 和属性节点行为不变。
- 数字字符串不自动转换。
- DOCTYPE 实体不被展开。
- 真实 read/write 示例可以解析并通过 schema 规范化。

### 17.2 工具响应序列化

```powershell
npx jest --config jest.backend.config.js --runInBand `
  backend/__tests__/channel/toolResponseFormatter.test.ts `
  backend/__tests__/channel/formatterParsing.test.ts `
  backend/__tests__/channel/formatterParallelTools.test.ts
```

验证内容：

- 部分成功内容对模型可见。
- 失败详情对模型可见。
- 原始文本不发生二次转义。
- 命令输出和取消标记不回归。

### 17.3 Sub-Agent

```powershell
npx jest --config jest.backend.config.js --runInBand `
  backend/__tests__/tools/subagentRegistry.test.ts `
  backend/__tests__/tools/subagentsTool.test.ts `
  backend/__tests__/tools/subagentExecutorTermination.test.ts `
  backend/__tests__/tools/subagentRunEventBus.test.ts `
  backend/__tests__/tools/subagentConcurrencyLimiter.test.ts `
  backend/__tests__/tools/subagentRunController.test.ts
```

验证内容：

- 未注册代理不再被判断为启用。
- 自定义 executor 真正被调用。
- 默认 executor 保持原有行为。
- 同一对话接续成功。
- 跨对话接续拒绝。
- 重载后可以从当前对话持久化数据恢复接续。
- 后台任务和取消语义不回归。

### 17.4 通知

```powershell
npx jest --config jest.backend.config.js --runInBand `
  backend/__tests__/notifications/show_windows_notification.test.ts
```

还应增加或执行通知服务相关测试，验证：

- 通知被请求显示。
- 打开聊天操作有效。
- 不打开聊天时不创建操作按钮。
- 原生 API 失败时有明确结果。
- 窗口聚焦过滤、去重和模板渲染不受影响。

### 17.5 全量验证

```powershell
npm run typecheck
npm test -- --runInBand
npm run test:frontend
npm run build
npm audit --omit=dev
```

如果安装了 pnpm，还应执行：

```powershell
pnpm install --frozen-lockfile
```

为了验证 npm 锁文件：

```powershell
npm ci
```

`npm ci` 会重建 `node_modules`，应在代码修改和锁文件确定后执行。

---

## 18. 安全输入测试建议

仅测试正常 XML 不足以证明本次安全升级有效，建议增加以下输入。

### 18.1 自定义实体

```xml
<!DOCTYPE tool_use [
  <!ENTITY secret "expanded-value">
]>
<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>a.txt</path>
    <content>&secret;</content>
  </parameters>
</tool_use>
```

期望：

- 不展开为 `expanded-value`。
- 最好把该块判定为不支持的 XML 工具调用。

### 18.2 实体递归

构造多层实体引用，期望解析快速失败，不出现长时间 CPU 占用或内存膨胀。

### 18.3 超深嵌套

构造超过 `maxNestedTags` 的参数节点，期望安全失败。

### 18.4 数字实体

构造大量数字字符实体，期望不会绕过实体禁用策略造成膨胀。

### 18.5 危险属性名

验证 `__proto__`、`constructor` 等危险名称不会污染解析结果原型。5.10.1 已包含危险属性处理能力，但项目仍应有一项回归测试确认最终参数对象没有原型污染。

---

## 19. 兼容性注意事项

### 19.1 fast-xml-parser 主版本升级

虽然 5.10.1 的公开解析器仍兼容现有扁平选项，但必须以测试结果为准。重点关注：

- 空节点返回值。
- CDATA 合并行为。
- 带属性文本节点的 `#text` 形态。
- 多个 `<item>` 时的数组形态。
- Validator 错误对象的字段。

### 19.2 XML 实体禁用

工具调用协议此前没有声明支持 DOCTYPE 或自定义实体，所以禁用它们属于安全收紧，不是正常功能破坏。

内置 XML 转义和 CDATA 不依赖 DOCTYPE 实体，应继续正常工作。

### 19.3 自定义 executor 开始生效

这是预期修复，但对第三方注册模块而言属于行为变化：以前注册的 executor 被忽略，修复后会真正执行。

因此需要：

- 在 CHANGELOG 明确记录。
- 对 executor 的请求字段和返回值进行测试。
- 保证异常被正常捕获。

### 19.4 Sub-Agent 会话边界收紧

跨主对话接续从隐式允许变成拒绝，是安全修复。正常的同对话接续不应变化。

错误信息应清晰说明“属于不同对话”，但不能泄漏旧对话 ID、内容或其他敏感信息。

### 19.5 通知行为变化

改用 VS Code 原生通知后，逐条声音控制和点击整个系统 toast 的能力可能变化。需要优先保证：

- 通知内容可见。
- 可以从通知操作返回 GrayCode 聊天。
- 不阻塞工具调用。
- 不再携带有告警且停更的生产依赖。

---

## 20. 不应采用的修复方式

### 20.1 不应只压制 audit 告警

不要使用审计忽略列表掩盖 `fast-xml-parser` 或 `uuid` 告警，而不改变依赖或行为。

### 20.2 不应为 read_file 添加序列化特例

部分成功是通用 ToolResult 语义，必须在共享 formatter 处理。

### 20.3 不应只删除顶层 error

顶层错误对模型仍然有价值。正确做法是同时呈现错误和部分结果，而不是把整体结果标记成成功。

### 20.4 不应默认允许跨对话接续

runId 不是跨对话授权令牌。没有明确用户操作和产品设计时，不能用“知道 runId”作为读取其他对话 transcript 的条件。

### 20.5 不应继续缓存缺少动态会话上下文的默认 executor

conversationId、conversationStore 和提示词模式属于每次工具调用的数据，不适合固定在 Registry 的长期缓存 executor 中。

### 20.6 不应按 npm audit 建议降级 node-notifier

降级到 6.0.0 没有合理的产品或兼容性依据，也不能证明通知链更安全。

### 20.7 不应跨多个 uuid 主版本做无验证 override

如果有更干净的依赖移除方案，不应让停更包运行在其未声明支持的依赖版本上。

---

## 21. 最终验收清单

### 21.1 安全

- [x] `fast-xml-parser` 为 5.10.1 或更高安全版本。
- [x] XML 工具调用禁用不需要的自定义实体处理。
- [x] XML 安全输入测试通过。
- [x] 跨对话 Sub-Agent 接续被拒绝。
- [x] 生产依赖不再包含 `node-notifier -> uuid@8.3.2` 告警链。
- [x] `npm audit --omit=dev` 不再出现本轮两类生产依赖告警。

### 21.2 功能正确性

- [x] 部分成功的批量读取结果完整传给模型。
- [x] 失败文件详情完整传给模型。
- [x] 命令错误输出仍完整传给模型。
- [x] XML read/write 示例与真实 schema 一致。
- [x] `SubAgentRegistry.isEnabled()` 对未注册代理返回 false。
- [x] 自定义 Sub-Agent executor 真正执行。
- [x] 同一对话的持久化 run 可在重载后接续。
- [x] General Worker 是唯一可用代理时，工具仍可见。
- [x] 通知仍可显示并提供打开聊天操作。

### 21.3 工程质量

- [x] 为每项行为修复增加回归测试。
- [x] `npm run typecheck` 通过。
- [x] 后端全量 Jest 测试通过。
- [x] 前端 Vitest 测试通过。
- [x] 完整构建通过。
- [x] npm 和 pnpm 锁文件一致。
- [x] `.vscode/launch.json` 不再引用不存在的测试入口。
- [x] 最终 diff 不包含无关文件和临时测试脚本。

---

## 22. 预期完成结果

完成本轮修复后，项目应达到以下状态：

1. 模型返回的 XML 工具调用由安全版本解析，并且协议不接受不需要的 DOCTYPE 自定义实体功能。
2. 批量工具即使部分失败，模型也能看到已经成功的结果，不会因为信息丢失而重复操作。
3. XML 模式内置示例与工具真实参数保持一致。
4. Sub-Agent 的启用状态、执行器扩展能力和对话接续边界符合公开 API 和数据模型语义。
5. 重载后仍可以在同一对话内接续已持久化的终态 run。
6. 通知功能不再依赖停更且带生产审计告警的依赖链。
7. 开发者可以直接使用有效的 Jest 调试配置。
8. 所有修改都有测试保护，并通过类型检查、构建和生产依赖审计。

---

## 23. 实施完成记录（2026-08-01）

本轮 F-01 至 F-11 全部修复完成，验证结果如下。

### 代码修复

- F-01：`backend/tools/xmlFormatter.ts` 解析器配置增加 `processEntities: false`、`maxNestedTags: 100`，协议层过滤 `__proto__`/`constructor`/`prototype` 危险键。
- F-02：`toolResponseFormatter.ts` 错误分支保留 `data.results`（混合数组逐项格式化）、`data.message` 与批量统计；`data.output` 与取消标记格式不变。
- F-03：XML 指南 `read_file`/`write_file` 示例与 XML/JSON 测试夹具更新为真实 schema。
- F-04：`.vscode/launch.json` 用 Jest 调试配置替换失效的 `Extension Tests`。
- F-05：`SubAgentRegistry.isEnabled()` 未注册代理返回 false。
- F-06：接续前校验旧 run 的 conversationId 归属，跨对话拒绝且不泄漏信息。
- F-07：通知适配器改为 VS Code 原生实现（`VSCodeNotificationAdapter`），移除 `node-notifier` 直接依赖与 esbuild 复制逻辑。
- F-08：Registry 不再隐式缓存默认 executor，正式调用路径优先使用显式注册的自定义 executor，request 透传动态会话上下文。
- F-09：接续时内存未命中则只加载当前对话持久化快照，恢复后仍执行归属与终态校验。
- F-10：`ChannelManager`/`ToolDeclarationResolver` 统一 `hasAvailableSubAgent()` 判断。
- F-11：`package-lock.json` 与 `pnpm-lock.yaml` 均锁定 `fast-xml-parser@5.10.1`；`node-notifier` 仅保留在 Jest 可选 peer（dev）链。

### 新增测试

- `backend/__tests__/channel/toolResponseFormatter.test.ts`：部分成功序列化（11 用例）。
- `backend/__tests__/tools/subagentRegistry.test.ts`：isEnabled 与 executor 语义（9 用例）。
- `backend/__tests__/tools/subagentExecutorContinuation.test.ts`：跨对话拒绝与持久化恢复（6 用例）。
- `backend/__tests__/notifications/windowsToastAdapter.test.ts`：VS Code 原生通知适配器（4 用例）。
- 更新 `xmlFormatter.test.ts`（安全与字符串语义 4 用例）、`promptToolParser.test.ts`（真实 schema 夹具 + validator API 回归）、`subagentsTool.test.ts`（自定义 executor 调用路径）。

### 最终验证

- `npm run typecheck`：通过。
- 后端 Jest：80 套件 / 699 用例全部通过。
- 前端 Vitest：7 文件 / 71 用例全部通过。
- `npm run build`：通过；`dist/` 不再包含 `node-notifier` 及其原生依赖。
- `npm audit --omit=dev`：0 漏洞。
- `npm ls node-notifier --omit=dev`：empty（生产树干净）。
- `npm ls fast-xml-parser`：5.10.1。