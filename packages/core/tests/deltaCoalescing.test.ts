import { DeltaCoalescer } from '../src/runtime/deltas';

test('密集文本保留首段即时交付，合并后内容完全一致', () => {
  const events: Record<string, unknown>[][] = [], buffer = new DeltaCoalescer(parts => events.push(parts));
  buffer.push([{ text: '首段' }]); expect(events).toEqual([[{ text: '首段' }]]);
  for (let i = 0; i < 1000; i++) buffer.push([{ text: '继续' }]);
  buffer.finish();
  expect(events.flat().map(part => part.text).join('')).toBe('首段' + '继续'.repeat(1000));
  expect(buffer.statistics()).toEqual({ inputEvents: 1001, outputEvents: 2 });
  buffer.push([{ text: '结束后的迟到内容' }]); expect(events).toHaveLength(2);
});

test('思考、工具参数和签名保序，结束前交付全部剩余文本', () => {
  const events: Record<string, unknown>[][] = [], buffer = new DeltaCoalescer(parts => events.push(parts));
  buffer.push([{ text: '开始' }]);
  buffer.push([{ text: '思考甲', thought: true }]); buffer.push([{ text: '思考乙', thought: true }]);
  const signature = { text: '', thoughtSignatures: { anthropic: 'fixture' } };
  const call = { functionCall: { id: 'tool', name: 'read', args: {} } };
  buffer.push([signature, call]); buffer.push([{ text: '正文' }]); buffer.finish();
  expect(events.flat()).toEqual([{ text: '开始' }, { text: '思考甲思考乙', thought: true }, signature, call, { text: '正文' }]);
});

test('连续流在短等待后刷新，并限制待合并文本体积', () => {
  jest.useFakeTimers();
  try {
    const emit = jest.fn(), buffer = new DeltaCoalescer(emit);
    buffer.push([{ text: '开始' }]); buffer.push([{ text: '继续' }]);
    expect(emit).toHaveBeenCalledTimes(1); jest.advanceTimersByTime(16); expect(emit).toHaveBeenCalledTimes(2);
    buffer.push([{ text: '中'.repeat(6000) }]); expect(emit).toHaveBeenCalledTimes(3);
    buffer.finish(); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
