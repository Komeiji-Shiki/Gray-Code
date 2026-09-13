<script setup lang="ts">
import {computed,onMounted,onUnmounted,reactive,ref} from 'vue';
import type {LongMemoryArchive,LongMemoryJob,LongMemoryPolicy,LongMemoryRecall,LongMemoryRecord,LongMemoryScope,LongMemorySource,LongMemoryTopic} from '@graycode/contracts';
import {call,subscribe} from '../api';
import {state} from '../state';

interface ScopeRow extends LongMemoryScope {label:string}
interface Options {scopes:ScopeRow[];policy:{value:LongMemoryPolicy;revision:number|null};providers:Array<{id:string;name:string;model:string;models:string[]}>}
interface Detail {revisions:LongMemoryRecord[];sources:LongMemorySource[];parents:LongMemoryRecord[];activeVersion?:number}
const emit=defineEmits<{close:[]}>();
const options=ref<Options>(),scopeId=ref(''),section=ref<'records'|'organize'|'jobs'>('records');
const searchText=ref(''),appliedQuery=ref(''),topicPath=ref<string[]>([]),kind=ref('');
const result=ref<LongMemoryRecall>(),topics=ref<LongMemoryTopic[]>([]),detail=ref<Detail>(),jobs=ref<LongMemoryJob[]>([]);
const error=ref(''),notice=ref(''),busy=ref(false),loading=ref(false),changedElsewhere=ref(false);
const editing=ref(false),editingScopeId=ref(''),editingId=ref(''),editingVersion=ref(0),editorBaseline=ref('');
const pendingNavigation=ref<(()=>Promise<void>|void)|null>(null),pendingClose=ref(false);
const selectedIds=ref<string[]>([]),summaryTopic=ref(''),deleteImpact=ref<{recordCount:number;sourceCount:number;items:Array<{id:string;kind:string;text:string}>;truncated:boolean}|null>(null);
const importPreview=ref<LongMemoryArchive|null>(null),embeddingCredential=ref(''),policyBaseline=ref('');
const policy=reactive<LongMemoryPolicy>({enabled:true,automaticExtraction:false,automaticScopes:[],recallTokens:1200,recallLimit:5,extractionOutputTokens:12288});
const embeddingEnabled=ref(false);
const embedding=reactive({url:'',model:'',credentialRef:undefined as string|undefined,dimensions:'' as string,queryPrefix:'',documentPrefix:''});
const form=reactive({text:'',kind:'fact' as LongMemoryRecord['kind'],subject:'',topic:'',attribute:'',value:'',validFrom:'',validTo:'',eventAt:'',confidence:'confirmed' as LongMemoryRecord['confidence']});
let epoch=0,editorEpoch=0,refreshTimer:ReturnType<typeof setTimeout>|undefined;
const kinds:Record<string,string>={fact:'事实',preference:'偏好',experience:'经历与经验',project:'项目知识',procedure:'操作方法',event:'事件',summary:'分层摘要'};
const origins:Record<string,string>={user:'用户陈述',model:'模型提炼',tool:'工具结果',fiction:'角色剧情',import:'导入资料'};
const statuses:Record<string,string>={pending:'等待中',running:'正在整理',completed:'完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
const provider=computed(()=>options.value?.providers.find(item=>item.id===policy.providerId));
const draftPolicy=()=>({...policy,automaticScopes:[...policy.automaticScopes??[]],embedding:embeddingEnabled.value?{url:embedding.url,model:embedding.model,credentialRef:embedding.credentialRef,
  dimensions:embedding.dimensions?Number(embedding.dimensions):undefined,queryPrefix:embedding.queryPrefix,documentPrefix:embedding.documentPrefix}:undefined});
const editorDirty=computed(()=>editing.value&&JSON.stringify(form)!==editorBaseline.value);
const policyDirty=computed(()=>!!options.value&&(JSON.stringify(draftPolicy())!==policyBaseline.value||!!embeddingCredential.value));
const dirty=computed(()=>editorDirty.value||policyDirty.value);
const scopeLabel=(id:string)=>options.value?.scopes.find(scope=>scope.id===id)?.label??id;
const rpc=<T,>(method:string,params:Record<string,unknown>={})=>call<T>(method,{conversationId:state.conversationId??undefined,workspaceId:state.workspaceId||undefined,...params});
const date=(value?:number)=>value===undefined?'':new Date(value).toISOString().slice(0,16);
const fromDate=(value:string)=>value?Date.parse(value+'Z'):undefined;
// 控件只显示到分钟，未编辑的时间保留原秒和毫秒，避免普通文字修改改变时效。
const savedDate=(value:string,original?:number)=>value===date(original)?original:fromDate(value);
const stamp=(value?:number)=>value===undefined?'未记录':new Date(value).toLocaleString();
const topicParts=(value:string)=>value.split('/').map(part=>part.trim()).filter(Boolean);
function setPolicy(value:LongMemoryPolicy){
  Object.assign(policy,{...value,automaticScopes:[...value.automaticScopes??[]]});embeddingEnabled.value=!!value.embedding;
  Object.assign(embedding,{url:value.embedding?.url??'',model:value.embedding?.model??'',credentialRef:value.embedding?.credentialRef,dimensions:value.embedding?.dimensions?String(value.embedding.dimensions):'',queryPrefix:value.embedding?.queryPrefix??'',documentPrefix:value.embedding?.documentPrefix??''});
  embeddingCredential.value='';policyBaseline.value=JSON.stringify(draftPolicy());
}
async function perform(action:()=>Promise<void>){
  if(busy.value)return;busy.value=true;error.value='';notice.value='';
  try{await action();}catch(cause){error.value=(cause as Error).message;}finally{busy.value=false;}
}
async function reload(){
  if(!scopeId.value)return;const current=++epoch,scope=scopeId.value;loading.value=true;
  try{
    const [found,directory,list]=await Promise.all([
      rpc<LongMemoryRecall>('memory.search',{scopeId:scope,text:appliedQuery.value||undefined,topic:topicPath.value,kinds:kind.value?[kind.value]:undefined}),
      rpc<{topics:LongMemoryTopic[]}>('memory.topics',{scopeId:scope,topic:topicPath.value}),
      rpc<LongMemoryJob[]>('memory.jobs',{scopeId:scope}),
    ]);
    if(current!==epoch)return;result.value=found;topics.value=directory.topics;jobs.value=list.sort((a,b)=>b.updatedAt-a.updatedAt);
    selectedIds.value=selectedIds.value.filter(id=>found.hits.some(hit=>hit.record.id===id));
  }finally{if(current===epoch)loading.value=false;}
}
async function loadOptions(){
  const next=await rpc<Options>('memory.options');options.value=next;
  if(!policyDirty.value||!policyBaseline.value)setPolicy(next.policy.value);
  if(!scopeId.value||!next.scopes.some(scope=>scope.id===scopeId.value))scopeId.value=next.scopes[0]?.id??'';
  await reload();
}
function resetEditor(){editorEpoch++;editing.value=false;detail.value=undefined;editingId.value='';deleteImpact.value=null;changedElsewhere.value=false;}
async function navigate(action:()=>Promise<void>|void){if(editorDirty.value){pendingNavigation.value=action;return;}await action();}
async function choose(id:string){
  const current=++editorEpoch,scope=scopeId.value,data=await rpc<Detail>('memory.get',{scopeId:scope,id});if(current!==editorEpoch)return;if(!data.revisions.length){resetEditor();return;}
  const record=data.revisions[0];detail.value=data;editingScopeId.value=scope;editingId.value=id;editingVersion.value=record.version;editing.value=true;changedElsewhere.value=false;deleteImpact.value=null;
  Object.assign(form,{text:record.text,kind:record.kind,subject:record.subject,topic:record.topic.join(' / '),attribute:record.attribute??'',value:record.value??'',validFrom:date(record.validFrom),validTo:date(record.validTo),eventAt:date(record.eventAt),confidence:record.confidence});
  editorBaseline.value=JSON.stringify(form);
}
function create(){
  resetEditor();editing.value=true;editingScopeId.value=scopeId.value;
  Object.assign(form,{text:'',kind:'fact',subject:'',topic:topicPath.value.join(' / '),attribute:'',value:'',validFrom:'',validTo:'',eventAt:'',confidence:'confirmed'});editorBaseline.value=JSON.stringify(form);
}
async function save(){
  const original=detail.value?.revisions[0];
  const params={scopeId:editingScopeId.value,text:form.text,kind:form.kind,subject:form.subject||undefined,topic:topicParts(form.topic),attribute:form.attribute||(editingId.value?null:undefined),value:form.value||(editingId.value?null:undefined),
    validFrom:savedDate(form.validFrom,original?.validFrom),validTo:savedDate(form.validTo,original?.validTo)??(editingId.value?null:undefined),eventAt:savedDate(form.eventAt,original?.eventAt)??(editingId.value?null:undefined),confidence:form.confidence};
  const saved=await rpc<{records:LongMemoryRecord[]}>(editingId.value?'memory.revise':'memory.remember',{...params,...editingId.value?{id:editingId.value,expectedVersion:editingVersion.value}:{}});
  notice.value='记忆已保存。';scopeId.value=editingScopeId.value;await reload();await choose(saved.records[0].id);
}
async function showImpact(){deleteImpact.value=await rpc('memory.impact',{scopeId:editingScopeId.value,id:editingId.value,action:'delete'});}
async function remove(){
  await rpc('memory.remove',{scopeId:editingScopeId.value,id:editingId.value,expectedVersion:editingVersion.value,action:'delete'});resetEditor();notice.value='记忆、来源摘录与关联派生内容已移除。';await reload();
}
async function savePolicy(){const saved=await rpc<Options['policy']>('memory.policy.save',{value:draftPolicy(),expectedRevision:options.value!.policy.revision,embeddingCredential:embeddingCredential.value||undefined});options.value!.policy=saved;setPolicy(saved.value);notice.value='整理方式已保存。';}
async function exportScope(){
  const archive=await rpc<LongMemoryArchive>('memory.export',{scopeId:scopeId.value});const url=URL.createObjectURL(new Blob([JSON.stringify(archive,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='GrayCode-记忆-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function readImport(event:Event){
  const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;
  await perform(async()=>{if(file.size>32*1024*1024)throw new Error('单个记忆归档不能超过 32 MiB。');const value=JSON.parse(await file.text()) as LongMemoryArchive;
    if(value.format!=='graycode-long-memory'||value.version!==1||!Array.isArray(value.records)||!Array.isArray(value.sources)||!Array.isArray(value.scopes)||!Array.isArray(value.tombstones))throw new Error('这不是有效的 GrayCode 记忆归档。');importPreview.value=value;});
}
async function restore(){const restored=await rpc<{records:number;sources:number;skipped:number}>('memory.restore',{archive:importPreview.value});importPreview.value=null;notice.value=`已合并 ${restored.records} 条记忆、${restored.sources} 条来源，跳过 ${restored.skipped} 个已有或已删除的对象。`;await loadOptions();}
async function queueSummary(){await rpc('memory.summary.queue',{scopeId:scopeId.value,recordIds:selectedIds.value,topic:topicParts(summaryTopic.value||topicPath.value.join('/'))});notice.value='分层摘要已加入后台任务。';selectedIds.value=[];await reload();}
async function regenerateSummary(){const refs=detail.value?.revisions[0].dependencies.filter(ref=>ref.kind==='record').map(ref=>ref.id)??[];
  await rpc('memory.summary.queue',{scopeId:editingScopeId.value,recordIds:refs,topic:topicParts(form.topic),id:editingId.value,expectedVersion:editingVersion.value});notice.value='已按当前有效来源重新整理摘要。';section.value='jobs';await reload();}
async function testEmbedding(){const value=await rpc<{dimensions:number}>('memory.embedding.test',{scopeId:scopeId.value});notice.value='连接成功，实际维度为 '+value.dimensions+'。';}
async function rebuildIndex(){const value=await rpc<{queued:number}>('memory.index.rebuild',{scopeId:scopeId.value});notice.value='已为 '+value.queued+' 个记忆版本安排索引重建。';section.value='jobs';await reload();}
async function extractCurrent(){await rpc('memory.extract',{scopeId:scopeId.value});notice.value='最近回合的用户陈述与工具结果已加入整理任务。';section.value='jobs';await reload();}
function requestClose():boolean{if(busy.value){notice.value='正在保存，请稍候。';return false;}if(dirty.value){pendingClose.value=true;return false;}return true;}
async function discard(){
  if(pendingClose.value){emit('close');return;}
  const action=pendingNavigation.value;pendingNavigation.value=null;resetEditor();await action?.();
}
defineExpose({requestClose});
let unsubscribe=()=>{};
onMounted(()=>{void perform(loadOptions);unsubscribe=subscribe(event=>{
  if(['memory.changed','memory.indexed','memory.job.changed'].includes(event.type)&&(!event.scopeId||event.scopeId===scopeId.value)){
    if(editingId.value&&event.type==='memory.changed')changedElsewhere.value=true;
    if(refreshTimer)clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{void reload().catch(cause=>error.value=(cause as Error).message);},180);
  }
});});
onUnmounted(()=>{epoch++;unsubscribe();if(refreshTimer)clearTimeout(refreshTimer);});
</script>
<template>
  <section class="memory-library" aria-label="长期记忆">
    <div class="memory-toolbar"><label>范围<select v-model="scopeId" :disabled="busy" aria-label="记忆范围" @change="topicPath=[];selectedIds=[];perform(reload)"><option v-for="scope in options?.scopes" :key="scope.id" :value="scope.id">{{scope.label}}</option></select></label>
      <nav aria-label="记忆管理"><button :aria-pressed="section==='records'" @click="section='records'">浏览与编辑</button><button :aria-pressed="section==='organize'" @click="section='organize'">整理方式</button><button :aria-pressed="section==='jobs'" @click="section='jobs';perform(reload)">后台任务</button></nav>
      <span v-if="loading" class="memory-muted" role="status">正在读取…</span>
    </div>
    <p v-if="error" class="memory-error" role="alert">{{error}}</p><p v-if="notice" class="memory-notice" role="status">{{notice}}</p>
    <div v-if="pendingClose||pendingNavigation" class="memory-confirm"><span>有未保存的更改。可以保留当前编辑，或放弃后继续。</span><button @click="pendingClose=false;pendingNavigation=null">保留当前编辑</button><button @click="perform(discard)">放弃并继续</button></div>
    <div v-if="importPreview" class="memory-confirm"><span>将合并 {{importPreview.scopes.length}} 个范围、{{importPreview.records.length}} 个记忆版本和 {{importPreview.sources.length}} 个来源版本。已有删除标记仍然优先，冲突不会被覆盖。</span><button :disabled="busy" @click="perform(restore)">确认合并归档</button><button @click="importPreview=null">取消</button></div>
    <div v-show="section==='records'" class="memory-columns">
      <aside><form class="memory-search" @submit.prevent="appliedQuery=searchText;perform(reload)"><input v-model="searchText" aria-label="搜索长期记忆" placeholder="搜索事实、偏好或经验"><button :disabled="busy" type="submit">搜索</button></form>
        <label class="memory-filter">类别<select v-model="kind" @change="perform(reload)"><option value="">全部类别</option><option v-for="(label,key) in kinds" :key="key" :value="key">{{label}}</option></select></label>
        <div class="memory-path"><button @click="topicPath=[];perform(reload)">全部主题</button><button v-for="(part,index) in topicPath" :key="index" @click="topicPath=topicPath.slice(0,index+1);perform(reload)">{{part}}</button></div>
        <button v-for="topic in topics" :key="topic.scopeId+topic.path.join('/')" class="memory-topic" @click="topicPath=topic.path;perform(reload)"><span>{{topic.path.at(-1)}}</span><small>{{topic.records}} 条<span v-if="topic.summaries.length"> · 有摘要</span></small></button>
        <div class="memory-side-actions"><button :disabled="busy||!scopeId" @click="navigate(create)">新增记忆</button><button :disabled="busy||!scopeId" @click="perform(exportScope)">导出当前范围</button><label class="memory-import">合并归档<input type="file" accept=".json" :disabled="busy" @change="readImport"></label></div>
        <p class="memory-muted">按主题逐层查看，只把相关内容交给当前对话。群聊和角色剧情有独立范围。</p>
      </aside>
      <main>
        <div v-if="result" class="memory-result-meta"><span>{{result.method==='hybrid'?'关键词与语义':'关键词'}} · {{result.hits.length}} 条</span><span>当前结果约 {{result.estimatedTokens}} token</span><span v-if="result.truncated">已按预算截取，可缩小主题或搜索范围</span></div>
        <div v-if="selectedIds.length" class="memory-summary-actions"><span>已选 {{selectedIds.length}} 条</span><input v-model="summaryTopic" aria-label="摘要主题" placeholder="摘要主题，例如 项目 / 部署"><button :disabled="busy" @click="perform(queueSummary)">按所选依据整理摘要</button></div>
        <div class="memory-records"><div v-for="hit in result?.hits" :key="hit.record.id" class="memory-record" :class="{selected:editingId===hit.record.id}"><input v-model="selectedIds" type="checkbox" :value="hit.record.id" :aria-label="'选择记忆 '+hit.record.id"><button :disabled="busy" @click="navigate(()=>choose(hit.record.id))"><span class="memory-record-meta">{{kinds[hit.record.kind]}} · {{origins[hit.record.origin]}}<span v-if="hit.record.confidence!=='confirmed'"> · {{hit.record.confidence==='inferred'?'待核对':'存在争议'}}</span><span v-if="hit.conflicts.length"> · 有不同说法</span></span><strong>{{hit.record.text}}</strong><small>{{hit.record.topic.join(' / ')||'未分类'}} · {{hit.reasons.join(' + ')}}</small></button></div></div>
        <p v-if="!result?.hits.length&&!loading" class="memory-empty">这里还没有匹配的记忆。可以新增一条，或在选择整理模型后，从当前对话提取。</p>
        <section v-if="editing" class="memory-editor" aria-label="记忆编辑器">
          <header><strong>{{editingId?'编辑记忆':'新增记忆'}}</strong><span>{{scopeLabel(editingScopeId)}}</span><code v-if="editingId">{{editingId.slice(0,12)}} · v{{editingVersion}}</code></header>
          <p v-if="changedElsewhere" class="memory-muted">此范围刚有更新，当前编辑内容已保留。保存时会检查版本。</p>
          <p v-if="detail&&detail.activeVersion===undefined" class="memory-warning">此版本当前不参与召回，可能已经过期或来源已修订。下方可以查看依据。</p>
          <label>正文<textarea v-model="form.text" rows="5" aria-label="记忆正文"></textarea></label>
          <div class="memory-form-grid"><label>类别<select v-model="form.kind" :disabled="form.kind==='summary'"><option v-for="(label,key) in kinds" :key="key" :value="key" :disabled="key==='summary'&&form.kind!=='summary'">{{label}}</option></select></label><label>确认状态<select v-model="form.confidence"><option value="confirmed">已确认</option><option value="inferred">尚待核对</option><option value="disputed">存在争议</option></select></label>
            <label>主体<input v-model="form.subject" placeholder="留空表示当前账号"></label><label>主题层次<input v-model="form.topic" placeholder="个人 / 饮食，使用 / 分层"></label><label>属性<input v-model="form.attribute" placeholder="例如 部署端口、喜欢的饮料"></label><label>属性值<input v-model="form.value" placeholder="可选，用于识别不同说法"></label>
            <label>生效时间（UTC）<input v-model="form.validFrom" type="datetime-local"></label><label>失效时间（UTC）<input v-model="form.validTo" type="datetime-local"></label><label>事件发生时间（UTC）<input v-model="form.eventAt" type="datetime-local"></label></div>
          <div class="memory-editor-actions"><button :disabled="busy||!form.text.trim()" @click="perform(save)">保存记忆</button><button v-if="editingId" :disabled="busy" @click="perform(showImpact)">查看删除影响</button><button v-if="form.kind==='summary'&&editingId" :disabled="busy" @click="perform(regenerateSummary)">按当前依据重新整理</button><button :disabled="busy" @click="navigate(resetEditor)">收起编辑器</button></div>
          <div v-if="deleteImpact" class="memory-confirm"><p>将移除 {{deleteImpact.recordCount}} 条记忆及派生内容，并清除有关来源摘录和旧修订。原始会话保留供你查看，相关来源和依赖内容会从后续模型上下文中排除。</p><ul><li v-for="item in deleteImpact.items" :key="item.id">{{kinds[item.kind]}}：{{item.text}}</li></ul><p v-if="deleteImpact.truncated">列表显示前 {{deleteImpact.items.length}} 条，其余引用这条来源的派生内容也会移除。</p><button :disabled="busy" class="memory-delete" @click="perform(remove)">确认删除这些内容</button><button @click="deleteImpact=null">取消</button></div>
          <details v-if="detail" open class="memory-evidence"><summary>来源与依赖</summary><article v-for="source in detail.sources" :key="source.id+'@'+source.version"><div>{{origins[source.origin]}} · {{source.reference?.label||source.reference?.messageId||'来源摘录'}} · {{stamp(source.recordedAt)}}</div><blockquote>{{source.text}}</blockquote></article><article v-for="parent in detail.parents" :key="parent.id+'@'+parent.version"><button @click="scopeId=editingScopeId;navigate(()=>choose(parent.id))">展开 {{kinds[parent.kind]}} · {{parent.id.slice(0,12)}}@{{parent.version}}</button><p>{{parent.text}}</p></article><p v-if="!detail.sources.length&&!detail.parents.length" class="memory-muted">来源内容已经移除，当前条目不可作为有效依据。</p></details>
          <details v-if="detail&&detail.revisions.length>1" class="memory-revisions"><summary>历史修订（{{detail.revisions.length}}）</summary><article v-for="revision in detail.revisions" :key="revision.version"><small>v{{revision.version}} · {{stamp(revision.recordedAt)}} · 自 {{stamp(revision.validFrom)}} 生效</small><p>{{revision.text}}</p></article></details>
        </section>
      </main>
    </div>
    <section v-show="section==='organize'" class="memory-organization" aria-label="记忆整理方式">
      <div class="memory-form-grid"><fieldset><legend>本轮召回</legend><label class="memory-check"><input v-model="policy.enabled" type="checkbox">聊天时自动引用少量相关记忆</label><label>最多引用条数<input v-model.number="policy.recallLimit" type="number" min="1" max="50"></label><label>记忆上下文预算（估算 token）<input v-model.number="policy.recallTokens" type="number" min="256" max="16000"></label><p class="memory-muted">工具循环复用本轮选择。纠正、删除和权限变化会优先使失效依据退出请求。</p></fieldset>
        <fieldset><legend>后台整理</legend><label class="memory-check"><input v-model="policy.automaticExtraction" type="checkbox">对话完成后自动提取</label><div class="memory-scope-checks"><label v-for="(label,key) in {personal:'个人',workspace:'当前项目',group:'绑定群组'}" :key="key" class="memory-check"><input v-model="policy.automaticScopes" type="checkbox" :value="key">{{label}}</label></div><label>整理渠道<select v-model="policy.providerId" @change="policy.model=provider?.model||''"><option value="">选择已配置的渠道</option><option v-for="item in options?.providers" :key="item.id" :value="item.id">{{item.name}}</option></select></label><label>整理模型<input v-model="policy.model" list="memory-model-options" placeholder="选择或填写模型名称"><datalist id="memory-model-options"><option v-for="model in provider?.models" :key="model" :value="model" /></datalist></label><label>单次输出上限（含思考）<input v-model.number="policy.extractionOutputTokens" type="number" min="1024" max="32768"></label><p class="memory-muted">选择的来源会发送给此模型。失败与中断不会自动反复重试，实际用量可在后台任务查看。</p></fieldset></div>
      <fieldset><legend>语义检索</legend><label class="memory-check"><input v-model="embeddingEnabled" type="checkbox">使用嵌入服务，与关键词结果合并</label><div v-if="embeddingEnabled" class="memory-form-grid"><label>嵌入接口完整地址<input v-model="embedding.url" placeholder="http://127.0.0.1:端口/v1/embeddings"></label><label>实际嵌入模型<input v-model="embedding.model" placeholder="服务所支持的模型名"></label><label>凭据<input v-model="embeddingCredential" type="password" autocomplete="new-password" :placeholder="embedding.credentialRef?'已保存；留空继续使用':'本地无认证服务可以留空'"></label><label>请求维度（可选）<input v-model="embedding.dimensions" type="number" min="1" max="16384" placeholder="按服务实际返回"></label><label>查询前缀（按模型要求填写）<input v-model="embedding.queryPrefix"></label><label>正文前缀（可选）<input v-model="embedding.documentPrefix"></label></div><p class="memory-muted">未启用或服务不可用时使用关键词。修改地址、模型或前缀后，旧向量不会与新配置混用；可重建当前范围全部版本的索引。</p></fieldset>
      <div class="memory-editor-actions"><button :disabled="busy||!policyDirty" @click="perform(savePolicy)">保存整理方式</button><button :disabled="busy||policyDirty||!embeddingEnabled" @click="perform(testEmbedding)">测试嵌入连接</button><button :disabled="busy||policyDirty||!embeddingEnabled" @click="perform(rebuildIndex)">重建当前范围索引</button><button :disabled="busy||policyDirty||!state.conversationId||!policy.providerId" @click="perform(extractCurrent)">整理最近回合</button></div>
    </section>
    <section v-show="section==='jobs'" class="memory-jobs" aria-label="记忆后台任务"><p class="memory-muted">按来源版本提交结果。思考 token 已包含在输出中；未返回的用量显示为未知。</p><p v-if="!jobs.length" class="memory-empty">暂无后台任务。可以在“整理方式”选择模型，然后整理最近回合。</p><article v-for="job in jobs" :key="job.id"><header><strong>{{job.kind==='embed'?'向量索引':job.kind==='summarize'?'分层摘要':'来源提取'}}</strong><span>{{statuses[job.status]}}</span><small>{{stamp(job.updatedAt)}}</small></header><p>{{job.usage?.servedModel||job.model||job.providerId}} · 尝试 {{job.attempts}} 次</p><div class="memory-job-usage"><span>输入 {{job.usage?.input??'未知'}}</span><span>输出 {{job.usage?.output??'未知'}}</span><span>其中思考 {{job.usage?.thoughts??'未知'}}</span><span>缓存读取 {{job.usage?.cacheRead??'未知'}}</span></div><p v-if="job.error" class="memory-error">{{job.error}}</p><button v-if="['failed','interrupted'].includes(job.status)" :disabled="busy" @click="perform(async()=>{await rpc('memory.job.retry',{scopeId:job.scopeId,id:job.id});await reload();})">重试此任务</button><button v-if="['pending','running'].includes(job.status)" :disabled="busy" @click="perform(async()=>{await rpc('memory.job.cancel',{scopeId:job.scopeId,id:job.id});await reload();})">停止此任务</button></article></section>
  </section>
</template>
<style scoped src="./memoryLibrary.css"></style>
