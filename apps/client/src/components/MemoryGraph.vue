<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { LongMemoryGraph, LongMemoryGraphNode } from '@graycode/contracts';
const props = defineProps<{ graph: LongMemoryGraph; busy?: boolean; canExpand?: boolean }>();
const emit = defineEmits<{ select: [node: LongMemoryGraphNode]; more: [] }>();
const viewport = ref<HTMLElement>(), zoom = ref(1), autoFit = ref(true), viewportWidth = ref(0);
const arrowId = `memory-arrow-${crypto.randomUUID()}`;
const labels: Record<string, string> = { fact: '事实', preference: '偏好', experience: '经验', project: '项目', procedure: '方法', event: '事件', summary: '摘要', user: '用户来源', model: '模型来源', tool: '工具来源', fiction: '剧情来源', import: '导入来源' };
const nodeWidth = 250, nodeHeight = 116, rowHeight = 150;
const horizontal = computed(() => viewportWidth.value >= 760);
const width = computed(() => horizontal.value ? 890 : Math.max(290, Math.min(400, viewportWidth.value - 12)));
const sides = computed(() => ({ dependency: props.graph.nodes.filter(node => node.side === 'dependency'), dependent: props.graph.nodes.filter(node => node.side === 'dependent' || node.side === 'related') }));
const height = computed(() => Math.max(300, (horizontal.value ? Math.max(sides.value.dependency.length, sides.value.dependent.length, 1) : props.graph.nodes.length) * rowHeight + 40));
const layout = computed(() => props.graph.nodes.map(node => {
  if (!horizontal.value) {
    const index = node.side === 'dependency' ? sides.value.dependency.findIndex(row => row.key === node.key)
      : node.side === 'selected' ? sides.value.dependency.length : sides.value.dependency.length + 1 + sides.value.dependent.findIndex(row => row.key === node.key);
    return { ...node, x: (width.value - nodeWidth) / 2, y: 20 + index * rowHeight };
  }
  const column = node.side === 'dependency' ? 0 : node.side === 'selected' ? 1 : 2;
  const rows = node.side === 'selected' ? [node] : node.side === 'dependency' ? sides.value.dependency : sides.value.dependent;
  return { ...node, x: 20 + column * 300, y: (height.value - rows.length * rowHeight) / 2 + rows.findIndex(row => row.key === node.key) * rowHeight + 12 };
}));
const paths = computed(() => {
  const nodes = new Map(layout.value.map(node => [node.key, node]));
  return props.graph.edges.flatMap(edge => {
    const from = nodes.get(edge.from), to = nodes.get(edge.to); if (!from || !to) return [];
    if (!horizontal.value) return [{ key: `${edge.from}/${edge.to}`, association:edge.association, path: `M${from.x + nodeWidth},${from.y + nodeHeight / 2} H${width.value - 8} V${to.y + nodeHeight / 2} H${to.x + nodeWidth + 3}` }];
    const x = from.x + nodeWidth, y = from.y + nodeHeight / 2, endY = to.y + nodeHeight / 2, middle = (x + to.x) / 2;
    return [{ key: `${edge.from}/${edge.to}`, association:edge.association, path: `M${x},${y} H${middle} V${endY} H${to.x - 3}` }];
  });
});
function fit() {
  autoFit.value = true;
  if (viewport.value?.clientWidth) { viewportWidth.value = viewport.value.clientWidth; zoom.value = Math.min(1, Math.max(0.35, (viewport.value.clientWidth - 12) / width.value)); }
  center();
}
function center() {
  void nextTick(() => {
    const root=layout.value.find(node=>node.key===props.graph.root), element=viewport.value; if (!element || !root) return;
    const top=root.y*zoom.value, bottom=(root.y+nodeHeight)*zoom.value;
    if(top<element.scrollTop || bottom>element.scrollTop+element.clientHeight) element.scrollTop=Math.max(0,(top+bottom-element.clientHeight)/2);
  });
}
function scale(amount: number) { autoFit.value = false; zoom.value = Math.min(1.75, Math.max(0.35, +(zoom.value + amount).toFixed(2))); center(); }
let observer: ResizeObserver | undefined;
onMounted(() => { observer = new ResizeObserver(() => { if (viewport.value?.clientWidth) viewportWidth.value=viewport.value.clientWidth; if (autoFit.value) fit(); }); if (viewport.value) observer.observe(viewport.value); fit(); });
onUnmounted(() => observer?.disconnect());
watch(() => props.graph.root, () => { if (autoFit.value) fit(); else center(); });
</script>

<template>
  <section class="memory-graph" aria-label="记忆关系图">
    <div class="memory-graph-toolbar"><span>来源与依据 · 当前记忆 · 派生与关联</span><div><button aria-label="缩小关系图" @click="scale(-0.15)">−</button><span>{{ Math.round(zoom * 100) }}%</span><button aria-label="放大关系图" @click="scale(0.15)">＋</button><button @click="fit">适应宽度</button></div></div>
    <div ref="viewport" class="memory-graph-viewport">
      <svg :width="width * zoom" :height="height * zoom" :viewBox="`0 0 ${width} ${height}`" aria-label="点击记忆节点查看或编辑，来源节点显示原文">
        <defs><marker :id="arrowId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
        <path v-for="edge in paths" :key="edge.key" class="memory-graph-edge" :class="{association:edge.association}" :d="edge.path" :marker-end="edge.association?undefined:`url(#${arrowId})`" />
        <foreignObject v-for="node in layout" :key="node.key" :x="node.x" :y="node.y" :width="nodeWidth" :height="nodeHeight">
          <button class="memory-graph-node" :class="{selected:node.key===graph.root, inactive:!node.active, source:node.type==='source'}" :disabled="busy" :aria-label="`${node.type==='source'?'查看来源':'查看记忆'}：${node.preview}`" @click="emit('select',node)">
            <span class="memory-graph-node-meta"><span>{{labels[node.kind] || node.kind}}{{node.side==='related'?' · 关联':''}}{{node.confidence==='inferred'?' · 待核对':node.confidence==='disputed'?' · 有争议':''}}</span><span>v{{node.version}} · {{node.active?'有效':'历史或失效'}}</span></span>
            <strong>{{node.title}}</strong><span class="memory-graph-preview">{{node.preview}}</span>
          </button>
        </foreignObject>
      </svg>
    </div>
    <footer><span>显示 {{graph.nodes.length}} 个节点。实线表示依据或派生，虚线表示实体关联。点击记忆可查看对应修订。{{graph.truncated?'关系较多，仅显示部分邻接节点。':''}}</span><button v-if="graph.truncated && canExpand !== false" :disabled="busy" @click="emit('more')">显示更多关系</button></footer>
  </section>
</template>

<style scoped>
.memory-graph { margin: 14px 0; border: 1px solid var(--border); min-width: 0; }
.memory-graph-toolbar, footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 10px 12px; color: var(--muted); font-size: 11px; line-height: 1.7; }
.memory-graph-toolbar { border-bottom: 1px solid var(--border); }
.memory-graph-toolbar>div { display: flex; gap: 7px; align-items: center; }
.memory-graph-toolbar button, footer button { padding: 4px 7px; font-size: 11px; }
.memory-graph-viewport { height: 380px; max-height: 55dvh; min-height: 260px; overflow: auto; background: var(--background); }
svg { display: block; margin: auto; }
marker path { fill: var(--muted); }
.memory-graph-edge { stroke: var(--muted); stroke-width: 1; fill: none; opacity: .65; }
.memory-graph-edge.association { stroke: var(--accent); stroke-dasharray: 5 4; }
.memory-graph-node { box-sizing: border-box; display: flex; flex-direction: column; gap: 7px; width: 100%; height: 100%; margin: 0; padding: 11px 13px; text-align: left; background: var(--panel); border: 1px solid var(--border); border-radius: 0; color: var(--text); cursor: pointer; font: inherit; }
.memory-graph-node.selected { border: 2px solid var(--accent); }
.memory-graph-node.inactive { border-style: dashed; }
.memory-graph-node:hover:not(:disabled) { background: var(--hover); }
.memory-graph-node:focus-visible { outline: 2px solid var(--accent); outline-offset: -4px; }
.memory-graph-node-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: var(--muted); }
.memory-graph-node strong { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.memory-graph-preview { font-size: 12px; line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
footer { border-top: 1px solid var(--border); }
</style>
