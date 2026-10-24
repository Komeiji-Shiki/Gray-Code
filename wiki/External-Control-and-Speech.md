# 外部控制接口与语音合成

GrayCode 2.x 提供一个本地 HTTP 控制接口，让脚本、Stream Deck、桌面小工具、Claude Code 与 Codex 等 AI 代理或其他应用直接驱动 GrayCode；同时提供统一的语音合成能力，支持云端接口、本地部署和 Windows 本机语音。

## 一、外部控制接口

### 启用

打开「设置 → 外部控制」：

1. 勾选「启用外部控制接口」。
2. 选择监听端口。`0` 表示由系统分配空闲端口；需要固定地址时填写 `18766` 等端口。
3. 生成访问令牌。令牌至少 32 个字符，保存时写入加密凭据。
4. 保存全部设置，再点击「启动已保存的接口」。

接口默认只监听 `127.0.0.1`。开启「允许局域网访问」后会监听 `0.0.0.0`，局域网内其他设备可以用 HTTP 直接访问；这条通道没有 TLS，令牌和消息内容不会加密，只建议在可信网络中使用。

关闭主窗口后，只要接口仍在监听，应用会继续留在后台；手动停止或启动失败（如端口被占用）后不再保持后台。使用 `npm run platform -- --data <目录> serve` 运行无界面服务时，只要保存过的设置里启用了外部控制接口，它也会随服务一起启动。

### 让 AI 代理直接使用

接口监听时，GrayCode 会在 `~/.graycode/control-api/<进程号>.json` 写入发现文件，内容包括 `url`、`token`、`pid`、`version` 与 `dataDirectory`；接口停止或应用退出时删除，异常退出留下的旧文件会在下次写入时清理。Windows 上对应 `%USERPROFILE%\.graycode\control-api\`。

Claude Code、Codex 等本机代理只需要知道这个约定：读取发现文件拿到地址和令牌，再请求 `GET /v1`，返回内容列出全部接口、参数、等待方式和错误码，按说明调用即可。可以在代理的项目说明（如 `CLAUDE.md`、`AGENTS.md`）里写一句：

```text
GrayCode 外部控制接口：读取 ~/.graycode/control-api/*.json 取得 url 与 token，GET {url}/v1 查看用法。
```

发现文件里的令牌与加密凭据的访问范围相同：同一系统用户的进程本来就能解密 GrayCode 的凭据存储，文件只是多了一个约定位置。

### 认证

所有请求都需要附带令牌：

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:18766/v1
```

也可以使用 `X-GrayCode-Token: <token>`。令牌等同于主人权限，不要写进浏览器地址栏、公开日志或会提交到仓库的脚本。

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
| `POST /v1/runs/:id/cancel` | 取消任务。 |
| `GET /v1/events` | SSE 事件流。 |
| `POST /v1/rpc` | 调用界面同款 RPC，适合尚未封装为 REST 的操作。 |
| `POST /v1/speech` | 使用当前配置合成语音。 |
| `POST /v1/speech/clone` | 使用 Fish Audio 创建私有克隆音色。 |

### 发送消息

```bash
curl -X POST http://127.0.0.1:18766/v1/conversations/<conversationId>/messages   -H "Authorization: Bearer <token>"   -H "Content-Type: application/json"   -H "Idempotency-Key: review-2026-10-24"   -d '{"text":"检查当前工作区的改动","wait":120}'
```

可选字段：

- `agentId`：智能体；省略时使用列表中的第一个。
- `providerId`、`model`、`reasoningEffort`：覆盖本次模型与推理强度，可选值见 `GET /v1/status`。
- `attachments`：附件数组，每项 `{ "name": "...", "mimeType": "image/png", "data": "<base64>" }`。
- `wait`：`true` 表示等到任务结束；数字表示最多等待的秒数（1～3600）。很多代理的命令有超时限制，建议传秒数。
- `requestKey` 或 `Idempotency-Key` 请求头：幂等键。超时后用同一个键重发，返回的是同一个任务，不会重复执行。

任务已经结束时返回 `200`，结构为 `{ "conversationId": "...", "run": { ... }, "done": true, "reply": "最终回复" }`；仍在运行时返回 `202` 与 `"done": false`，之后用 `GET /v1/runs/:id?wait=120` 继续等待。任务状态为 `awaiting_approval` 或 `awaiting_input` 时，表示在等 GrayCode 界面中的审批或回答。

### 读取历史

`GET /v1/conversations/:id/messages` 默认返回紧凑形态：每条消息包含 `index`、`role`、正文 `text`，工具调用与结果的摘要（超过 2000 字符截断并标记 `truncated`），以及附件类型；不包含思考内容和 base64 数据，适合直接交给模型阅读。需要原始结构（含附件数据）时加 `view=raw`。

### 错误

错误响应为 `{ "error": "说明", "code": "可选的错误码" }`，按 HTTP 状态区分：

| 状态 | 含义 |
| --- | --- |
| `400` | 参数或业务校验失败，说明里会写出可选值。 |
| `401` | 令牌缺失或不正确。 |
| `404` | 会话、任务或接口不存在；接口不存在时请先读 `GET /v1`。 |
| `405` | 路径存在但不支持该方法，`Allow` 响应头列出可用方法。 |
| `409` | 会话已有任务在运行（`STORAGE_BUSY`），或数据已被其他操作修改。 |
| `413` | 请求体过大。 |
| `502` | 语音合成等上游服务失败（`UPSTREAM_FAILED`）。 |

### 事件流

```bash
curl -N -H "Authorization: Bearer <token>"   "http://127.0.0.1:18766/v1/events?types=run.completed,run.failed&conversationId=<id>"
```

- `types` 用逗号分隔，同时匹配顶层事件与 `event` 内的运行事件。
- `conversationId` 只保留与该会话有关的事件。
- 断线后五分钟内重连时，把最后一条 `id:` 作为 `Last-Event-ID` 请求头（或 `after` 查询参数），服务会从补发缓冲继续；超过五分钟、缓冲已被淘汰或应用重启后收到 `event: reset`，此时重新读取会话与任务状态。

### 安全边界

- 接口只以主人身份工作，没有单独的只读令牌或工具白名单。
- 任务仍然经过正常的工具权限、工作区与审批流程；接口不会绕过确认。
- 令牌更换并保存后立即生效：端口不变，旧令牌失效，用旧令牌建立的事件流会断开，需要用新令牌重连。修改端口或局域网开关会重新监听。
- 只需要本机脚本访问时，保持「允许局域网访问」关闭。

## 二、语音合成

打开「设置 → 语音合成」，选择提供商。助手消息的操作栏会出现朗读按钮；开启「自动朗读助手回复」后，每轮任务结束会自动朗读本轮最后一条回复。

### Fish Audio（支持声音克隆）

1. 在 [Fish Audio](https://fish.audio/app/api-keys) 创建 API Key，填入设置并保存。
2. 在「克隆音色」中选择一段清晰、单人说话的参考录音。建议 10 秒以上，1～2 分钟效果更好；支持 WAV、MP3、M4A、Opus。
3. 填写音色名称，可选填写录音中实际说出的文字，然后点击「创建克隆音色」。
4. 创建成功后音色 ID 会自动填入；保存设置即可使用。

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

选择「Windows 本机语音」，无需网络和 API Key。音色下拉框读取系统已安装的语音包；使用 SAPI 输出 WAV。这条路径只支持 Windows。

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
