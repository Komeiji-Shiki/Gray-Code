import { isTrustedApplicationFrame } from '../../../apps/desktop/src/trustedFrame';

describe('桌面应用框架信任校验', () => {
  const main = { frameTreeNodeId: 31, url: 'graycode://app/index.html', detached: false };

  test('允许同一底层主框架的不同包装对象', () => {
    expect(isTrustedApplicationFrame(true, { ...main }, main)).toBe(true);
  });

  test('拒绝未登记窗口、子框架、已分离框架和外部页面', () => {
    expect(isTrustedApplicationFrame(false, { ...main }, main)).toBe(false);
    expect(isTrustedApplicationFrame(true, { ...main, frameTreeNodeId: 32, url: 'graycode://app/chat/platform.html' }, main)).toBe(false);
    expect(isTrustedApplicationFrame(true, { ...main, detached: true }, main)).toBe(false);
    expect(isTrustedApplicationFrame(true, { ...main, url: 'https://example.com/' }, main)).toBe(false);
    expect(isTrustedApplicationFrame(true, null, main)).toBe(false);
  });
});
