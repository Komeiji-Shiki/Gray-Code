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
    if (method === 'memory.browse') return {items:[{...record,preview:record.text,moreText:false,active:true}],offset:0,total:1};
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
  await button(wrapper,'编辑正文').trigger('click');expect(wrapper.find<HTMLTextAreaElement>('textarea[aria-label="记忆正文"]').element.value).toBe('未保存的修订');
});

test('读取记忆失败时显示错误，用户仍可继续浏览', async () => {
  const wrapper=await open();mocks.call.mockImplementation(async method => {if(method==='memory.get')throw new Error('记录暂时不可读');return {};});
  await wrapper.find('.memory-record>button').trigger('click');await flushPromises();
  expect(wrapper.find('[role="alert"]').text()).toBe('记录暂时不可读');expect(button(wrapper,'保存记忆').attributes('disabled')).toBeUndefined();
});

test('同层主题可以继续加载，保留前一页目录', async () => {
  const original = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async (method, params) => method === 'memory.topics'
    ? params.cursor ? { topics: [{ scopeId: 'scope', path: ['第二页'], records: 1, summaries: [] }], truncated: false }
      : { topics: [{ scopeId: 'scope', path: ['第一页'], records: 1, summaries: [] }], truncated: true, nextCursor: 'next' }
    : original(method, params));
  const wrapper = await open(); await button(wrapper, '加载更多主题').trigger('click'); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('memory.topics', expect.objectContaining({ scopeId: 'scope', topic: [], cursor: 'next' }));
  expect(wrapper.text()).toContain('第一页'); expect(wrapper.text()).toContain('第二页');
  expect(wrapper.findAll('button').some(item => item.text() === '加载更多主题')).toBe(false);
});

test('人工列表可以前后翻页，原有相关性搜索仍调用搜索接口', async () => {
  const original=mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async(method,params)=>method==='memory.browse'
    ?{items:[{...record,id:params.cursor?'two':'one',preview:params.cursor?'下一页的完整记录':'第一页预览',moreText:true,active:true}],offset:params.cursor?1:0,total:2,...(!params.cursor?{nextCursor:'page-two'}:{})}
    :original(method,params));
  const wrapper=await open();
  await button(wrapper,'下一页记忆').trigger('click');await flushPromises();expect(wrapper.text()).toContain('下一页的完整记录');
  await button(wrapper,'上一页记忆').trigger('click');await flushPromises();expect(wrapper.text()).toContain('第一页预览');
  await wrapper.find('input[aria-label="搜索长期记忆"]').setValue('部署端口');await wrapper.find('form.memory-search').trigger('submit');await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('memory.search',expect.objectContaining({text:'部署端口'}));expect(wrapper.text()).toContain('条相关结果');
});

test('关系节点按确切历史版本打开，并要求回到最新修订后编辑', async () => {
  const original=mocks.call.getMockImplementation()!;
  const old={...record,id:'parent',version:1,text:'旧依据正文'},latest={...old,version:2,text:'最新依据正文'};
  mocks.call.mockImplementation(async(method,params)=>{
    if(method==='memory.graph')return {...graph,nodes:[...graph.nodes,{key:'record:parent@1',id:'parent',scopeId:'scope',version:1,type:'record',side:'dependency',kind:'fact',title:'旧版本依据',preview:old.text,active:false}],edges:[...graph.edges,{from:'record:parent@1',to:graph.root}]};
    if(method==='memory.get'&&params.id==='parent')return {revisions:[latest,old],sources:[],parents:[],activeVersion:2};
    return original(method,params);
  });
  const wrapper=await open();await button(wrapper,'查看关系').trigger('click');await flushPromises();
  await wrapper.findAll('.memory-graph-node').find(node=>node.text().includes('旧版本依据'))!.trigger('click');await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('memory.get',expect.objectContaining({id:'parent',version:1}));
  await button(wrapper,'编辑正文').trigger('click');
  expect(wrapper.find<HTMLTextAreaElement>('textarea[aria-label="记忆正文"]').element.value).toBe(old.text);
  expect(button(wrapper,'保存记忆').attributes('disabled')).toBeDefined();
  await button(wrapper,'返回最新修订再编辑').trigger('click');await flushPromises();
  expect(wrapper.find<HTMLTextAreaElement>('textarea[aria-label="记忆正文"]').element.value).toBe(latest.text);expect(button(wrapper,'保存记忆').attributes('disabled')).toBeUndefined();
});

test('实体关联使用虚线，来源依据继续显示箭头',async()=>{
  const original=mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async(method,params)=>method==='memory.graph'?{...graph,nodes:[...graph.nodes,{key:'record:entity@2',id:'entity',scopeId:'scope',version:2,type:'record',side:'related',kind:'fact',title:'关联实体',preview:'实体的当前说明',active:true}],edges:[...graph.edges,{from:graph.root,to:'record:entity@2',association:true}]}:original(method,params));
  const wrapper=await open();await button(wrapper,'查看关系').trigger('click');await flushPromises();
  expect(wrapper.findAll('.memory-graph-node')).toHaveLength(3);
  expect(wrapper.find('.memory-graph-edge.association').attributes('marker-end')).toBeUndefined();
  expect(wrapper.find('.memory-graph-edge:not(.association)').attributes('marker-end')).toContain('memory-arrow');
});


test('加载下一页时明确显示读取状态，完成后再更新页数与可操作记录', async () => {
  const original=mocks.call.getMockImplementation()!;
  let complete!:(value:unknown)=>void;
  mocks.call.mockImplementation((method,params)=>method==='memory.browse'
    ? params.cursor ? new Promise(resolve=>{complete=resolve;}) : Promise.resolve({items:[{...record,preview:record.text,active:true}],offset:0,total:2,nextCursor:'next'})
    :original(method,params));
  const wrapper=await open();await button(wrapper,'下一页记忆').trigger('click');
  expect(wrapper.find('.memory-pagination').text()).toContain('正在读取记忆');
  expect(wrapper.find('.memory-pagination').text()).not.toContain('1–1 / 2');
  expect(wrapper.find('.memory-records').attributes('aria-busy')).toBe('true');
  expect(wrapper.find('.memory-record>button').attributes('disabled')).toBeDefined();
  complete({items:[{...record,id:'two',preview:'已读到第二页',active:true}],offset:1,total:2});await flushPromises();
  expect(wrapper.find('.memory-pagination').text()).toContain('2–2 / 2');
  expect(wrapper.find('.memory-records').attributes('aria-busy')).toBe('false');
  expect(wrapper.find('.memory-record>button').attributes('disabled')).toBeUndefined();
});
