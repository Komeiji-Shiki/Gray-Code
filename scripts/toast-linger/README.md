# toast-linger

Windows 系统通知辅助进程（`.NET Framework 4.x`，无运行时第三方依赖）。被扩展的
`show_windows_notification` / Agent 停止通知链路启动：发送 WinRT toast 后用消息循环
保持进程存活（Win11 24H2+/25H2 上只有进程内 `Activated` 事件能可靠响应点击）；点击
toast 时聚焦 VS Code 窗口并写 marker 文件供扩展读取。

源码：`Program.netfx.cs`（单文件）。
发布产物：`resources/bin/toast-linger.exe`（随 vsix 打包分发）。

## 编译

前提（一次性）：

- Windows 10/11 + **Visual Studio Build Tools 或 Visual Studio**（含 MSBuild 组件）；
- **Windows 10 SDK**（需要 `UnionMetadata\<version>\Windows.winmd`，脚本自动从常见版本中探测）；
- **.NET Framework 4.7.2 开发包**（引用程序集，VS Build Tools 安装时可勾选）。

一键编译（输出覆盖 `resources/bin/toast-linger.exe`）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\toast-linger\build.ps1
```

等价的手工 MSBuild 命令（产物在 `scripts/toast-linger/bin/Release/`，不覆盖发布产物）：

```powershell
msbuild scripts\toast-linger\toast-linger.csproj /t:Build /p:Configuration=Release
```

## 构建定义说明

`toast-linger.csproj` 要点：

- `TargetFrameworkVersion = v4.7.2`（体积最小、启动快，随 .NET Framework 4.7.2+ 系统自带）；
- WinRT 投影引用：`<Reference Include="Windows">` → Windows 10 SDK `UnionMetadata` 下的
  `Windows.winmd`（csproj 内 `Choose` 按 26100 → 22621 → 22000 → 19041 → 18362 依次探测）；
- `<Reference Include="System.Runtime.WindowsRuntime">` 直接指向 CLR 运行时目录
  （`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\`，.NET Framework 的 Facades 引用程序集目录
  通常不含该文件），`Private=false` 不随产物复制；
- 其余仅系统程序集（System / System.Core / System.Windows.Forms / System.Xml）；
- 无 NuGet 依赖，离线可编译。

⚠️ 覆盖 `resources/bin/toast-linger.exe` 前请在本机实测：通知能显示、点击能聚焦 VS Code、
`%TEMP%\graycode-toast-linger.log` 无异常。该二进制直接影响 Windows 用户的通知功能。

## 运行参数

```
toast-linger.exe <aumid> <title> <message> [lingerMs] [silent]
```

- `aumid`：AppUserModelID（默认 `GrayCode.Notification`）；进程会自注册开始菜单快捷方式
  （`%APPDATA%\Microsoft\Windows\Start Menu\Programs\GrayCode.lnk`）以启用 toast；
- `title` / `message`：toast 标题与正文（源码内已做 XML 转义，可安全包含 `&`、`<` 等）；
- `lingerMs`：消息循环保持时长（默认 30000ms；解析失败记日志并回退默认值）；
- `silent`：`true` = 静默 toast（默认），`false` = 播放默认通知音（解析失败记日志并回退默认值）；
- 退出码：0 = 正常结束；2 = toast 构建/显示失败（详见日志）。

日志：`%TEMP%\graycode-toast-linger.log`（超过 1 MB 自动截断重建）。
点击标记：`%TEMP%\graycode-toast-clicked.flag`。
