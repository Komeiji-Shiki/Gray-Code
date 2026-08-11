/**
 * 渠道配置列表预加载缓存
 *
 * 启动时提前拉取渠道配置列表（config.listConfigs + 各配置 config.getConfig），
 * 避免用户首次打开「设置 → 渠道」页时才发起串行请求造成的可见延迟。
 *
 * 设计要点：
 * - 幂等：已有缓存直接返回；加载中复用同一在途请求，避免重复请求；
 * - 静默失败：预加载失败只 console.error，不弹用户可见错误，缓存保持未加载可重试；
 * - 超时保护：预加载请求 30s 超时（PRELOAD_TIMEOUT_MS），避免 sendToExtension 兜底超时（180s）
 *   期间渠道页 await 同一注定失败的在途请求、长时间显示误导性空态；
 * - 部分失败容忍：单条 config.getConfig 失败只跳过该项，不拖垮整批预加载（区别于 loadConfigs 的整批失败语义）；
 * - 显式失效：setChannelConfigsCache(null) / resetChannelConfigsCache() 同时作废在途加载任务，
 *   在途加载完成后丢弃结果，避免陈旧数据回填缓存；
 * - 缓存由 ChannelSettings 在每次成功加载/变更后通过 setChannelConfigsCache 同步，
 *   保证与后端数据一致（新建/删除/改名/字段更新都会触发重新加载并刷新缓存）。
 */
import { listConfigIds, getConfig } from './config'

/** 预加载请求超时时间（ms）：超过视为失败，缓存保持 null 供后续重试 */
const PRELOAD_TIMEOUT_MS = 30_000

/** 已加载的渠道配置列表；null = 尚未成功加载（可重试） */
let cachedConfigs: any[] | null = null
/** 进行中的加载 Promise（合并并发调用，避免重复请求） */
let inFlightLoad: Promise<void> | null = null
/** 代际计数：显式失效（setChannelConfigsCache(null)/resetChannelConfigsCache）时递增，用于作废在途加载的结果写入 */
let cacheGeneration = 0

/** 为 Promise 附加超时：超时 reject；正常完成/失败时清除定时器，避免悬挂定时器 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Preload timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

/** 拉取完整配置列表：listConfigIds + 逐条 getConfig，单条失败跳过（部分失败语义） */
async function loadAllConfigs(): Promise<any[]> {
  const ids = await listConfigIds()
  // 非法响应（非数组）按失败处理：抛错使整批预加载失败、缓存保持 null 可重试；
  // 不能把非数组当空列表缓存（[] !== null，一旦写入缓存将永久命中、永不重试）
  if (!Array.isArray(ids)) {
    throw new TypeError('listConfigIds returned non-array response')
  }
  const list: any[] = []
  for (const id of ids) {
    try {
      const config = await getConfig(id)
      if (config) {
        list.push(config)
      }
    } catch (error) {
      // 单条配置获取失败不拖垮整批预加载：跳过该项，后续打开设置页仍可看到其余配置
      console.error(`Failed to preload config ${id}:`, error)
    }
  }
  return list
}

async function fetchAndCache(): Promise<void> {
  const generation = cacheGeneration
  try {
    const list = await withTimeout(loadAllConfigs(), PRELOAD_TIMEOUT_MS)
    // 加载期间缓存被显式失效（代际变化）→ 丢弃本次结果，避免陈旧数据回填缓存
    if (generation !== cacheGeneration) return
    cachedConfigs = list
  } catch (error) {
    // 预加载失败（含超时）静默处理：不弹错误提示，缓存保持 null，后续打开设置页会重新加载
    console.error('Failed to preload channel configs:', error)
  } finally {
    // 仅当自己仍是最新在途任务时才清空标记，避免误清新发起的在途任务
    if (generation === cacheGeneration) {
      inFlightLoad = null
    }
  }
}

/**
 * 确保渠道配置已加载：
 * - 已有缓存：立即返回，不发请求；
 * - 加载中（未超时/未失效）：复用同一在途请求，不重复请求；
 * - 未加载：发起请求（预加载失败/超时后的兜底重试）。
 * 返回的 Promise 永不 reject（失败/超时已在内部吞掉）。
 */
export function preloadChannelConfigs(): Promise<void> {
  if (cachedConfigs !== null) return Promise.resolve()
  if (!inFlightLoad) {
    inFlightLoad = fetchAndCache()
  }
  return inFlightLoad
}

/** 读取已加载的渠道配置缓存（null = 未加载） */
export function getChannelConfigsCache(): any[] | null {
  return cachedConfigs
}

/** 更新缓存（ChannelSettings 成功加载/变更后同步；传 null 使缓存失效并作废在途加载任务） */
export function setChannelConfigsCache(configs: any[] | null): void {
  if (configs === null) {
    // 显式失效：作废在途任务（其完成结果将被丢弃），避免复用注定失败/过期的在途 Promise
    cacheGeneration++
    inFlightLoad = null
  }
  cachedConfigs = configs
}

/** 重置缓存与在途任务（测试隔离用：同时清 cachedConfigs 与 inFlightLoad；生产代码无需调用） */
export function resetChannelConfigsCache(): void {
  cacheGeneration++
  cachedConfigs = null
  inFlightLoad = null
}
