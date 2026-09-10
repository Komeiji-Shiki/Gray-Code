/* 仅接受直接父窗口提供的已清理内容，不开放文件、网络或宿主调用。 */
const characterRoot = document.getElementById('character-content');
let characterFrameId;
addEventListener('message', event => {
  if (event.source !== parent || typeof event.data?.id !== 'string' || typeof event.data?.html !== 'string') return;
  if (characterFrameId && characterFrameId !== event.data.id) return;
  characterFrameId = event.data.id;
  characterRoot.innerHTML = event.data.html;
});
new ResizeObserver(() => {
  if (characterFrameId) parent.postMessage({ id: characterFrameId, height: Math.max(characterRoot.scrollHeight, characterRoot.getBoundingClientRect().height) }, '*');
}).observe(characterRoot);
