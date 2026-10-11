import { PlatformTerminals } from '../../../apps/server/src/terminal/service';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { getDefaultExecuteCommandConfig, type ExecuteCommandToolConfig } from '../../../backend/modules/settings/types/toolsTypes';
import { setLanguage } from '../../../backend/i18n';
import { createTerminalPrompts } from '../../../backend/tools/terminal/promptDescriptionsRuntime';
import { createShellRuntime } from '../../../backend/tools/terminal/shellConfigRuntime';

const terminal = new PlatformTerminals({} as PlatformApplication);
afterEach(() => setLanguage('zh-CN'));

test.each(['zh-CN', 'en'] as const)('%s 声明沿用用户的超时、工作区与实际可选 Shell', language => {
  setLanguage(language);
  const config: ExecuteCommandToolConfig = { ...getDefaultExecuteCommandConfig(), defaultTimeout: 123_000, maxOutputLines: -1,
    defaultShell: 'powershell', shells: [{ type: 'powershell', displayName: 'PowerShell', enabled: true }] };
  const declaration = terminal.tool(config).declaration;
  const fields = declaration.parameters.properties as Record<string, any>;
  expect(fields.timeout.default).toBe(123_000);
  expect(fields.timeout.description).toContain('123000');
  expect(fields.shell.enum).toEqual(['default', 'powershell']);
  expect(fields.cwd.description).toMatch(/任务绑定|bound to this task/);
  expect(fields.cwd.description).not.toMatch(/当前没有打开|No workspace is currently open/);
  expect(declaration.description).toContain('## PowerShell');
  expect(declaration.description).not.toContain('## CMD');
  expect(declaration.description).not.toContain('## WSL');
  for (const syntax of ['argv', '$env:NAME', '$()', 'SSH', 'UTF-8']) expect(declaration.description).toContain(syntax);
  // 只有一种 Shell 时不再出现其他 Shell 的要点。
  expect(declaration.description).not.toMatch(/其他可选 Shell|Other shells/);
  expect(declaration.description).toMatch(/默认不截断|not truncated/);
  // 可选 Shell 只由枚举表达，说明里不再重复清单或放置无信息的占位行。
  expect(declaration.description).not.toMatch(/可用的 Shell|Available shells|可能不可用|may be unavailable|执行前检查|checked for availability/);
  expect(fields.shell.description).not.toContain('powershell');
  expect(fields.background.description).toContain('[Background task completed]');
});

test('同类 POSIX 声明只出现一次，各种 Shell 的特有路径规则仍存在', () => {
  const config: ExecuteCommandToolConfig = { ...getDefaultExecuteCommandConfig(), defaultShell: 'bash', shells:
    (['bash','sh','gitbash','wsl','zsh'] as const).map(type => ({ type, displayName: type, enabled: true })) };
  const text = terminal.tool(config).declaration.description;
  expect(text.match(/## POSIX 共用规则/g)).toHaveLength(1);
  expect(text).toContain('bash'); expect(text).toContain('sh');
  expect(text).toContain('Zsh'); expect(text).toContain('/mnt/c/');
  if (process.platform === 'win32') expect(text).toContain('MSYS_NO_PATHCONV=1');
  expect(text).not.toContain('## PowerShell');
});

test('默认 Shell 写完整规则，其他启用的 Shell 只保留一行要点', () => {
  setLanguage('zh-CN');
  const config: ExecuteCommandToolConfig = { ...getDefaultExecuteCommandConfig(), defaultShell: 'powershell', shells:
    (['powershell', 'cmd', 'bash', 'gitbash', 'wsl'] as const).map(type => ({ type, displayName: type, enabled: true })) };
  const text = terminal.tool(config).declaration.description;
  expect(text).toContain('## PowerShell 规则（默认 Shell）');
  expect(text).toContain('here-string');
  const others = text.slice(text.indexOf('## 其他可选 Shell'), text.indexOf('## 复杂命令'));
  for (const brief of ['CMD：', 'POSIX：', '/mnt/c/', '.exe']) expect(others).toContain(brief);
  if (process.platform === 'win32') expect(others).toContain('MSYS_NO_PATHCONV=1');
  // 非默认 Shell 不展开整节规则，taskId 的用法只说明一次。
  expect(text).not.toContain('## CMD 规则');
  expect(text).not.toContain('cmd 启动时会剥离它');
  expect(text.match(/terminal_task/g)).toHaveLength(1);
});

test('扩展宿主仍明确区分无工作区和多根工作区，不用任务绑定描述代替', () => {
  const config = getDefaultExecuteCommandConfig();
  const prompts = createTerminalPrompts({ shells: createShellRuntime({ getConfig: () => config }),
    roots: () => [], getMaxOutputLines: () => 50 });
  expect(prompts.getCwdParameterDescription([], false)).toContain('当前没有打开工作区');
  const roots = [{ name: 'frontend', path: '/fixture/frontend' }, { name: 'backend', path: '/fixture/backend' }];
  const cwd = prompts.getCwdParameterDescription(roots, true);
  expect(cwd).toContain('@workspace_name/path');
  expect(cwd).toContain('frontend, backend');
});
