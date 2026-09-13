import type { LongMemoryPolicy } from '@graycode/contracts';
import {randomUUID} from 'node:crypto';
import type { PlatformApplication } from '../../application';

export const LONG_MEMORY_POLICY_DEFAULTS:LongMemoryPolicy={enabled:true,automaticExtraction:false,recallTokens:1200,recallLimit:5,extractionOutputTokens:12288};

export class MemoryPolicyStore {
  constructor(private readonly app:PlatformApplication){}
  async get(actorId:string){
    const record=await this.app.storage.getVersionedRecord('long-memory-policy',actorId);
    return {value:{...LONG_MEMORY_POLICY_DEFAULTS,...record.value as Partial<LongMemoryPolicy>??{}},revision:record.revision};
  }
  async save(actorId:string,input:LongMemoryPolicy,expectedRevision:number|null,embeddingCredential?:string){
    this.app.requireOwner(actorId);
    const value=structuredClone(input);
    for(const field of ['enabled','automaticExtraction'] as const)if(typeof value[field]!=='boolean')throw new Error('记忆开关无效。');
    for(const [field,min,max]of [['recallTokens',256,16000],['recallLimit',1,50],['extractionOutputTokens',1024,32768]]as const)
      if(!Number.isSafeInteger(value[field])||value[field]<min||value[field]>max)throw new Error(`${field} 必须在 ${min} 至 ${max} 之间。`);
    const provider=value.providerId?this.app.settings.snapshot().settings.providers.find(item=>item.id===value.providerId):undefined;
    if(value.providerId&&!provider)throw new Error('请选择已有模型渠道。');
    if(value.automaticExtraction&&(!value.providerId||!(value.model||provider?.model)))throw new Error('启用后台整理前，请选择渠道和模型。');
    if(value.automaticScopes?.some(kind=>!['personal','workspace','group'].includes(kind)))throw new Error('自动整理范围无效。');
    if(value.automaticExtraction&&!value.automaticScopes?.length)throw new Error('请选择允许自动整理的记忆范围。');
    if(value.embedding){
      const url=new URL(value.embedding.url);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new Error('嵌入服务地址必须是没有内嵌凭据的 HTTP(S) 地址。');
      value.embedding.url=url.toString();
      if(!value.embedding.model?.trim())throw new Error('请填写实际嵌入模型名称。');
      for(const prefix of [value.embedding.queryPrefix,value.embedding.documentPrefix])if(prefix!==undefined&&(typeof prefix!=='string'||prefix.length>1000))throw new Error('嵌入输入前缀不能超过 1000 字符。');
      if(value.embedding.dimensions!==undefined&&(!Number.isSafeInteger(value.embedding.dimensions)||value.embedding.dimensions<1||value.embedding.dimensions>16384))throw new Error('嵌入维度无效。');
      if(embeddingCredential?.trim()){
        const snapshot=this.app.settings.snapshot(),reference='long_memory_embedding_'+randomUUID();
        await this.app.settings.save({settings:snapshot.settings,expectedRevision:snapshot.revision,credentials:{[reference]:embeddingCredential}});
        value.embedding.credentialRef=reference;
      }
      if(value.embedding.credentialRef&&!await this.app.settings.credential(value.embedding.credentialRef))throw new Error('嵌入服务凭据不可用。');
    }
    const written=await this.app.storage.commitRecords([{namespace:'long-memory-policy',id:actorId,value,expectedRevision}]);
    return {value,revision:written[0].revision};
  }
}
