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
