/**
 * WP15: SubAgent Monitor Content[] delta reducer銆?
 *
 * 涓轰粈涔堥渶瑕佽繖涓枃浠讹細SubAgent Monitor 涓嶈兘鐩存帴浣跨敤涓昏亰澶╃殑 handleFunctionCallPart锛堝畠鑰﹀悎浜?Message 绫诲瀷鍜?
 * Pinia store 鐘舵€侊級锛屼絾闇€瑕佺浉鍚岀殑 functionCall 鍚堝苟璇箟锛坕temId > index > id > freshPlaceholder > legacyPartial锛夈€?
 *
 * 鎬庝箞鏀癸細鍚堝苟閫昏緫锛坣ormalizeNonEmptyString銆乭asNonEmptyArgs銆乼ryParseArgs銆乬etFunctionCallMergeReason銆?
 * mergeFunctionCall锛夊凡鏀舵暃鍒?utils/functionCallMerge.ts銆傛湰鏂囦欢鍙繚鐣?Monitor 鐗规湁鐨?Content[] 鎶曞奖閫昏緫锛?
 * cloneContent銆乤ppendContentPart銆乪nsureLastModelContent銆乤pplyStreamChunkToContents銆?
 *
 * 鐩殑锛歁ain Chat 鍜?SubAgent Monitor 鍏变韩鍚屼竴濂?functionCall 鍚堝苟瑙勫垯锛屽悗缁?WP20 缁熶竴 reducer 鍙洿鎺ヤ緷璧栥€?
 */

import type { Content, ContentPart } from '../../types'
// WP15: 缁熶竴 functionCall merge 绾嚱鏁板叆鍙ｃ€?
// 涓轰粈涔堜粠鐙珛妯″潡瀵煎叆锛氭秷闄や笌 streamHelpers.ts / parsers.ts 鐨勪笁浠介噸澶嶃€?
// 鎬庝箞鏀癸細getFunctionCallMergeReason 鍜?mergeFunctionCall 鐩存帴寮曠敤缁熶竴妯″潡銆?
// 鐩殑锛歁onitor 瀹炴椂宸ュ叿鍗″悎骞惰涓轰笌涓昏亰澶╁畬鍏ㄤ竴鑷淬€?
import {
  type StreamFunctionCall,
  hasNonEmptyArgs,
  getFunctionCallMergeReason,
  mergeFunctionCall as unifiedMergeFunctionCall
} from '../../utils/functionCallMerge'

function cloneContent(content: Content): Content {
  // 淇敼鍘熷洜锛氬彧鏈夊嵆灏嗚鏇挎崲鎴栬 delta 鏇存柊鐨?Content 闇€瑕佹繁鎷疯礉 parts锛屾湭鍙樺寲鐨勫巻鍙叉ゼ灞傚簲淇濇寔寮曠敤鍏变韩銆?
  // 淇敼鏂瑰紡锛氫繚鐣欏崟 Content 娣辨嫹璐濆伐鍏凤紝浣嗕笉鍐嶅湪 applyStreamChunkToContents 涓鏁翠釜 contents 鍏ㄩ噺 map 璋冪敤銆?
  // 鐩殑锛氬ぇ杈撳嚭娴佸紡闃舵閬垮厤姣忎釜 delta clone 鎵€鏈夋棫娑堟伅瀵硅薄锛岄檷浣?Monitor 鏈湴 reducer 鐨?O(n虏) 椋庨櫓銆?
  return {
    ...content,
    parts: (content.parts || []).map(part => {
      const cloned: ContentPart = { ...part }
      if (part.functionCall) cloned.functionCall = { ...(part.functionCall as StreamFunctionCall) } as ContentPart['functionCall']
      if (part.functionResponse) cloned.functionResponse = { ...part.functionResponse }
      return cloned
    })
  }
}

/**
 * WP15: Monitor 涓撶敤鐨?mergeFunctionCall 钖勫寘瑁呫€?
 *
 * 涓轰粈涔堥渶瑕佽繖涓寘瑁咃細Monitor 鐨?live delta 涓嶉渶瑕?Main Chat 鐨?JSON.parse 鑺傛祦绛栫暐锛?
 * 鍙湪 finalArgs=true锛堟祦寮忓畬鎴愪簨浠讹級鏃惰В鏋?partialArgs銆?
 * 鎬庝箞鏀癸細涓嶄紶 shouldParseArgs锛岃缁熶竴妯″潡浣跨敤榛樿鐨?finalArgs-only 瑙ｆ瀽绛栫暐銆?
 * 鐩殑锛歁onitor 澶у伐鍏峰弬鏁颁笉璺戜笉蹇呰鐨?JSON.parse 寰幆锛屽悓鏃跺叡浜悓涓€鍚堝苟璇箟銆?
 */
function mergeFunctionCall(target: StreamFunctionCall, incoming: StreamFunctionCall): void {
  unifiedMergeFunctionCall(target, incoming)
}

function appendFunctionCallPart(parts: ContentPart[], incomingPart: ContentPart): void {
  const incoming = incomingPart.functionCall as StreamFunctionCall | undefined
  if (!incoming) return

  let isLastFunctionCall = true
  for (let i = parts.length - 1; i >= 0; i--) {
    const existing = parts[i].functionCall as StreamFunctionCall | undefined
    if (!existing) continue

    const reason = getFunctionCallMergeReason(incoming, existing, isLastFunctionCall)
    if (reason) {
      mergeFunctionCall(existing, incoming)
      return
    }

    isLastFunctionCall = false
  }

  const newFunctionCall: StreamFunctionCall = {
    ...(incoming as any),
    name: incoming.name || '',
    args: hasNonEmptyArgs(incoming.args) ? incoming.args : {}
  }
  mergeFunctionCall(newFunctionCall, incoming)
  parts.push({ functionCall: newFunctionCall as ContentPart['functionCall'] })
}

function appendContentPart(target: Content, part: ContentPart): void {
  if (part.text !== undefined) {
    const lastPart = target.parts[target.parts.length - 1]
    const isThought = part.thought === true
    const lastIsThought = lastPart?.thought === true
    if (lastPart && lastPart.text !== undefined && !lastPart.functionCall && lastIsThought === isThought) {
      lastPart.text += part.text
    } else {
      target.parts.push(isThought ? { text: part.text, thought: true } : { text: part.text })
    }
    return
  }

  if (part.functionCall) {
    appendFunctionCallPart(target.parts, part)
    return
  }

  target.parts.push({ ...part })
}

function ensureLastModelContent(contents: Content[], timestamp: number, baseIndex: number): Content {
  const last = contents[contents.length - 1]
  if (last?.role === 'model') {
    return last
  }

  // 淇敼鍘熷洜锛歋ubAgent Monitor 鍙兘鍏堟敹鍒?llm_delta锛屽啀鏀跺埌鏈€缁?content_snapshot锛涙病鏈?model 妤煎眰鏃跺繀椤诲厛鍒涘缓涓€涓湰鍦?live baseline銆?
  // 淇敼鏂瑰紡锛氬湪 contents 鏈熬琛ヤ竴涓?role=model 鐨勭┖ Content锛屽苟鍙綔涓哄墠绔疄鏃舵姇褰变娇鐢ㄣ€?
  // 鐩殑锛氳 Monitor 鑳藉儚涓昏亰澶╀竴鏍疯竟鏀惰竟娓叉煋锛岃€屼笉鏄瓑 run 瀹屾垚鍚庢墠鏄剧ず AI 杈撳嚭銆?
  const created = {
    role: 'model' as const,
    parts: [],
    timestamp,
    // 淇敼鍘熷洜锛歁onitor window 鍙兘涓嶆槸浠?0 寮€濮嬶紱鏂板缓 live model 妤煎眰蹇呴』淇濈暀瀹屾暣 transcript 鐨勭粷瀵?index銆?
    // 淇敼鏂瑰紡锛氱敱璋冪敤鏂逛紶鍏?window.startIndex 浣滀负 baseIndex锛岄粯璁?0 鍏煎鍗曞厓娴嬭瘯鍜屾棫璋冪敤銆?
    // 鐩殑锛歞elete/retry/backendIndex 涓嶅洜瀹炴椂 delta 鍦ㄥ垎椤电獥鍙ｅ唴鐢熸垚灞€閮?index 鑰岄敊浣嶃€?
    index: baseIndex + contents.length
  } as Content
  contents.push(created)
  return created
}

export function applyStreamChunkToContents(contents: Content[], chunk: any, timestamp: number = Date.now(), baseIndex: number = 0): Content[] {
  // 淇敼鍘熷洜锛歋ubAgent Monitor 涓嶈兘缁х画渚濊禆姣忎釜 llm_delta 闄勫甫瀹屾暣 snapshot锛屽惁鍒?events 鍜?contents 閮戒細闅忚緭鍑洪暱搴?O(n虏) 鑶ㄨ儉銆?
  // 淇敼鏂瑰紡锛氭妸涓昏亰澶╂祦寮?reducer 鐨勬牳蹇冭涔夋敹鏁涗负 Content[] delta reducer锛屾敮鎸?text銆乼hought銆乫unctionCall銆乧ontentSnapshot 鍜?usage銆?
  // 鐩殑锛歁onitor 瀹炴椂鏄剧ず SubAgent 杈撳嚭锛屽悓鏃朵繚鎸佸悗绔彧鍙戦€佽交閲?delta銆?
  const source = contents || []
  const next = [...source]
  const snapshot = chunk?.contentSnapshot as Content | undefined
  if (snapshot?.parts) {
    // 淇敼鍘熷洜锛歝ontentSnapshot 鏄粨鏋勮竟鐣屾牎鍑嗭紝鍙渶瑕佹浛鎹㈡渶鍚庝竴涓?model content锛屼笉搴?clone 鍏跺畠鏈彉鍖栨ゼ灞傘€?
    // 淇敼鏂瑰紡锛氬鍒?contents 鏁扮粍骞舵繁鎷疯礉 replacement锛屾棫 Content 瀵硅薄寮曠敤淇濇寔鍏变韩銆?
    // 鐩殑锛氫繚鎸佸揩鐓ц涔夋纭紝鍚屾椂閬垮厤浣庨鏍″噯涔熼€€鍖栨垚鍏ㄩ噺 clone銆?
    const replacement = cloneContent({
      ...snapshot,
      timestamp: snapshot.timestamp || timestamp,
      index: typeof snapshot.index === 'number' ? snapshot.index : baseIndex + Math.max(0, next.length - 1)
    } as Content)
    let lastModelIndex = -1
    for (let index = next.length - 1; index >= 0; index--) {
      if (next[index]?.role === 'model') {
        lastModelIndex = index
        break
      }
    }
    if (lastModelIndex >= 0) {
      next[lastModelIndex] = replacement
    } else {
      replacement.index = baseIndex + next.length
      next.push(replacement)
    }
    return next
  }

  const lastIndex = next.length - 1
  let modelContent: Content
  if (lastIndex >= 0 && next[lastIndex]?.role === 'model') {
    // 淇敼鍘熷洜锛歞elta 鍙細鏀规渶鍚庝竴涓?model Content锛屾棫瀹炵幇姣忔鍏嬮殕鎵€鏈?Content 浼氳澶?transcript 鏈湴澶勭悊鎴愭湰闅忓巻鍙查暱搴﹀闀裤€?
    // 淇敼鏂瑰紡锛氬彧娣辨嫹璐濇渶鍚庝竴涓?model Content/parts锛屽啀鍘熷湴杩藉姞 delta 鍒拌繖涓柊瀵硅薄銆?
    // 鐩殑锛氭湭琚洿鏂扮殑鏃?content 瀵硅薄寮曠敤淇濇寔涓嶅彉锛孷ue 涔熷彧闇€瑕佽拷韪湡姝ｅ彉鍖栫殑灏鹃儴娑堟伅銆?
    modelContent = cloneContent(next[lastIndex])
    next[lastIndex] = modelContent
  } else {
    modelContent = ensureLastModelContent(next, timestamp, baseIndex)
  }

  for (const part of chunk?.delta || []) {
    appendContentPart(modelContent, part)
  }

  if (chunk?.usage) {
    modelContent.usageMetadata = chunk.usage
  }
  if (chunk?.modelVersion) {
    modelContent.modelVersion = chunk.modelVersion
  }
  if (chunk?.thinkingStartTime) {
    modelContent.thinkingStartTime = chunk.thinkingStartTime
  }

  return next
}
