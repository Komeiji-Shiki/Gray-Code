# 开始使用

[返回目录](Home.md)

本指南帮助你快速完成 GrayCode 的安装、模型渠道配置及第一个编程任务。

---

## 1. 安装与运行

### Windows 桌面版
- **便携版（Portable）**：解压压缩包到任意非系统受限目录，直接双击运行 `GrayCode.exe`。
- **安装版（Setup）**：运行安装包，默认安装至 `%LOCALAPPDATA%\GrayCode`，自带自动更新与快捷方式。

### 数据存储路径
- **应用数据目录**：默认位于 `%APPDATA%\GrayCode\platform-data`，用于存储 SQLite 数据库、会话历史、项目绑定与缓存。
- **便携模式**：便携版可在程序根目录下使用 `portable-data` 目录，便于将模型配置、提示词模板、MCP 与主题随移动设备携带。
- **自定义数据目录**：开发或多实例运行时，可以通过 `--data` 参数指定数据路径：
  ```powershell
  npm run desktop -- --data .tmp/desktop-local
  ```

---

## 2. 配置模型渠道

1. 点击界面左侧导航栏的 **设置（Settings）→ 渠道（Channels）**。
2. 点击 **添加渠道**，选择对应的接口协议：
   - **OpenAI Compatible**：适用于绝大多数兼容 OpenAI 格式的 API（如 DeepSeek、SiliconFlow、OneAPI、Ollama 等）。
   - **OpenAI Responses**：适用于支持 OpenAI 最新 Responses 协议的端点。
   - **Anthropic**：适用于 Claude 官方 API 或兼容端点。
   - **Gemini**：适用于 Google Gemini 官方 API。
3. 填入你的 **API 密钥（API Key）**、**Base URL** 与 **默认模型名称**。
4. 按需配置以下高级选项：
   - **思考模式（Reasoning / Thinking）**：针对各类具备深度思考能力的推理模型开启思考支持，或设定思考 Token 预算。
   - **多模态（Vision）**：勾选后允许发送图片、截图与 PDF。
   - **DeepSeek Vision 预处理**：当使用 DeepSeek 视觉模型时开启，支持 PDF 逐页渲染与 GIF 拆帧。
5. 点击 **保存全部** 完成配置。

---

## 3. 开始你的第一个任务

1. 在左侧面板打开或添加一个本地项目目录作为当前 **工作区**。
2. 在底部输入框上方选择配置好的 **渠道** 与 **模型**。
3. 选择合适的交互模式：
   - **Code**：常规编码模式，模型会自动读取、搜索代码、执行修改与终端测试。
   - **Ask**：问答与咨询模式，仅搜索和读取代码，默认不修改工作区文件。
   - **Design**：生成架构与技术设计方案文档。
   - **Plan**：拆解任务计划与实施步骤。
   - **Review**：代码审查模式，审查变更并给出改进意见。
4. 输入你的任务需求，例如：
   > 请阅读当前项目的代码结构，分析核心业务流程，并为主要模块提供一个快速上手说明。

---

## 4. 从源码构建与开发

如果你需要从源码构建 GrayCode：

```powershell
# 1. 安装根目录与前端依赖
npm ci
npm --prefix frontend ci

# 2. 构建桌面端并启动调试
npm run build:desktop
npm run desktop -- --data .tmp/desktop-local
```

> 提示：更多开发者信息请参阅仓库根目录的 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [PROJECT_STRUCTURE.md](../PROJECT_STRUCTURE.md)。

---

## 5. CLI 与 Web 模式

GrayCode 的核心服务层可以独立于桌面端在服务器或命令行运行：

```powershell
# 编译平台核心
npm run build:platform

# 启动 CLI 或本地 Web 服务
npm run platform -- serve --web --port 3000
```

关于 Web 模式的认证、HTTPS 代理与多用户配置，请参考 [Web 服务文档](../apps/server/WEB.md)。
