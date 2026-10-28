import { expect, test } from 'vitest';
import { WORKSPACE_PANEL_MESSAGE, readWorkspacePanelMessage } from '../../../../shared/workspacePanelNavigation';
import { settingsSearchIndex } from '../../components/settings/panel/settingsSearchIndex';
test('陪伴全局配置与 Clawd 联动分别进入陪伴和集成分类', () => {
  const index = settingsSearchIndex(true);
  expect(index.find(item => item.key === 'companion-features')?.tab).toBe('companion');
  expect(index.find(item => item.key === 'companion-pet-preferences')?.anchor).toBe('[data-search-anchor="companion-pet-preferences"]');
  expect(index.find(item => item.key === 'companion-vision-defaults')?.tab).toBe('companion');
  expect(index.find(item => item.key === 'clawd-integration')?.tab).toBe('clawd');
  expect(index.filter(item => item.tab === 'appearance').some(item => item.key.includes('companion') || item.key.includes('clawd'))).toBe(false);
});
test('设置搜索不再保留已移除的长期记忆页面跳转', () => {
  expect(settingsSearchIndex(true).some(item => item.key === 'memory-library')).toBe(false);
  expect(settingsSearchIndex(true).find(item => item.key === 'companion-features')?.keywords).toContain('Live2D');
});
test('仅接受当前聊天页面、相同来源和明确的面板名称', () => {
  const source = {}, other = {}, origin = 'graycode://app';
  const event = { source, origin, data: { type: WORKSPACE_PANEL_MESSAGE, panel: 'memory' } };
  expect(readWorkspacePanelMessage(event, source, origin)).toBe('memory');
  expect(readWorkspacePanelMessage({ ...event, source: other }, source, origin)).toBeUndefined();
  expect(readWorkspacePanelMessage({ ...event, origin: 'https://external.example' }, source, origin)).toBeUndefined();
  expect(readWorkspacePanelMessage({ ...event, data: { ...event.data, panel: 'settings.delete' } }, source, origin)).toBeUndefined();
  expect(readWorkspacePanelMessage({ ...event, data: null }, source, origin)).toBeUndefined();
  expect(readWorkspacePanelMessage({ ...event, source: null }, null, origin)).toBeUndefined();
});
