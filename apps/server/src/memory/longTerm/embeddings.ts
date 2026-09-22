import { createHash } from 'node:crypto';
import type { LongMemoryPolicy, LongMemoryVector } from '@graycode/contracts';
import type { PlatformApplication } from '../../application';
import { ChannelHttpExecutor } from '../../../../../backend/modules/channel/channelManager/channelHttpExecutor';

/** 接收标准浮点嵌入，按返回 index 对齐；服务地址或模型变更会产生独立索引标识。 */
export class MemoryEmbeddings {
  private readonly cache=new Map<string,LongMemoryVector>();
  private readonly controller=new AbortController();
  constructor(private readonly app:PlatformApplication){}
  signature(config:NonNullable<LongMemoryPolicy['embedding']>):string {
    return `${config.model}@${createHash('sha256').update(JSON.stringify([config.url,config.model,config.dimensions??null,config.queryPrefix??'',config.documentPrefix??''])).digest('hex').slice(0,16)}`;
  }
  clear():void{this.cache.clear();}
  cached(actorId:string,config:NonNullable<LongMemoryPolicy['embedding']>,text:string,purpose:'query'|'document'='document'):LongMemoryVector|undefined{
    const prefix=(purpose==='query'?config.queryPrefix:config.documentPrefix)??'';
    const key=createHash('sha256').update(JSON.stringify([actorId,this.signature(config),prefix+text])).digest('hex');
    const value=this.cache.get(key);return value?structuredClone(value):undefined;
  }
  close():void{this.controller.abort();this.clear();}
  async embed(actorId:string,config:NonNullable<LongMemoryPolicy['embedding']>,texts:string[],signal:AbortSignal,purpose:'query'|'document'='document'):Promise<{vectors:LongMemoryVector[];usage?:{input?:number;total?:number}}> {
    if(!texts.length||texts.length>32||texts.some(text=>!text.trim()))throw new Error('嵌入批次必须包含 1 至 32 段非空文字。');
    signal.throwIfAborted();
    const prefix=(purpose==='query'?config.queryPrefix:config.documentPrefix)??'';texts=texts.map(text=>prefix+text);
    const signature=this.signature(config),keys=texts.map(text=>createHash('sha256').update(JSON.stringify([actorId,signature,text])).digest('hex'));
    // 请求中的已命中向量先保存在局部结果中，避免写入新缓存时被容量淘汰影响本批返回。
    const resolved=new Map<string,LongMemoryVector>(),missing=new Map<string,string>();
    keys.forEach((key,index)=>{const cached=this.cache.get(key);if(cached)resolved.set(key,cached);else missing.set(key,texts[index]);});
    const results=()=>keys.map(key=>structuredClone(resolved.get(key)!));
    if(!missing.size)return {vectors:results(),usage:{input:0,total:0}};
    const missingKeys=[...missing.keys()],missingTexts=[...missing.values()];
    const secret=config.credentialRef?await this.app.settings.credential(config.credentialRef):undefined;
    if(config.credentialRef&&!secret)throw new Error('嵌入服务凭据不可用。');
    const proxy=this.app.product.runtimeSettings().getProxySettings();
    const hostname=new URL(config.url).hostname.toLowerCase();
    const loopback=hostname==='localhost'||hostname==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(hostname);
    const http=new ChannelHttpExecutor(()=>proxy.enabled&&!loopback?proxy.url:undefined);
    const response=await http.executeRequest({url:config.url,method:'POST',headers:{'Content-Type':'application/json',...secret?{Authorization:`Bearer ${secret}`}:{}} ,
      body:{model:config.model,input:missingTexts,encoding_format:'float',...(config.dimensions!==undefined?{dimensions:config.dimensions}:{})},timeout:45000},AbortSignal.any([signal,this.controller.signal]));
    if(response.status<200||response.status>=300)throw new Error(`嵌入服务返回 HTTP ${response.status}，请检查地址、模型和凭据。`);
    const body=response.body as {data?:Array<{index:number;embedding:number[]}>;usage?:{prompt_tokens?:number;total_tokens?:number}};
    if(!Array.isArray(body.data)||body.data.length!==missingKeys.length)throw new Error('嵌入服务没有返回完整的输入对应结果。');
    const indexed=new Map(body.data.map(row=>[row.index,row.embedding]));
    const dimensions=config.dimensions??indexed.get(0)?.length;
    if(!dimensions||dimensions>16384||!Number.isInteger(dimensions))throw new Error('嵌入结果的维度无效。');
    if([...resolved.values()].some(vector=>vector.dimensions!==dimensions))throw new Error('嵌入结果的维度与缓存不一致，请核对服务模型和维度配置。');
    const fresh=missingKeys.map((_key,index)=>{
      const values=indexed.get(index);
      if(!Array.isArray(values)||values.length!==dimensions||values.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw new Error('嵌入结果缺少有效浮点向量。');
      return {model:signature,dimensions,values};
    });
    // 整份响应验证通过后才更新缓存；上游 index 按去重后的请求解释，返回仍对应原始输入。
    missingKeys.forEach((key,index)=>{
      const vector=fresh[index];resolved.set(key,vector);
      if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key,vector);
    });
    return {vectors:results(),usage:body.usage?{input:body.usage.prompt_tokens,total:body.usage.total_tokens}:undefined};
  }
}
