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
  expect(fields.cwd.description).toMatch(/任务绑定|task’s bound/);
  expect(fields.cwd.description).not.toMatch(/当前没有打开|No workspace is currently open/);
  expect(declaration.description).toContain('## PowerShell');
  expect(declaration.description).not.toContain('## CMD');
  expect(declaration.description).not.toContain('## WSL');
  for (const syntax of ['argv', '$env:NAME', '$(hostname)', 'SSH', 'UTF-8']) expect(declaration.description).toContain(syntax);
  expect(declaration.description).toMatch(/默认不截断|not truncated/);
  expect(fields.background.description).toContain('[Background task completed]');
});

test('同类 POSIX 声明只出现一次，各种 Shell 的特有路径规则仍存在', () => {
  const config: ExecuteCommandToolConfig = { ...getDefaultExecuteCommandConfig(), defaultShell: 'bash', shells:
    (['bash','sh','gitbash','wsl','zsh'] as const).map(type => ({ type, displayName: type, enabled: true })) };
  const text = terminal.tool(config).declaration.description;
  expect(text.match(/## POSIX 共用规则/g)).toHaveLength(1);
  expect(text).toContain('bash'); expect(text).toContain('sh');
  expect(text).toContain('Zsh'); expect(text).toContain('/mnt/c/Users');
  if (process.platform === 'win32') expect(text).toContain('MSYS_NO_PATHCONV=1');
  expect(text).not.toContain('## PowerShell');
});

test('扩展宿主仍明确区分无工作区和多根工作区，不用任务绑定描述代替', () => {
  const config = getDefaultExecuteCommandConfig();
  const prompts = createTerminalPrompts({ shells: createShellRuntime({ getConfig: () => config }),
    roots: () => [], getMaxOutputLines: () => 50 });
  expect(prompts.getCwdParameterDescription([], false)).toContain('当前没有打开 workspace');
  const roots = [{ name: 'frontend', path: '/fixture/frontend' }, { name: 'backend', path: '/fixture/backend' }];
  const cwd = prompts.getCwdParameterDescription(roots, true);
  expect(cwd).toContain('@workspace_name/path');
  expect(cwd).toContain('frontend, backend');
});
