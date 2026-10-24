import type { SpeechProvider, SpeechSettings } from '../packages/contracts/src/speech';

/** 单次合成请求的文本上限；更长的内容由调用方分段发送。 */
export const SPEECH_MAX_TEXT = 12_000;
/** 每段送给提供商的字符上限，长回复按句子拼到这个长度以内。 */
export const SPEECH_CHUNK_LIMIT = 1_200;
/** 边合成边播放时第一段只拼一两句，尽快出声；后续段在播放期间合成。 */
export const SPEECH_FIRST_CHUNK_LIMIT = 100;

/** 设置页切换提供商与服务端读取设置共用的默认值；未填写的端点、模型和音色按当前提供商补齐。 */
export const SPEECH_PROVIDER_DEFAULTS: Record<SpeechProvider, Partial<SpeechSettings>> = {
  fish: { endpoint: 'https://api.fish.audio', model: 'drama-3', format: 'mp3' },
  openai: { endpoint: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy', format: 'mp3' },
  qwen: { endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    model: 'qwen-audio-3.1-tts-flash', voice: 'Cherry', format: 'mp3' },
  system: { format: 'wav' },
};

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  enabled: false, provider: 'fish', speed: 1, autoPlay: false, ...SPEECH_PROVIDER_DEFAULTS.fish,
};

/**
 * 把助手回复的 Markdown 变成适合朗读的文字：代码块、图片和网址不读，链接只读文字，
 * 去掉标题、列表、引用、强调和表格符号。Fish 的 [情感] 与 <whisper> 标签不是 Markdown，原样保留。
 */
export function speechPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(?:https?|mailto):[^>\s]+>/g, '')
    // 网址遇到全角标点就结束；末尾的英文标点属于句子，保留下来。
    .replace(/https?:\/\/[^\s<>()[\]　-〿＀-￯]+/g, url => /[.,;:!?]+$/.exec(url)?.[0] ?? '')
    .replace(/`([^`\n]+)`/g, '$1')
    // 以下按行匹配只用 [ \t]：\s 会跨过换行，把相邻的表格行并成一行。
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(?:\n|$)/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, cells: string) => cells.split('|').map(cell => cell.trim()).filter(Boolean).join('，'))
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, '')
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 单句超过上限时优先在空格或逗号处断开，找不到才按字符硬切，且不拆开代理对。 */
function cutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const soft = Math.max(window.lastIndexOf(' '), window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf('、'));
  if (soft >= limit / 2) return soft + 1;
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

/**
 * 在句末或换行处分段，再把相邻句子拼到上限以内，减少请求次数又不在句中停顿。
 * firstLimit 只限制第一段拼接多少句；单句超过 limit 时才会被切开。
 */
export function splitSpeechText(value: string, limit = SPEECH_CHUNK_LIMIT, firstLimit = limit): string[] {
  const text = value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!text) return [];
  const chunks: string[] = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  // 英文句号后必须跟空白才算句末，避免拆开 3.14 或网址里的点。
  for (const sentence of text.split(/(?<=[。！？!?；;\n])|(?<=\.)(?=\s)/u)) {
    let rest = sentence;
    while (rest.length > limit) {
      flush();
      const cut = cutPoint(rest, limit);
      const piece = rest.slice(0, cut).trim();
      if (piece) chunks.push(piece);
      rest = rest.slice(cut);
    }
    if (current.length + rest.length > (chunks.length ? limit : firstLimit)) flush();
    current += rest;
  }
  flush();
  return chunks;
}

/** 朗读前的统一处理：转成纯文字再分段。 */
export function speechSegments(markdown: string, options: { firstLimit?: number } = {}): string[] {
  return splitSpeechText(speechPlainText(markdown), SPEECH_CHUNK_LIMIT, options.firstLimit);
}
