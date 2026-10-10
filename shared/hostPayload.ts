/**
 * Vue 响应式对象内部标记键（与 Vue 3 的 toRaw 实现一致）。
 * Vue 的 reactive/readonly 代理在读取该键时返回原始目标对象，普通对象返回 undefined。
 */
const VUE_RAW_KEY = '__v_raw'

/**
 * 判断对象是否为 Vue 响应式 Proxy（reactive / readonly / ref 解包后的响应式对象）。
 * 读取 __v_raw 触发 Vue 代理的 get trap 并返回原始目标；普通对象读取为 undefined。
 * 读取抛错时保守视为 Proxy（走 JSON 往返，保证不破坏原有解包行为）。
 */
function isVueReactiveProxy(value: any): boolean {
  try {
    const raw = value[VUE_RAW_KEY]
    return raw !== undefined && raw !== value
  } catch {
    return true
  }
}

/**
 * 判断 payload 是否必须 JSON 往返解包：
 * - 树中存在 Vue 响应式 Proxy → 是（structured clone 无法序列化 Proxy，会抛 DataCloneError）
 * - 存在循环引用 → 是（JSON.stringify 会抛错 → 保持原有 reject 行为）
 * - 存在非普通对象（Date/Map/Set/RegExp/函数等）→ 是（保持原有 JSON 化语义）
 * - 纯 JSON 结构（对象/数组/字符串/数字/布尔/null，含 base64 大字符串）→ 否，直接透传
 *
 * 遍历为引用级检查，不复制字符串；visited 只保留当前祖先，共享引用不等于循环引用。
 */
export function requiresJsonRoundTrip(value: any, visited?: Set<object>): boolean {
  const valueType = typeof value
  if (value === null || valueType !== 'object') {
    return valueType === 'function' || valueType === 'symbol'
  }
  if (isVueReactiveProxy(value)) return true
  const isArray = Array.isArray(value)
  const proto = Object.getPrototypeOf(value)
  if (!isArray && proto !== Object.prototype && proto !== null) return true
  const keys = isArray ? [] : Object.keys(value)
  // 小 payload 短路：≤2 个基本类型属性的扁平对象必然可结构化克隆，
  // 高频小消息（如 { focused: bool }）无需分配 visited Set 和深遍历。
  if (!isArray && keys.length <= 2) {
    let flat = true
    for (const key of keys) {
      const v = value[key], type = typeof v
      if (v !== null && (type === 'object' || type === 'function' || type === 'symbol')) {
        flat = false
        break
      }
    }
    if (flat) return false
  }
  const set = visited ?? new Set()
  if (set.has(value)) return true
  set.add(value)

  if (isArray) {
    for (const item of value) {
      if (requiresJsonRoundTrip(item, set)) return true
    }
  } else {
    for (const key of keys) {
      if (requiresJsonRoundTrip(value[key], set)) return true
    }
  }
  set.delete(value)
  return false
}

