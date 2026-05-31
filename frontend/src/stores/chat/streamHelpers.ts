/**
 * 娴佸紡澶勭悊杈呭姪鍑芥暟
 *
 * @module streamHelpers
 * 鍖呭惈娑堟伅鎿嶄綔銆佸伐鍏疯皟鐢ㄨВ鏋愮瓑杈呭姪鍑芥暟
 *
 * WP15: functionCall merge 绾嚱鏁板凡鏀舵暃鍒?utils/functionCallMerge.ts锛?
 * 鏈枃浠朵粎淇濈暀 Main Chat 鐗规湁鐨勮妭娴佹帶鍒躲€乀oolEntry 鍚屾鍜?handleFunctionCallPart 鍏ュ彛銆?
 */

import type { Message } from '../../types'
import type { ChatStoreState } from './types'
import { generateId } from '../../utils/format'
import { isPerfEnabled } from '../../utils/perf'
// WP15: 缁熶竴 functionCall merge 绾嚱鏁板叆鍙ｃ€?
// 涓轰粈涔堜粠鐙珛妯″潡瀵煎叆锛歁ain Chat 鍜?SubAgent Monitor 涔嬪墠鍚勮嚜缁存姢浜嗙浉鍚岀殑 normalizeNonEmptyString銆?
// hasNonEmptyArgs銆乼ryParseArgs銆乬etFunctionCallMergeReason銆乵ergeFunctionCall銆?
// 鎬庝箞鏀癸細鍏ㄩ儴鏀舵暃鍒?frontend/src/utils/functionCallMerge.ts锛屼袱杈逛繚鎸佸悎骞惰涔変竴鑷淬€?
// 鐩殑锛氬悗缁?WP20 AgentRunEvent 缁熶竴 reducer 鍙互鐩存帴渚濊禆杩欎釜妯″潡銆?
import {
  type StreamFunctionCall,
  normalizeNonEmptyString,
  hasNonEmptyArgs,
  tryParseArgs,
  getFunctionCallMergeReason,
  mergeFunctionCall as unifiedMergeFunctionCall
} from '../../utils/functionCallMerge'


const todoDebugPrinted = new Set<string>()
function debugTodoOnce(key: string, data: Record<string, unknown>) {
  if (!isPerfEnabled()) return
  if (todoDebugPrinted.has(key)) return
  todoDebugPrinted.add(key)
  console.debug('[todo-debug][streamHelpers]', data)
}

function isTodoToolName(name: unknown): boolean {
  return name === 'todo_write' || name === 'todo_update' || name === 'create_plan'
}

/**
 * 娣诲姞 functionCall 鍒版秷鎭?
 */
export function addFunctionCallToMessage(
  message: Message,
  call: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    partialArgs?: string;
    index?: number;
    itemId?: string
  }
): void {
  // 鏇存柊 tools 鏁扮粍
  if (!message.tools) {
    message.tools = []
  }
  message.tools.push({
    id: call.id,
    name: call.name,
    args: call.args,
    // 涓轰粈涔堝悓姝?itemId/index锛歮essage.tools 鏄?ToolMessage 鐨勪富瑕佹暟鎹簮锛屽繀椤诲拰 parts 浣跨敤鍚屼竴濂楁祦寮忓悎骞堕敭銆?
    // 鎬庝箞鏀癸細鎶?provider 鐨勫唴閮ㄥ畾浣嶅瓧娈靛彧淇濈暀鍦ㄥ墠绔姇褰遍噷锛屼笉鍙備笌宸ュ叿缁撴灉鍥炰紶銆?
    // 鐩殑锛歝ontentSnapshot 瑕嗙洊鏃跺彲浠ヨ瘑鍒苟鏇挎崲 0 鍙傛暟鍗犱綅宸ュ叿锛岃€屼笉鏄妸瀹冭拷鍔犳垚绗簩寮犲崱銆?
    itemId: call.itemId,
    index: call.index,
    // 浼犻€?partialArgs 浠ヤ究 ToolMessage 缁勪欢鏄剧ず娴佸紡棰勮
    partialArgs: call.partialArgs,
    // 鍒氫粠娴佸紡鍐呭閲岃В鏋?鎷兼帴鍑烘潵鐨勫伐鍏疯皟鐢紝瑙嗕负"AI 杩樺湪杈撳嚭/瀹屽杽宸ュ叿鍐呭"
    // 鏈?partialArgs 璇存槑鍙傛暟浠嶅湪娴佸紡绱Н涓紱鏃?partialArgs 璇存槑宸叉嬁鍒板畬鏁村弬鏁?
    status: typeof call.partialArgs === 'string' ? 'streaming' : 'queued'
  })

  // 鏇存柊 parts锛堢敤浜庢覆鏌擄級
  if (!message.parts) {
    message.parts = []
  }
  message.parts.push({
    functionCall: {
      id: call.id,
      name: call.name,
      args: call.args,
      partialArgs: call.partialArgs,
      index: call.index,
      // 涓轰粈涔堝悓姝?itemId锛歱arts 涓?tools 閮藉彲鑳藉弬涓庢覆鏌撳拰蹇収閲嶅缓锛屼袱涓姇褰卞繀椤诲叡浜悓涓€鍐呴儴鍚堝苟閿€?
      // 鎬庝箞鏀癸細鍙湪鍓嶇娴佸紡 part 涓婁繚瀛?itemId锛屽悗绔渶缁堝巻鍙蹭細娓呯悊璇ュ瓧娈点€?
      // 鐩殑锛氳鏈€鍚庡埌杈剧殑瀹屾暣鍙傛暟浜嬩欢鑳借鐩栧垵濮嬪崰浣?part锛岃€屼笉鏄敓鎴?鍙傛暟 0"鐨勫亣宸ュ叿銆?
      itemId: call.itemId
    }
  })
}

/**
 * 娣诲姞鏂囨湰鍒版秷鎭紙鍚堝苟杩炵画鐨勬枃鏈?part锛?
 */
export function addTextToMessage(message: Message, text: string, isThought: boolean = false): void {
  // 鏅€氭枃鏈墠绱姞鍒?content
  if (!isThought) {
    message.content += text
  }

  if (!message.parts) {
    message.parts = []
  }

  const lastPart = message.parts[message.parts.length - 1]
  // 鍙湁鐩稿悓绫诲瀷锛堥兘鏄€濊€冩垨閮戒笉鏄€濊€冿級鎵嶅悎骞?
  const lastIsThought = lastPart?.thought === true
  if (lastPart && lastPart.text !== undefined && !lastPart.functionCall && lastIsThought === isThought) {
    lastPart.text += text
  } else {
    message.parts.push(isThought ? { text, thought: true } : { text })
  }
}

/**
 * 澶勭悊娴佸紡鏂囨湰
 *
 * Prompt 妯″紡宸ュ叿璋冪敤鐜板湪浠ュ悗绔В鏋愮粨鏋滀负鍑嗐€?
 * 鍓嶇杩欓噷鍙礋璐ｆ妸鍙鏂囨湰杩藉姞鍒版秷鎭腑銆?
 */
export function processStreamingText(
  message: Message,
  text: string,
  _state: ChatStoreState
): void {
  addTextToMessage(message, text)
}

/**
 * 鍏煎鏃ц皟鐢ㄩ摼銆?
 * Prompt 妯″紡宸ュ叿缂撳啿鐜板湪浣嶄簬鍚庣锛屾澶勪笉鍐嶉渶瑕侀澶栧鐞嗐€?
 */
export function flushToolCallBuffer(_message: Message, _state: ChatStoreState): void {
}

/**
 * 澶勭悊宸ュ叿璋冪敤 part锛堝師鐢?function call format锛?
 */

/**
 * partialArgs JSON.parse 鑺傛祦鎺у埗
 *
 * 闂锛氭瘡涓閲忕墖娈甸兘瀵规暣涓疮绉瓧绗︿覆鍋?JSON.parse锛屽綋鍙傛暟寰堝ぇ鏃讹紙濡?write_file 鍐欓暱浠ｇ爜锛夛紝
 * 澶嶆潅搴﹂€€鍖栦负 O(N虏)锛屽鑷翠富绾跨▼鍗℃銆?
 *
 * 绛栫暐锛?
 * - 璺熻釜涓婃鎴愬姛/灏濊瘯 parse 鏃剁殑瀛楃涓查暱搴?
 * - 姣忔澧為噺鍚庯紝鍙湁褰撴柊澧炴暟鎹噺瓒呰繃闃堝€兼椂鎵嶅啀娆″皾璇?parse
 * - 闃堝€奸殢瀛楃涓查暱搴﹀姩鎬佸闀匡細鐭瓧绗︿覆棰戠箒 parse锛堜繚璇佸皬鍙傛暟鐨勯瑙堜綋楠岋級锛?
 *   闀垮瓧绗︿覆澶у箙鍑忓皯 parse 娆℃暟锛堥伩鍏?O(N虏) 鍗￠】锛?
 *
 * WP15: 杩欐槸 Main Chat 鐗规湁鐨勮妭娴佺瓥鐣ワ紝Monitor 鍐呭澧為噺 reducer 涓嶉渶瑕佹閫昏緫銆?
 */
const partialArgsParseState = new WeakMap<object, { lastParseLen: number }>()

function shouldAttemptParse(fcRef: object, currentLen: number): boolean {
  let state = partialArgsParseState.get(fcRef)
  if (!state) {
    state = { lastParseLen: 0 }
    partialArgsParseState.set(fcRef, state)
  }
  // 鍔ㄦ€侀槇鍊硷細鐭瓧绗︿覆(<1KB) 姣?200 瀛楃 parse 涓€娆★紱
  // 涓瓑瀛楃涓?1-10KB) 姣?1KB parse 涓€娆★紱闀垮瓧绗︿覆 姣?4KB parse 涓€娆?
  const threshold = currentLen < 1024 ? 200 : currentLen < 10240 ? 1024 : 4096
  const delta = currentLen - state.lastParseLen
  if (delta < threshold) return false
  state.lastParseLen = currentLen
  return true
}

// WP15: StreamFunctionCall, normalizeNonEmptyString, hasNonEmptyArgs, tryParseArgs,
// getFunctionCallMergeReason 宸插叏閮ㄦ敹鏁涘埌 utils/functionCallMerge.ts銆?
// 浠呬繚鐣?Main Chat 鐗规湁鐨?findToolEntry銆乻yncToolEntryFromFunctionCall銆?
// normalizeNewFunctionCall 鍜?handleFunctionCallPart銆?

function findToolEntry(message: Message, fc: StreamFunctionCall, previousId?: string) {
  const tools = message.tools || []
  const ids = [previousId, fc.id].map(normalizeNonEmptyString).filter(Boolean)

  for (const id of ids) {
    const byId = tools.find(t => t.id === id)
    if (byId) return byId
  }

  const itemId = normalizeNonEmptyString(fc.itemId)
  if (itemId) {
    const byItemId = tools.find(t => normalizeNonEmptyString((t as any).itemId) === itemId)
    if (byItemId) return byItemId
  }

  if (typeof fc.index === 'number') {
    const byIndex = tools.find(t => typeof (t as any).index === 'number' && (t as any).index === fc.index)
    if (byIndex) return byIndex
  }

  return undefined
}

function syncToolEntryFromFunctionCall(message: Message, fc: StreamFunctionCall, previousId?: string): void {
  const toolEntry = findToolEntry(message, fc, previousId)
  if (!toolEntry) return

  const nextId = normalizeNonEmptyString(fc.id)
  if (nextId && toolEntry.id !== nextId) {
    toolEntry.id = nextId
  }
  if (fc.name) toolEntry.name = fc.name
  if (fc.itemId) toolEntry.itemId = fc.itemId
  if (typeof fc.index === 'number') toolEntry.index = fc.index

  if (hasNonEmptyArgs(fc.args)) {
    toolEntry.args = fc.args
  }

  if (typeof fc.partialArgs === 'string') {
    toolEntry.status = 'streaming'
    toolEntry.partialArgs = fc.partialArgs
  } else if (toolEntry.status === 'streaming' && hasNonEmptyArgs(fc.args)) {
    toolEntry.status = 'queued'
    delete toolEntry.partialArgs
  }
}

/**
 * WP15: Main Chat 涓撶敤鐨?mergeFunctionCall 钖勫寘瑁呫€?
 *
 * 涓轰粈涔堥渶瑕佽繖涓寘瑁咃細Main Chat 娴佸紡璺緞鏈夌壒鏈夌殑 partialArgs JSON.parse 鑺傛祦绛栫暐锛坰houldAttemptParse锛夛紝
 * 鑰?SubAgent Monitor 鐨?contentDelta 鍙湪 finalArgs=true 鏃惰В鏋愩€?
 * 鎬庝箞鏀癸細鎶婅妭娴佸洖璋冧紶鍏?unifiedMergeFunctionCall锛屼繚鎸?Main Chat 娴佸紡鎬ц兘浼樺寲涓嶄涪澶便€?
 * 鐩殑锛氱粺涓€鍚堝苟璇箟鐨勫悓鏃讹紝淇濈暀 Main Chat 鐗规湁鐨?O(N虏) 闃叉姢銆?
 */
function mergeFunctionCall(target: StreamFunctionCall, incoming: StreamFunctionCall): string | undefined {
  return unifiedMergeFunctionCall(target, incoming, {
    shouldParseArgs: (_incoming, combinedPartialArgs) => {
      // 涓轰粈涔?finalArgs=true 鏃剁粫杩囪妭娴侊細arguments.done 浼犵殑鏄畬鏁?JSON锛?
      // 蹇呴』绔嬪嵆瑙ｆ瀽鎵嶈兘璁╁伐鍏疯繘鍏?queued 鐘舵€佸苟瑙﹀彂鍚庣画鎵ц銆?
      // 鎬庝箞鏀癸細finalArgs 鎴栬妭娴侀槇鍊奸€氳繃鍗宠В鏋愩€?
      if (_incoming.finalArgs === true) return true
      return shouldAttemptParse(target, combinedPartialArgs.length)
    }
  })
}

function normalizeNewFunctionCall(incoming: StreamFunctionCall): { args: Record<string, unknown>; partialArgs?: string } {
  if (hasNonEmptyArgs(incoming.args)) {
    return { args: incoming.args }
  }

  const parsed = incoming.finalArgs === true ? tryParseArgs(incoming.partialArgs) : null
  if (parsed) {
    return { args: parsed }
  }

  return { args: {}, partialArgs: incoming.partialArgs }
}

export function handleFunctionCallPart(part: any, message: Message): void {
  const fc = part.functionCall as StreamFunctionCall
  const incomingHasPartial = typeof fc.partialArgs === 'string'
  const incomingHasArgs = hasNonEmptyArgs(fc.args)

  let matched: { fc: StreamFunctionCall; reason: string } | null = null
  let isLastFunctionCall = true

  // 涓轰粈涔堜粠鍚庡線鍓嶆壘锛岃€屼笉鏄彧鐪嬫渶鍚庝竴涓?part锛氭祦寮忓搷搴旈噷鍙兘绌挎彃鎬濊€冪鍚嶃€佹枃鏈垨鐘舵€佸揩鐓с€?
  // 鎬庝箞鏀癸細鎸?itemId銆乮ndex銆乮d銆乫resh placeholder 鐨勭粺涓€浼樺厛绾у鎵惧悓涓€閫昏緫宸ュ叿璋冪敤銆?
  // 鐩殑锛氳鍓嶇鍜屽悗绔?StreamAccumulator 浣跨敤鍚屼竴濂楀悎骞舵ā鍨嬶紝閬垮厤 MCP 宸ュ叿涓存椂閲嶅鏄剧ず銆?
  for (let i = (message.parts?.length || 0) - 1; i >= 0; i--) {
    const existing = message.parts?.[i]?.functionCall as StreamFunctionCall | undefined
    if (!existing) continue

    const reason = getFunctionCallMergeReason(fc, existing, isLastFunctionCall)
    if (reason) {
      matched = { fc: existing, reason }
      break
    }

    isLastFunctionCall = false
  }

  if (matched) {
    if (isTodoToolName(fc.name) || isTodoToolName(matched.fc.name)) {
      debugTodoOnce(`merge-${message.id}-${matched.fc.id || 'no-last-id'}-${fc.id || 'no-id'}-${String(fc.name || matched.fc.name)}`, {
        messageId: message.id,
        action: 'merge_function_call_part',
        incomingName: fc.name || null,
        incomingId: normalizeNonEmptyString(fc.id) || null,
        incomingItemId: normalizeNonEmptyString(fc.itemId) || null,
        incomingIndex: fc.index ?? null,
        incomingHasPartial,
        incomingHasArgs,
        lastName: matched.fc.name || null,
        lastId: normalizeNonEmptyString(matched.fc.id) || null,
        lastItemId: normalizeNonEmptyString(matched.fc.itemId) || null,
        lastIndex: matched.fc.index ?? null,
        canMerge: true,
        canMergeReason: matched.reason
      })
    }

    const previousId = mergeFunctionCall(matched.fc, fc)
    syncToolEntryFromFunctionCall(message, matched.fc, previousId)
    return
  }

  if (isTodoToolName(fc.name)) {
    debugTodoOnce(`append-${message.id}-${fc.id || 'no-id'}-${String(fc.name)}`, {
      messageId: message.id,
      action: 'append_new_function_call_part',
      incomingName: fc.name,
      incomingId: typeof fc.id === 'string' ? fc.id : null,
      incomingItemId: typeof fc.itemId === 'string' ? fc.itemId : null,
      incomingIndex: fc.index ?? null,
      hasPartial: incomingHasPartial,
      hasArgs: incomingHasArgs
    })
  }

  const normalized = normalizeNewFunctionCall(fc)
  addFunctionCallToMessage(message, {
    id: fc.id || generateId(),
    name: fc.name || '',
    args: normalized.args,
    partialArgs: normalized.partialArgs,
    index: fc.index,
    itemId: fc.itemId
  })
}
