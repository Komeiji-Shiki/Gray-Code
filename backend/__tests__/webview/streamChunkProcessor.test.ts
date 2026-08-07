/**
 * StreamChunkProcessor 视图缺失场景回归测试。
 *
 * 覆盖：
 * 1. 正常路径（视图存在）：chunk/终结事件按 streamChunk 格式送达，顺序不变；
 * 2. 视图缺失（面板关闭/重建窗口）时终结类事件（complete/cancelled/error）不静默丢弃：
 *    先清空 messageBuffer，再暂存待视图恢复后补发，且补发格式与正常路径一致；
 * 3. 无 view 时 flush() 清空 messageBuffer，防止缓冲滞留内存；
 * 4. 视图缺失时 error 终结事件仍返回 true（调用方据此中断 for-await 循环）。
 */

import { StreamChunkProcessor } from '../../../webview/stream/StreamChunkProcessor';

interface ViewRef {
  current: { webview: { postMessage: jest.Mock } } | undefined;
}

describe('StreamChunkProcessor - 视图缺失时终结事件补发', () => {
  const postMessage = jest.fn();
  const viewRef: ViewRef = { current: undefined };

  const makeProcessor = (conversationId = 'conv-1', streamId = 'stream-1'): StreamChunkProcessor =>
    new StreamChunkProcessor(() => viewRef.current as any, conversationId, streamId);

  beforeEach(() => {
    postMessage.mockClear();
    viewRef.current = { webview: { postMessage } };
  });

  it('正常路径：chunk 与 complete 依次以 streamChunk 格式送达，顺序不变', () => {
    const processor = makeProcessor();
    processor.processChunk({ chunk: 'hello' });
    processor.processChunk({ content: 'hello', checkpoints: [{ id: 'cp-1' }] });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0][0].type).toBe('streamChunk');
    expect(postMessage.mock.calls[0][0].data).toMatchObject({
      conversationId: 'conv-1',
      streamId: 'stream-1',
      type: 'chunk',
      chunk: 'hello'
    });
    expect(postMessage.mock.calls[1][0].type).toBe('streamChunk');
    expect(postMessage.mock.calls[1][0].data).toMatchObject({
      conversationId: 'conv-1',
      streamId: 'stream-1',
      type: 'complete',
      content: 'hello',
      checkpoints: [{ id: 'cp-1' }]
    });
  });

  it('视图缺失时 complete 不静默丢弃：视图恢复后 flush() 补发，格式与正常路径一致', () => {
    const processor = makeProcessor();
    viewRef.current = undefined;

    const result = processor.processChunk({ content: 'done', checkpoints: [{ id: 'cp-1' }] });
    expect(result).toBe(false);
    // 视图缺失期间不得发送任何消息
    expect(postMessage).not.toHaveBeenCalled();

    // 视图恢复后补发
    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].type).toBe('streamChunk');
    expect(postMessage.mock.calls[0][0].data).toMatchObject({
      conversationId: 'conv-1',
      streamId: 'stream-1',
      type: 'complete',
      content: 'done',
      checkpoints: [{ id: 'cp-1' }]
    });
  });

  it('视图缺失时 cancelled 补发且丢弃前不滞留 messageBuffer 中的普通 chunk', () => {
    const processor = makeProcessor();
    // 第一个 chunk 立即 flush；第二个 chunk 进入节流缓冲（50ms 内不立即发送）
    processor.processChunk({ chunk: 'first' });
    processor.processChunk({ chunk: 'second' });
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 视图消失后收到 cancelled：缓冲中的 'second' 被清空，cancelled 暂存
    viewRef.current = undefined;
    processor.processChunk({ cancelled: true, content: 'partial' });
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 视图恢复：只补发 cancelled，被清空的 chunk 不再投递
    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0].type).toBe('streamChunk');
    expect(postMessage.mock.calls[1][0].data).toMatchObject({
      type: 'cancelled',
      content: 'partial'
    });

    // 后续正常 chunk 在 cancelled 之后送达
    processor.processChunk({ content: 'next complete' });
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage.mock.calls[2][0].data.type).toBe('complete');
  });

  it('视图缺失时 error 终结事件返回 true 且视图恢复后补发', () => {
    const processor = makeProcessor();
    viewRef.current = undefined;

    const result = processor.processChunk({ error: { code: 'API_ERROR', message: 'boom' } });
    expect(result).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();

    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].data).toMatchObject({
      type: 'error',
      error: { code: 'API_ERROR', message: 'boom' }
    });
  });

  it('视图缺失时非终结 chunk 直接丢弃，不影响后续终结事件补发', () => {
    const processor = makeProcessor();
    viewRef.current = undefined;

    expect(processor.processChunk({ chunk: 'incremental' })).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();

    // 后续终结事件仍能暂存并补发
    expect(processor.processChunk({ content: 'final' })).toBe(false);
    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].data).toMatchObject({
      type: 'complete',
      content: 'final'
    });
  });

  it('无 view 时 flush() 清空 messageBuffer 防止滞留，视图恢复后不再补发旧缓冲', async () => {
    const processor = makeProcessor();
    // 第一个 chunk 立即 flush；第二个 chunk 进入节流缓冲
    processor.processChunk({ chunk: 'a' });
    processor.processChunk({ chunk: 'b' });
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 视图缺失时 flush：缓冲被清空，不发送也不滞留
    viewRef.current = undefined;
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 视图恢复后再 flush：缓冲已空，无多余消息
    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 等待超过节流窗口（50ms），新 chunk 应正常送达（而非恢复旧缓冲）
    await new Promise(resolve => setTimeout(resolve, 80));
    processor.processChunk({ chunk: 'c' });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0].data.type).toBe('chunk');
    expect(postMessage.mock.calls[1][0].data.chunk).toBe('c');
  });

  it('sendError 在视图缺失时暂存，视图恢复后补发', () => {
    const processor = makeProcessor();
    viewRef.current = undefined;

    processor.sendError('REROLL_ERROR', 'failed', 'API_ERROR');
    expect(postMessage).not.toHaveBeenCalled();

    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].data).toMatchObject({
      type: 'error',
      error: { code: 'REROLL_ERROR', message: 'failed', type: 'API_ERROR' }
    });
  });

  it('正常路径：cancelled 先发送缓冲的 chunk 再发送终结事件（既有语义不变）', () => {
    const processor = makeProcessor();
    processor.processChunk({ chunk: 'first' });
    processor.processChunk({ chunk: 'second' });
    expect(postMessage).toHaveBeenCalledTimes(1);

    processor.processChunk({ cancelled: true, content: 'partial' });
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage.mock.calls[1][0].data).toMatchObject({ type: 'chunk', chunk: 'second' });
    expect(postMessage.mock.calls[2][0].data).toMatchObject({ type: 'cancelled', content: 'partial' });
  });
});
