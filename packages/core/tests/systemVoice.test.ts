import childProcess from 'node:child_process';
import { SystemVoice } from '../../../apps/server/src/speech/systemVoice';

(process.platform === 'win32' ? test : test.skip)('本机语音由同一个常驻进程合成多段，出错后继续可用，关闭后结束', async () => {
  const spawn = jest.spyOn(childProcess, 'spawn');
  const voice = new SystemVoice();
  try {
    expect((await voice.voices()).length).toBeGreaterThan(0);
    const clips = await voice.synthesize(['你好。', 'Hello there.'], undefined, 1);
    expect(clips).toHaveLength(2);
    for (const clip of clips) expect(clip.subarray(0, 4).toString('latin1')).toBe('RIFF');
    await expect(voice.synthesize(['不存在的音色'], 'GrayCode Missing Voice', 1)).rejects.toThrow();
    expect((await voice.synthesize(['恢复后继续。'], undefined, 1.5))[0].length).toBeGreaterThan(44);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    voice.close();
    spawn.mockRestore();
  }
  await expect(voice.synthesize(['关闭以后'], undefined, 1)).rejects.toThrow('已关闭');
}, 60_000);

(process.platform === 'win32' ? test : test.skip)('中止正在合成的请求只结束这一次，排在后面的请求换新进程完成，不被旧进程的退出误伤', async () => {
  const voice = new SystemVoice();
  try {
    await voice.synthesize(['预热。'], undefined, 1);
    const controller = new AbortController();
    const long = voice.synthesize(['这是一段较长的句子，保证中止时合成仍在进行。'.repeat(20)], undefined, 1, controller.signal);
    const queued = voice.synthesize(['排在后面的请求。'], undefined, 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort(new Error('语音合成已取消。'));
    await expect(long).rejects.toThrow('语音合成已取消。');
    expect((await queued)[0].subarray(0, 4).toString('latin1')).toBe('RIFF');
    // 结束旧进程后立即发起的新请求同样不能收到旧进程的退出错误。
    const again = new AbortController();
    const next = voice.synthesize(['再一段较长的句子。'.repeat(20)], undefined, 1, again.signal);
    await new Promise(resolve => setTimeout(resolve, 100));
    again.abort(new Error('语音合成已取消。'));
    await expect(next).rejects.toThrow('语音合成已取消。');
    expect(await voice.synthesize(['中止后马上继续。'], undefined, 1)).toHaveLength(1);
  } finally {
    voice.close();
  }
}, 60_000);
