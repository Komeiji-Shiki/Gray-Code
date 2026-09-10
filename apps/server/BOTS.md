# Bot 接入

Discord 与 OneBot 共用会话路由、平台身份绑定、工具审批、异步问题和待发送消息记录。平台事件提供的用户 ID 才用于身份解析；昵称、群管理员身份和引用文字不授予 GrayCode 权限。配置保存与连接分开操作，保存设置不会自动登录 Bot。

## NapCat 与 OneBot 版本

NapCat 官方当前提供 OneBot 11 接口；OneBot 12 官网仍标为候选标准。两种协议分别适配，共用 WebSocket 连接、重连和请求关联逻辑。设置页选择 NapCat 时使用 OneBot 11；仅在对端实现明确支持 OneBot 12 时选择 v12。

- [NapCat 官方接口文档](https://napneko.github.io/api/)
- [OneBot 11 正向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)
- [OneBot 12 标准](https://12.onebot.dev/)
- [OneBot 12 动作请求与机器人身份](https://12.onebot.dev/connect/data-protocol/action-request/)

当前接入方式为正向 WebSocket：GrayCode 主动连接 NapCat 或其他 OneBot 实现提供的通用接口。地址和访问令牌分别填写；配置中的令牌使用平台密钥存储加密。没有配置鉴权的本地实现可以不填令牌。程序不会安装 NapCat、登录 QQ、修改其服务配置，或自行开启反向 WebSocket 监听。

v11 的允许会话格式为 `group:群号`、`private:QQ号`。v12 另支持 `channel:群组ID:频道ID`，并要求显式填写机器人的 `platform` 与用户 ID，避免共享连接中选错账号。v12 ID 中如包含冒号等地址分隔符，需要做 URL 编码。平台身份绑定也包含平台标识，避免不同平台上相同用户 ID 共用权限。

当前收发以文本为主。回复使用文本消息段，不把模型输出中的 CQ 码解释为提及、图片或管理操作。收到图片、文件等消息段时保留类型占位，不自动下载附件。

## 任务与操作

允许会话中的已绑定用户可以发送任务，或使用以下命令：

- `/gray new`：新建对话。
- `/gray task 对话ID`：选择可访问的已有对话。
- `/gray status`、`/gray cancel`：查看或停止当前任务。
- `/gray answer 提问ID 回答`：答复问题；多个回答用 `|` 分隔。
- `/gray approve 审批ID`、`/gray deny 审批ID`：处理属于当前会话的审批。

任务仍经过核心账号权限检查。OneBot 断线后使用延迟重连，重新连接时核对机器人身份；身份变化需要手动重新连接。发送失败的回复保留在待发送记录中，重连后继续尝试。网络中断导致响应丢失时无法保证消息只发送一次，可能出现重复回复。

本阶段没有连接真实 Bot，没有发送 QQ 或 Discord 消息。按用户要求，本批代码尚未构建或运行验证。
