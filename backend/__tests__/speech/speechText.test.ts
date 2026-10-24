import { speechPlainText, speechSegments, splitSpeechText } from '../../../shared/speech';

describe('朗读文本整理', () => {
  test('去掉代码、图片、网址和 Markdown 符号，链接只读文字', () => {
    const markdown = [
      '# 结果汇总',
      '',
      '这是 **重点**，也是*强调*，还有 ~~删除~~ 和 `inline`。',
      '- 第一项',
      '2. 第二项',
      '> 引用的话',
      '',
      '```ts',
      'const secret = 1;',
      '```',
      '![截图](https://example.com/a.png)',
      '详见 [文档](https://example.com/docs) 或 https://example.com/raw。',
      '',
      '| 名称 | 数值 |',
      '| --- | ---: |',
      '| 速度 | 3.14 |',
      '---',
    ].join('\n');
    const text = speechPlainText(markdown);
    expect(text).not.toMatch(/[#*`|>~]|https?:|const secret|截图/);
    expect(text).toContain('结果汇总');
    expect(text).toContain('这是 重点，也是强调，还有 删除 和 inline。');
    expect(text).toContain('第一项\n第二项\n引用的话');
    expect(text).toContain('详见 文档 或 。');
    expect(text).toContain('名称，数值\n速度，3.14');
  });

  test('未闭合的代码块到结尾都不朗读，Fish 情感标签原样保留', () => {
    expect(speechPlainText('前文\n```\nrm -rf /\n还在代码里')).toBe('前文');
    expect(speechPlainText('[轻声]晚安，<whisper>明天见</whisper>。')).toBe('[轻声]晚安，<whisper>明天见</whisper>。');
    expect(speechPlainText('2 * 3 = 6，snake_case_name 不变')).toBe('2 * 3 = 6，snake_case_name 不变');
  });
});

describe('朗读分段', () => {
  test('中文按句末拼段，不丢内容', () => {
    const text = '第一句。第二句！第三句？\n第四句；'.repeat(120);
    const chunks = splitSpeechText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 80)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  test('英文在句号后的空白处分句，不拆开小数', () => {
    const sentence = 'Pi is about 3.14 today. ';
    const chunks = splitSpeechText(sentence.repeat(20), 60);
    expect(chunks.every(chunk => chunk.endsWith('today.'))).toBe(true);
  });

  test('超长单句优先在空格或逗号处断开', () => {
    const chunks = splitSpeechText('word '.repeat(100).trim(), 52);
    expect(chunks.every(chunk => !/\bwor$|^d\b/.test(chunk))).toBe(true);
    expect(chunks.join(' ')).toBe('word '.repeat(100).trim());
  });

  test('没有断点时硬切，但不拆开代理对', () => {
    const text = '😀'.repeat(700);
    const chunks = splitSpeechText(text, 1200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1200);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(chunks.join('')).toBe(text);
  });

  test('第一段只拼一两句以便尽快出声，后续段仍按上限拼接', () => {
    const text = '短句一。短句二。'.repeat(40);
    const [first, ...rest] = splitSpeechText(text, 200, 10);
    expect(first).toBe('短句一。短句二。');
    expect(rest.every(chunk => chunk.length <= 200 && chunk.length > 10)).toBe(true);
    // 第一句本身超过 firstLimit 时整句保留，只在超过 limit 时才切开。
    expect(splitSpeechText(`${'长'.repeat(30)}。后面。`, 200, 12)[0]).toBe(`${'长'.repeat(30)}。`);
  });

  test('只有空白或只有代码时没有可读片段', () => {
    expect(splitSpeechText(' \n\t ')).toEqual([]);
    expect(speechSegments('```\ncode\n```')).toEqual([]);
  });
});
