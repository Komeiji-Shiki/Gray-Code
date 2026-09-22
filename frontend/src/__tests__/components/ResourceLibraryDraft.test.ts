import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ResourceLibrary from '../../../../apps/client/src/components/ResourceLibrary.vue';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, subscribe: () => () => {} }));
vi.mock('../../../../apps/client/src/state', () => ({ state: { conversationId: undefined, workspaceId: '' } }));
const wrappers: ReturnType<typeof mount>[] = [];
const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
let resources: Array<any>;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  resources = [
    { id: 'card', name: '原角色', kind: 'character', revision: 1, bindings: { worldbookIds: [], regexIds: [], missing: [] }, raw: {} },
    { id: 'book', name: '原世界书', kind: 'worldbook', revision: 1, bindings: { worldbookIds: [], regexIds: [], missing: [] }, raw: { entries: [{ id: 0, comment: '地点', content: '原世界书正文', keys: ['地点'], enabled: true }] } },
    { id: 'image', name: '无法读取的图片卡', kind: 'character', revision: 1, bindings: { worldbookIds: [], regexIds: [], missing: [] }, raw: {} },
  ];
  mocks.call.mockReset();
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'memory.options') return { scopes: [{ id: 'personal', label: '个人', actorId: 'owner', kind: 'personal', realm: 'real' }], providers: [], policy: { revision: 1, value: { enabled: true, automaticExtraction: false, automaticScopes: [], recallLimit: 5, recallTokens: 1200, extractionOutputTokens: 12288 } } };
    if (method === 'memory.search') return { hits: [], method: 'keyword', estimatedTokens: 0 };
    if (method === 'memory.browse') return { items: [], offset: 0, total: 0 };
    if (method === 'memory.topics') return { topics: [] };
    if (method === 'memory.jobs') return [];
    if (params.type === 'characters.list') return resources.map(({ raw, ...info }) => structuredClone(info));
    const item = resources.find(item => item.id === params.data?.id);
    if (params.type === 'characters.get') return { info: { ...structuredClone(item), source: { mimeType: item.id === 'image' ? 'image/png' : 'application/json' } }, resource: { raw: structuredClone(item.raw) }, revision: item.revision };
    if (params.type === 'characters.original') throw new Error('图片暂时不可读');
    if (params.type === 'characters.bind') { Object.assign(item, params.data); item.revision++; return {}; }
    throw new Error(params.type ?? method);
  });
});
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()));
async function open(props: Record<string, unknown> = {}) { const wrapper = mount(ResourceLibrary, { props }); wrappers.push(wrapper); await flushPromises(); return wrapper; }
async function choose(wrapper: ReturnType<typeof mount>, name: string) { await wrapper.findAll('.resource-row').find(row => row.text().includes(name))!.trigger('click'); await flushPromises(); }

test('名称草稿在关闭、Escape 和切换资料时受到保护', async () => {
  const wrapper = await open(); await choose(wrapper, '原角色');
  await wrapper.find('.resource-columns>main>label input').setValue('未保存的名称');
  await wrapper.find('dialog').trigger('cancel'); expect(wrapper.emitted('close')).toBeUndefined();
  await button(wrapper, '继续编辑').trigger('click'); expect(wrapper.find<HTMLInputElement>('.resource-columns>main>label input').element.value).toBe('未保存的名称');
  await choose(wrapper, '原世界书'); expect(wrapper.find('.resource-heading').text()).toContain('角色卡');
  await button(wrapper, '放弃更改并继续').trigger('click'); await flushPromises(); expect(wrapper.find('.resource-heading').text()).toContain('世界书');
});

test('单独保存名称保留世界书正文草稿，关闭仍提示未保存', async () => {
  const wrapper = await open(); await choose(wrapper, '原世界书');
  await wrapper.find('.worldbook-entry textarea[rows="5"]').setValue('尚未保存的世界书正文');
  await wrapper.find('.resource-columns>main>label input').setValue('新世界书名称');
  await button(wrapper, '保存名称与绑定').trigger('click'); await flushPromises();
  expect(wrapper.find<HTMLTextAreaElement>('.worldbook-entry textarea[rows="5"]').element.value).toBe('尚未保存的世界书正文');
  expect(button(wrapper, '保存世界书').attributes('disabled')).toBeUndefined();
  await button(wrapper, '关闭').trigger('click'); expect(wrapper.emitted('close')).toBeUndefined(); expect(wrapper.text()).toContain('资料库还有未保存的更改');
});

test('打开桌宠检查记忆设置草稿，放弃后先关闭原窗口再跳转', async () => {
  const events: string[] = [], wrapper = await open({ initialTab: 'memory', onClose: () => events.push('close'), onPets: () => events.push('pets') });
  await button(wrapper, '整理方式').trigger('click');
  await wrapper.find('input[aria-label="最多引用条数"]').setValue(8);
  await button(wrapper, '桌宠与 Live2D').trigger('click'); expect(events).toEqual([]);
  await button(wrapper, '放弃更改并继续').trigger('click'); await flushPromises(); expect(events).toEqual(['close', 'pets']);
});

test('新图片读取失败时保留原资料完整表单，不显示新旧资料混合状态', async () => {
  const wrapper = await open(); await choose(wrapper, '原世界书'); await choose(wrapper, '无法读取的图片卡');
  expect(wrapper.find('.resource-error').text()).toBe('图片暂时不可读');
  expect(wrapper.find('.resource-heading').text()).toContain('世界书'); expect(wrapper.find<HTMLInputElement>('.resource-columns>main>label input').element.value).toBe('原世界书');
});
