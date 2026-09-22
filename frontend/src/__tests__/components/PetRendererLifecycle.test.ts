import { expect, test, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { PetRenderer } from '../../../../apps/client/src/pets/protocol';

const factories=vi.hoisted(()=>({sprite:vi.fn(),live2d:vi.fn()}));
vi.mock('../../../../apps/client/src/pets/spriteRenderer',()=>({createSpriteRenderer:factories.sprite}));
vi.mock('../../../../apps/client/src/pets/live2dRenderer',()=>({createLive2dRenderer:factories.live2d}));

test('播放器页面已关闭时，迟到的资源加载被销毁且不报告就绪',async()=>{
  document.body.append(document.createElement('canvas'));
  let complete:(renderer:PetRenderer)=>void=()=>{};
  factories.sprite.mockReturnValue(new Promise(resolve=>complete=resolve));
  const messages=vi.spyOn(window,'postMessage').mockImplementation(()=>{});
  const renderer:PetRenderer={parameters:[],apply:vi.fn(),resize:vi.fn(),destroy:vi.fn()};
  try{
    await import('../../../../apps/client/src/pets/renderer');
    window.dispatchEvent(new MessageEvent('message',{source:window,data:{type:'graycode.pet.host',action:'load',sessionId:'fixture',payload:{resource:{kind:'sprite'}}}}));
    expect(factories.sprite).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pagehide'));complete(renderer);await flushPromises();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);expect(renderer.resize).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalledWith(expect.objectContaining({event:'ready'}),'*');
  }finally{messages.mockRestore();document.body.replaceChildren();}
});
