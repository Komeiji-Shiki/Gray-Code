# 外部控制接口与语音合成

GrayCode 2.x 提供外部控制接口，让 Claude Code 与 Codex 等 AI 代理、脚本、Stream Deck、桌面小工具或其他应用直接驱动 GrayCode；同时提供统一的语音合成能力，支持云端接口、本地部署和 Windows 本机语音。

## 一、外部控制接口

同一组接口有两个入口：

- **本机通道**：随应用常开，不需要开关、端口和令牌。Windows 上是命名管道，macOS 与 Linux 上是 Unix socket，地址只写在当前用户的发现文件里。AI 代理通过 MCP 控制桥接入，其他本机程序也可以直接经通道发送 HTTP 请求。
- **网络接口**：普通 TCP 端口上的 HTTP，需要访问令牌，供局域网设备、Stream Deck 和不支持 MCP 的应用使用，默认关闭。

### 让 AI 代理直接使用（MCP）

打开「设置 → 外部控制」，在「本机代理（MCP）」中复制配置：

- Claude Code 等使用 `mcpServers` 的客户端：把 JSON 写入项目的 `.mcp.json` 或客户端自己的 MCP 配置。
- Codex：把 TOML 追加到 `~/.codex/config.toml`。

桌面版的配置形如：

```json
{
  "mcpServers": {
    "graycode": {
      "command": "C:\\Users\\<用户>\\AppData\\Local\\GrayCode\\current\\GrayCode.exe",
      "args": ["C:\\Users\\<用户>\\AppData\\Local\\GrayCode\\current\\resources\\app\\apps\\desktop\\dist\\controlMcp.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE` 让 `GrayCode.exe` 以 Node 方式运行控制桥，不需要另外安装 Node。命令行版（`npm run platform`）的配置改为用 `node` 运行 `apps/server/dist/controlMcp.cjs`，不带 `env`。路径以设置页显示的为准。

控制桥把常用接口提供为同名工具：`get_status`、`list_conversations`、`create_conversation`、`get_conversation`、`read_messages`、`send_message`、`get_run`、`list_run_events`、`resolve_approval`、`answer_question`、`cancel_run` 与 `call_rpc`，参数与下文的 HTTP 接口一致。事件流和语音合成不适合模型直接调用，没有对应工具。

- GrayCode 未运行时工具列表为空，调用会提示先打开 GrayCode；之后启动、重启或升级让工具变化时，控制桥会通知客户端刷新列表。
- 同时运行多个实例时连接最近启动的一个；要连接指定实例，在 `args` 末尾加 `--data <数据目录>`。
- MCP 客户端的工具调用通常有超时，`send_message` 的 `wait` 建议不超过 50 秒，任务未完成时再用 `get_run` 等待。

### 发现文件

应用运行时，GrayCode 会在 `~/.graycode/control-api/<进程号>.json` 写入发现文件（Windows 上是 `%USERPROFILE%\.graycode\control-api\`），内容包括：

- `pipe`：本机通道地址；
- `mcp`：控制桥的启动命令 `command`、`args` 与 `env`；
- `http`：网络接口正在监听时的 `url`；
- `pid`、`startedAt`、`version` 与 `dataDirectory`。

发现文件不含令牌。应用退出时删除，异常退出留下的旧文件会在下次启动时清理。目录只有当前用户可读，Windows 上的管道名带随机段，其他系统账号拿不到地址，也无法抢先占用同名管道。

不用 MCP 的本机程序可以读取 `pipe`，把 HTTP 请求直接发到通道上，先请求 `GET /v1` 查看全部接口。以 Node 为例：

```js
http.request({ socketPath: discovery.pipe, path: '/v1', headers: { host: 'localhost' } }, …)
```

### 启用网络接口

在「设置 → 外部控制」的「网络接口」中：

1. 勾选「启用网络接口」。
2. 选择监听端口。`0` 表示由系统分配空闲端口；需要固定地址时填写 `18766` 等端口。
3. 生成访问令牌。令牌至少 32 个字符，保存时写入加密凭据。
4. 保存全部设置，再点击「启动已保存的接口」。

网络接口默认只监听 `127.0.0.1`。开启「允许局域网访问」后会监听 `0.0.0.0`，局域网内其他设备可以用 HTTP 直接访问；这条通道没有 TLS，令牌和消息内容不会加密，只建议在可信网络中使用。

关闭主窗口后，只要网络接口仍在监听，应用会继续留在后台；手动停止或启动失败（如端口被占用）后不再保持后台。本机通道不会让应用留在后台。使用 `npm run platform -- --data <目录> serve` 运行无界面服务时，本机通道随服务启动；保存过的设置里启用了网络接口时，网络接口也会一起启动。

### 网络接口的认证

经网络接口的请求都需要附带令牌：

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:18766/v1
```

也可以使用 `X-GrayCode-Token: <token>`。令牌拥有与你本人相同的权限，不要写进浏览器地址栏、公开日志或会提交到仓库的脚本。

网络接口不发送 CORS 头，网页无法跨域读取响应；`Host` 请求头必须是 `localhost` 或 IP 地址，带域名的请求返回 `403`，用来挡住 DNS 重绑定。

### 接口一览

| 方法与路径 | 说明 |
| --- | --- |
| `GET /v1` | 完整接口说明：每个接口的参数、等待方式与错误约定。 |
| `GET /v1/health` | 服务与版本，可用于连接检查。 |
| `GET /v1/status` | 活动任务数，以及发送消息时可选的智能体、模型渠道与工作区。 |
| `GET /v1/conversations` | 会话列表，支持 `limit`、`query`、`workspaceUri`、`cursor`（上一页返回的 `nextCursor`）。 |
| `POST /v1/conversations` | 新建会话，请求体 `{ "title": "...", "workspaceId": "..." }`。 |
| `GET /v1/conversations/:id` | 读取会话元数据。 |
| `GET /v1/conversations/:id/messages` | 读取历史分页，支持 `limit`、`beforeIndex`、`offset`、`view`。 |
| `POST /v1/conversations/:id/messages` | 发送用户消息并启动任务。 |
| `GET /v1/runs/:id` | 任务状态；结束后附带最终回复，支持 `wait` 秒数。 |
| `GET /v1/runs/:id/events` | 读取任务事件，支持 `after`、`limit`。 |
| `POST /v1/runs/:id/approvals/:approvalId` | 批准或拒绝待审批的工具调用。 |
| `POST /v1/runs/:id/questions/:questionId` | 回答模型提出的问题。 |
| `POST /v1/runs/:id/cancel` | 取消任务。 |
| `GET /v1/events` | SSE 事件流。 |
| `POST /v1/rpc` | 调用界面同款 RPC，适合尚未封装为 REST 的操作。 |
| `POST /v1/speech` | 使用当前配置合成语音。 |
| `POST /v1/speech/clone` | 使用 Fish Audio 创建私有克隆音色。 |

### 发送消息

```bash
curl -X POST http://127.0.0.1:18766/v1/conversations/<conversationId>/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: review-2026-10-24" \
  -d '{"text":"检查当前工作区的改动","wait":120}'
```

可选字段：

- `agentId`：智能体；省略时使用列表中的第一个。
- `providerId`、`model`、`reasoningEffort`：覆盖本次模型与推理强度，可选值见 `GET /v1/status`。
- `attachments`：附件数组，每项 `{ "name": "...", "mimeType": "image/png", "data": "<base64>" }`。
- `wait`：`true` 表示等到任务结束；数字表示最多等待的秒数（1～3600）。很多代理的命令有超时限制，建议传秒数。
- `requestKey` 或 `Idempotency-Key` 请求头：幂等键。超时后用同一个键重发，返回的是同一个任务，不会重复执行。

任务已经结束时返回 `200`，结构为 `{ "conversationId": "...", "run": { ... }, "done": true, "reply": "最终回复" }`；仍在运行时返回 `202` 与 `"done": false`，之后用 `GET /v1/runs/:id?wait=120` 继续等待。

### 审批与回答

任务状态为 `awaiting_approval` 或 `awaiting_input` 时，响应里的 `pending` 列出正在等待的内容：

```json
{
  "done": false,
  "run": { "id": "<runId>", "status": "awaiting_approval" },
  "pending": {
    "approvals": [{ "id": "<approvalId>", "toolName": "delete_file", "input": { "text": "{\"path\":\"old.log\"}" }, "effects": ["data_delete"] }],
    "questions": []
  }
}
```

- 批准或拒绝：`POST /v1/runs/<runId>/approvals/<approvalId>`，请求体 `{ "accepted": true }` 或 `{ "accepted": false }`。审批带 `choices`（如「只允许这一次」「始终允许」）时改传 `{ "choiceId": "<选项 id>" }`。
- 回答问题：`POST /v1/runs/<runId>/questions/<questionId>`，请求体 `{ "answers": ["蓝色"] }`，与 `questions` 一一对应。

审批和问题在 GrayCode 界面里同样可以处理，先到的一方生效；已经处理过的审批或问题返回 `404`。工具参数超过 2000 字符时 `input` 截断并标记 `truncated`。

### 读取历史

`GET /v1/conversations/:id/messages` 默认返回紧凑形态：每条消息包含 `index`、`role`、正文 `text`，工具调用与结果的摘要（超过 2000 字符截断并标记 `truncated`），以及附件类型；不包含思考内容和 base64 数据，适合直接交给模型阅读。需要原始结构（含附件数据）时加 `view=raw`。

### 错误

错误响应为 `{ "error": "说明", "code": "可选的错误码" }`，按 HTTP 状态区分：

| 状态 | 含义 |
| --- | --- |
| `400` | 参数或业务校验失败，说明里会写出可选值。 |
| `401` | 经网络接口访问时令牌缺失或不正确。 |
| `403` | 经网络接口访问时 `Host` 不是 `localhost` 或 IP 地址。 |
| `404` | 会话、任务或接口不存在；接口不存在时请先读 `GET /v1`。 |
| `405` | 路径存在但不支持该方法，`Allow` 响应头列出可用方法。 |
| `409` | 会话已有任务在运行（`STORAGE_BUSY`），或数据已被其他操作修改。 |
| `413` | 请求体过大。 |
| `502` | 语音合成等上游服务失败（`UPSTREAM_FAILED`）。 |

### 事件流

```bash
curl -N -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:18766/v1/events?types=run.completed,run.failed,approval.requested&conversationId=<id>"
```

默认推送稳定形态的任务事件：`run.created`、`run.completed`、`run.failed`、`approval.requested`、`question.asked`、`tool.started` 等契约里的任务事件，以及 `conversation.changed`。每条事件结构为：

```json
{ "type": "approval.requested", "runId": "<runId>", "conversationId": "<id>", "sequence": 3, "timestamp": 1761300000000, "status": "awaiting_approval", "payload": { } }
```

- `types` 用逗号分隔，按事件的 `type` 过滤。
- `conversationId` 只保留该会话的事件。
- `raw=1` 改为推送全部内部事件（包括流式增量和界面消息），结构随版本变化，只适合调试。`POST /v1/rpc` 同样是内部接口，方法与参数不保证兼容。
- 断线后五分钟内重连时，把最后一条 `id:` 作为 `Last-Event-ID` 请求头（或 `after` 查询参数），服务会从补发缓冲继续；超过五分钟、缓冲已被淘汰或应用重启后收到 `event: reset`，此时重新读取会话与任务状态。

### 安全边界

- 接口以你本人的身份工作，没有单独的只读令牌或工具白名单。
- 任务仍然经过正常的工具权限、工作区与审批流程。能连接本机通道或持有令牌的调用方可以通过接口批准审批，等同于在界面中点击确认；只想让外部程序观察、不想让它批准时，不要把它接入 MCP，也不要把令牌交给它。
- 本机通道的访问范围与 GrayCode 的加密凭据相同：同一系统用户的进程本来就能解密凭据存储，通道没有扩大这个范围。
- 令牌更换并保存后立即生效：端口不变，旧令牌失效，用旧令牌建立的事件流会断开，需要用新令牌重连。修改端口或局域网开关会重新监听；本机通道不受影响。
- 只在本机接入 AI 代理时不需要开启网络接口；需要本机脚本经 TCP 访问时，保持「允许局域网访问」关闭。

## 二、语音合成

打开「设置 → 语音合成」，选择提供商。助手消息的操作栏会出现朗读按钮，再点一次停止；开启「自动朗读助手回复」后，当前会话每轮任务完成时自动朗读本轮最后一条回复，等待审批、取消或出错时不会朗读。长回复边合成边播放：第一段只包含一两句，很快就能出声，播放当前段时合成下一段。合成结果按文本和音色、语速等设置缓存（上限 32 MiB），重读同一条回复不会再次请求提供商，修改这些设置后重新合成。朗读失败会显示在聊天区的错误提示里。

朗读前会把 Markdown 转成纯文字：代码块、图片和网址不读，链接只读文字，标题、列表、强调和表格符号去掉；Fish 的 `[情感]` 与 `<whisper>` 标签原样保留。中文按句号、问号等分句，英文在句号后的空格处分句，再拼成每段最多 1200 字的片段。

### Fish Audio（支持声音克隆）

1. 在 [Fish Audio](https://fish.audio/app/api-keys) 创建 API Key，填入设置并保存。
2. 在「克隆音色」中选择一段清晰、单人说话的参考录音。建议 10 秒以上，1～2 分钟效果更好；支持 WAV、MP3、M4A、Opus。
3. 填写音色名称，可选填写录音中实际说出的文字，然后点击「创建克隆音色」。
4. 创建成功后音色 ID 会自动填入；保存设置即可使用。创建克隆前需要先保存 API Key，此时可以先勾选启用并保存，音色 ID 留空也能保存，朗读时才会提示缺少音色。

模型默认 `drama-3`，通过请求头发送。正文里可以使用 `[轻声]`、`[开心地笑]` 等情感标签，也可以使用 `<whisper>...</whisper>` 控制局部表现。

持久化克隆只需要上传一次录音，之后每次合成都使用 `reference_id`，不会重复上传音频。

### Qwen-Audio-TTS

选择「Qwen-Audio-TTS」，填写 DashScope API Key、模型（默认 `qwen-audio-3.1-tts-flash`）和音色。接口地址默认是 DashScope 的语音合成端点；如果控制台给出的是业务空间域名，请替换成完整地址：

```text
https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
```

服务会接受响应里的 `output.audio.url` 并自动下载，也接受 `output.audio.data` 的 base64 音频。输出格式支持 MP3 和 WAV；Qwen 不支持 Opus。

### OpenAI 兼容接口与本地部署

选择「OpenAI 兼容接口」，把地址填写到 `/v1` 为止，例如：

```text
http://127.0.0.1:8880/v1
```

适用于 Kokoro-FastAPI、openedai-speech 等实现 `/audio/speech` 的本地服务，也可以填写 OpenAI、硅基流动等服务。模型、音色和 API Key 按服务要求填写；本地服务不校验密钥时可以留空。

### Windows 本机语音

选择「Windows 本机语音」，无需网络和 API Key。音色下拉框读取系统已安装的语音包，新安装的语音包重新打开设置页即可看到；使用 SAPI 输出 WAV。第一次朗读时启动一个后台 PowerShell 进程并加载一次系统语音，之后每段直接合成；空闲两分钟后进程自动退出，应用关闭时一并结束。这条路径只支持 Windows。

### 外部调用

控制接口的 `/v1/speech` 与界面共用同一份设置：

```bash
curl -X POST http://127.0.0.1:18766/v1/speech \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"text":"欢迎回来，今天也一起加油吧。"}'
```

返回 `clips` 数组，每个片段包含 `text`、`mimeType` 和 base64 编码的 `base64`。长文本会按句子切分，调用方依次播放即可。

Fish Audio 的克隆也可以直接通过接口完成：

```bash
curl -X POST http://127.0.0.1:18766/v1/speech/clone \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Gray\",\"mimeType\":\"audio/wav\",\"audio\":\"<base64>\"}"
```

返回 `{ "id": "<reference_id>", "state": "trained" }`。创建后的音色 ID 仍需要填入语音设置，才会用于后续合成。
