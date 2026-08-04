# 审计修复批次 P2（F-01 / F-02 / F-03 / F-05）执行报告

> 计划来源：`.graycode/plans/audit-remediation-修复计划.plan.md`（第一、二、三组中的本批次范围）
> 参考：`AUDIT_REMEDIATION.md` 第 5、6、7 节与第 15 节实施顺序

## 一、批次现状说明

进入工作区后发现，本批次四项修复的核心代码与大部分测试已存在于仓库已提交历史中
（commit `3bfab33 feat: harden tools and add memory controls`，含 `xmlFormatter.ts` 防御配置、
`toolResponseFormatter.ts` 重构、`registry.ts` 修复及对应测试）。本批次工作为：

1. 逐项核对已提交实现与计划/AUDIT_REMEDIATION 要求的一致性（含真实 schema、文档 5.6 节 10 项测试覆盖）；
2. 补齐 `promptToolParser.test.ts` 缺失的 2 项安全输入测试（DOCTYPE 实体不展开、超深嵌套拒绝）；
3. 运行全部 4 个测试套件验证。

## 二、修改摘要

### F-01：xmlFormatter.ts XMLParser 防御配置 ✅

文件：`backend/tools/xmlFormatter.ts`

- `XMLParser` 增加 `processEntities: false`、`maxNestedTags: 100`（安全加固：禁用实体展开/递归膨胀、限制嵌套深度）。
- 保留原有字符串语义配置：`parseTagValue: false`、`parseAttributeValue: false`、`trimValues: true` 等，
  类型还原仍由 schema 驱动的 `normalizeToolArgs` 负责。
- 协议层另有第二道防线：`DANGEROUS_OBJECT_KEYS`（`__proto__` / `constructor` / `prototype`）在解析结果回填参数对象时跳过。

### F-03：XML 指南示例与测试夹具更新 ✅

指南（`xmlFormatter.ts` 的 `convertToolsToXML` "Tool Usage Guide"）已为真实 schema：

- `read_file` 单文件：顶层 `path`；
- `read_file` 批量：`files: [{ path, startLine?, endLine? }]`（`<files><item><path>…</path><startLine>…</startLine><endLine>…</endLine></item></files>`）；
- `write_file`：顶层 `path` + `content`（均 required）。
- 指南中已不存在 `paths` 或 `write_file.files` 过时形状（`AUDIT_REMEDIATION.md` 6.1/6.2 验收标准满足）。

测试夹具与安全输入测试：

- `backend/__tests__/tools/xmlFormatter.test.ts`：
  - 夹具为真实 schema（`read_file` 批量用 `files: [{ path }]` 对象数组形状）；
  - 安全测试 3 项：数字字符串不被转换（`1.10`）、DOCTYPE 自定义实体不展开（`&secret;` 保持字面量）、
    超深嵌套（depth 150）安全失败不抛异常、`__proto__` / `constructor` 危险键名无原型污染。
- `backend/__tests__/tools/promptToolParser.test.ts`（本批次新增 2 项）：
  - 夹具为真实 schema（`read_file.files` 通过 `<item>` 解析为 `[{ path }]`）；
  - 原有：`__proto__` 危险键名被拒绝并转为携带意图工具名的失败反馈；
  - 新增：DOCTYPE 自定义实体不展开（`processEntities: false` 链路保护，`&secret;` 保持字面量）；
  - 新增：超深嵌套（depth 150）被拒绝并转为可读失败反馈（`TOOL_CALL_PARSE_ERROR_ARG_KEY`，意图工具名保留），不抛异常。
  - 说明：`promptToolParser.ts` 的 XML 解析委托给 `xmlFormatter.parseXMLToolCalls`（第 68 行），
    因此 F-01 的防御配置对提示词解析路径同样生效，两条链路共享同一份加固。

### F-02：toolResponseFormatter.ts 部分成功序列化重构 ✅

文件：`backend/modules/channel/formatters/toolResponseFormatter.ts`

- 错误分支不再丢弃 `data`：错误信息始终在最前，同时继续序列化部分成功结果。
- `data.results` 混合数组逐项格式化（`formatResultItem`：文本字段原样透出 + 元数据 JSON 摘要），
  避免 JSON 二次转义；纯结构化数组才整体 JSON。
- 保留 `data.output`（execute_command 失败输出的 `Output:` 原格式）、`data.message`（`Message:` 前缀）、
  批量统计字段（`successCount` / `failCount` / `totalCount` 单行摘要）与 `response.cancelled` 取消标记。

新增测试 `backend/__tests__/channel/toolResponseFormatter.test.ts` 覆盖 AUDIT_REMEDIATION 5.6 节全部 10 项：

1. read_file 一项成功一项失败 ✅（成功内容 + 失败详情 + 批量统计同时可见）
2. Windows 路径反斜杠不二次转义 ✅
3. 失败项 ENOENT 可见 ✅
4. successCount/failCount/totalCount 可见 ✅
5. execute_command 失败 data.output 原格式 ✅
6. response.cancelled 取消标记 ✅
7. data.message 不再丢失 ✅
8. 全成功文本数组输出不变 ✅
9. 全结构化数组输出不变 ✅
10. 无 data 的普通错误只输出错误信息 ✅
（另含混合数组无错误时也逐项格式化用例）

### F-05：SubAgentRegistry.isEnabled() 修复 + executor 语义 ✅

文件：`backend/tools/subagents/registry.ts`

- `isEnabled()` 修复：未注册代理返回 `false`（原实现 `undefined !== false` 恒为 true，误判未注册代理为启用）。
- `get()` / `getByName()` 不再隐式缓存默认 executor：查询方法只返回注册项本身；
  默认 executor 由正式工具调用路径按每次请求动态创建（配合 F-08 动态会话上下文）。

新增测试 `backend/__tests__/tools/subagentRegistry.test.ts`：

- `isEnabled`：未注册 false / 注册默认 true / `enabled: true` true / `setEnabled(false)` 后 false / 注销后 false；
- executor 语义：`get()` / `getByName()` 不隐式创建默认 executor（`entry.executor` 为 undefined）、
  显式注册的自定义 executor 原样保留、`updateConfig` 后清除已注册 executor。

## 三、验证结果

命令（与任务要求一致）：

```
npx jest --config jest.backend.config.js backend/__tests__/tools/xmlFormatter.test.ts backend/__tests__/tools/promptToolParser.test.ts backend/__tests__/channel/toolResponseFormatter.test.ts backend/__tests__/tools/subagentRegistry.test.ts
```

结果：

```
Test Suites: 4 passed, 4 total
Tests:       53 passed, 53 total
Snapshots:   0 total
```

- `xmlFormatter.test.ts` PASS（含 DOCTYPE / 深嵌套 / 原型污染安全用例）
- `promptToolParser.test.ts` PASS（含新增 DOCTYPE 与深嵌套用例）
- `toolResponseFormatter.test.ts` PASS（5.6 节 10 项全覆盖）
- `subagentRegistry.test.ts` PASS（isEnabled + executor 语义）

## 四、边界与合规

- 本批次实际修改文件：仅 `backend/__tests__/tools/promptToolParser.test.ts`（新增 2 项安全测试，+39 行）。
  其余实现（xmlFormatter.ts / toolResponseFormatter.ts / registry.ts / xmlFormatter.test.ts /
  toolResponseFormatter.test.ts / subagentRegistry.test.ts / XML 指南示例）核对后确认已在提交
  `3bfab33` 中就位且符合要求，未重复改动。
- 未修改：CHANGELOG.md（主模型统一记录）、规划文档、executor.ts、subagents.ts、CheckpointSettings、
  conversation/checkpoint 模块等其它批次/其它 agent 的文件。

## 五、观察与建议（不在本批次范围）

- `backend/tools/jsonFormatter.ts` 的 JSON 模式指南（`convertToolsToJSON`，约 154/158 行）仍含过时示例：
  `read_file` 用 `paths`、`write_file` 用 `files`，与真实 schema（`path` / `files:[{path,...}]` / `path`+`content`）不符。
  本批次边界仅允许 XML 模式指南（jsonFormatter.ts 不在允许清单内），未改动；建议后续批次按 F-03 同类方式更新。
- `backend/__tests__/channel/streamAccumulator.test.ts:131` 的流式夹具仍用 `<paths><item>a.txt</item></paths>`
  旧形状（仅作流式切块测试数据，不经过 schema 校验，不影响协议正确性），如需彻底清理可一并更新。
