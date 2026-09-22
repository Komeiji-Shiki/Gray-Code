import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import MemoryLibrary from '../../../../apps/client/src/components/MemoryLibrary.vue';
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, subscribe: () => () => {} }));
vi.mock('../../../../apps/client/src/state', () => ({ state: { conversationId: 'chat', workspaceId: '' } }));
const record = { id:'one',scopeId:'scope',version:1,kind:'fact',origin:'user',confidence:'confirmed',subject:'项目',text:'端口为 4300。',topic:['项目','部署'],entities:[],dependencies:[{kind:'source',id:'source',version:1}],supersedes:[],validFrom:1,recordedAt:1 };
const source = { id:'source',scopeId:'scope',version:1,origin:'user',text:'请把本项目端口记为 4300。',recordedAt:1 };
const graph = {root:'record:one@1',truncated:false,nodes:[
  {key:'source:source@1',id:'source',scopeId:'scope',version:1,type:'source',side:'dependency',kind:'user',title:'用户来源',preview:source.text,active:true},
  {key:'record:one@1',id:'one',scopeId:'scope',version:1,type:'record',side:'selected',kind:'fact',title:'部署',preview:record.text,active:true},
],edges:[{from:'source:source@1',to:'record:one@1'}]};
const wrappers: ReturnType<typeof mount>[] = [];
const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.call.mockReset();
  mocks.call.mockImplementation(async method => {
    if (method === 'memory.options') return {scopes:[{id:'scope',label:'个人',actorId:'owner',kind:'personal',realm:'real'}],providers:[],policy:{value:{enabled:true,automaticExtraction:false,automaticScopes:[],recallTokens:1200,recallLimit:5,extractionOutputTokens:12288},revision:1}};
    if (method === 'memory.search') return {hits:[{record,score:1,reasons:['主题'],conflicts:[]}],estimatedTokens:40,method:'keyword',truncated:false};
    if (method === 'memory.topics') return {topics:[]};
    if (method === 'memory.jobs') return [];
    if (method === 'memory.get') return {revisions:[record],sources:[source],parents:[],activeVersion:1};
    if (method === 'memory.graph') return graph;
    if (method === 'memory.revise') return {records:[{...record,version:2}]};
    throw new Error('Unexpected method '+method);
  });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); });
async function open() { const wrapper=mount(MemoryLibrary);wrappers.push(wrapper);await flushPromises();await wrapper.find('.memory-record>button').trigger('click');await flushPromises();return wrapper; }

test('关系图按所选修订加载，来源可展开，当前节点可进入编辑并保存', async () => {
  const wrapper=await open();await button(wrapper,'查看关系').trigger('click');await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('memory.graph',expect.objectContaining({scopeId:'scope',id:'one',version:1,limit:40}));
  expect(wrapper.findAll('.memory-graph-edge')).toHaveLength(1);
  await wrapper.find('.memory-graph-node.source').trigger('click');expect(wrapper.find('.memory-source-preview').text()).toContain(source.text);
  await wrapper.find('.memory-graph-node.selected').trigger('click');
  await wrapper.find('textarea[aria-label="记忆正文"]').setValue('端口为 4400。');await button(wrapper,'保存记忆').trigger('click');await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('memory.revise',expect.objectContaining({scopeId:'scope',id:'one',expectedVersion:1,text:'端口为 4400。'}));
});

test('切换关系视图不会丢掉正文草稿', async () => {
  const wrapper=await open();await wrapper.find('textarea[aria-label="记忆正文"]').setValue('未保存的修订');
  await button(wrapper,'查看关系').trigger('click');await flushPromises();expect(wrapper.text()).toContain('正在编辑的草稿仍然保留');
  await button(wrapper,'编辑正文').trigger('click');expect(wrapper.find('textarea[aria-label="记忆正文"]').element.value).toBe('未保存的修订');
});

test('读取记忆失败时显示错误，用户仍可继续浏览', async () => {
  const wrapper=await open();mocks.call.mockImplementation(async method => {if(method==='memory.get')throw new Error('记录暂时不可读');return {};});
  await wrapper.find('.memory-record>button').trigger('click');await flushPromises();
  expect(wrapper.find('[role="alert"]').text()).toBe('记录暂时不可读');expect(button(wrapper,'保存记忆').attributes('disabled')).toBeUndefined();
});
