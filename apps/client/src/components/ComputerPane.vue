<script setup lang="ts">
import { rpc as call } from '../api';
import { useComputerPane } from './useComputerPane';
import './computerPane.css';

const props = defineProps<{ visible: boolean }>();
const controlLabels: Record<string, string> = { Window: '窗口', Text: '文本', Document: '正文', Edit: '输入框', Button: '按钮', Pane: '区域', ScrollBar: '滚动条', CheckBox: '复选框', RadioButton: '单选项', ComboBox: '下拉框', List: '列表', ListItem: '列表项', Menu: '菜单', MenuItem: '菜单项', Tab: '标签组', TabItem: '标签页', Tree: '树形列表', TreeItem: '树形项目', Slider: '滑块', ToolBar: '工具栏', Group: '分组', Custom: '自定义' };
const actionLabels: Record<string, string> = { focusWindow: '切换窗口', focusElement: '聚焦控件', invoke: '点击控件', setValue: '填写内容', select: '选中', toggle: '切换状态', expand: '展开', collapse: '收起', click: '点击', type: '输入文字', key: '发送按键', scroll: '滚动', drag: '拖动' };
const resultLabels: Record<string, string> = { dispatching: '已派发', completed: '已完成', failed: '失败', unknown: '结果待核实' };
const { inventory, selectedWindow, observation, selectedElement, filter, text, key, error, notice, busy, history, tab,
  pointerMode, imageSize, actualSize, windows, element, elements, status, imageUrl, patternActions,
  perform, readWindows, observe, chooseWindow, chooseTab, action, chooseElement, pointerDown, pointerUp, cancelPointer } = useComputerPane(() => props.visible);
</script>

<template>
  <section class="computer-pane" aria-label="电脑控制" :aria-busy="busy">
    <header class="computer-toolbar">
      <div><strong>本机电脑</strong><span>{{ status?.active ? '正在控制' : '查看窗口' }}</span></div>
      <button v-if="status?.active" class="computer-stop" @click="call('computer.stop').catch(cause => error = cause.message)">立即停止</button>
      <button :disabled="busy" title="重新列出当前打开的应用窗口" @click="perform(readWindows)">刷新窗口列表</button>
    </header>
    <p v-if="status?.error" class="computer-error">{{ status.error }}</p>
    <p v-if="error" class="computer-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="computer-notice" role="status">{{ notice }}</p>
    <div v-if="status?.pausedRunId" class="computer-paused"><span>主人已接管，任务正在等待。</span><button :disabled="busy" @click="perform(() => call('computer.allowRun', { runId: status!.pausedRunId! }))">允许该任务继续</button></div>
    <div class="computer-target">
      <label for="computer-window">目标窗口</label>
      <select id="computer-window" :value="selectedWindow" :disabled="busy" @change="perform(() => chooseWindow(($event.target as HTMLSelectElement).value))">
        <option value="">选择一个打开的窗口</option>
        <option v-for="item in windows" :key="item.id" :value="item.id">{{ item.title || '无标题窗口' }} · {{ item.processId }}{{ item.minimized ? ' · 已最小化' : '' }}</option>
      </select>
      <details class="computer-window-filter"><summary title="筛选窗口与查看显示器">筛选</summary><div><input v-model="filter" type="search" placeholder="应用或窗口名称" aria-label="查找窗口"><p>{{ windows.length }} 个匹配窗口</p><p v-for="display in inventory?.displays" :key="display.id">{{ display.id }} · {{ display.bounds.width }} × {{ display.bounds.height }} · {{ Math.round(display.scaleFactor * 100) }}%</p></div></details>
    </div>
    <nav class="computer-tabs" aria-label="电脑面板视图">
      <button :aria-pressed="tab === 'screen'" :disabled="busy" @click="perform(() => chooseTab('screen'))">画面</button>
      <button :aria-pressed="tab === 'controls'" :disabled="busy" @click="perform(() => chooseTab('controls'))">控件与输入</button>
      <button :aria-pressed="tab === 'history'" :disabled="busy" @click="perform(() => chooseTab('history'))">操作记录</button>
    </nav>
    <div v-if="tab === 'history'" class="computer-history">
      <p v-if="!history.length" class="computer-hint">本次启动还没有电脑操作记录。</p>
      <article v-for="entry in history" :key="entry.id"><strong>{{ actionLabels[entry.action] || entry.action }} · {{ entry.window.title }}</strong><span>{{ resultLabels[entry.status] || entry.status }} · {{ new Date(entry.requestedAt).toLocaleString() }}</span><code>PID {{ entry.window.processId }} · {{ entry.window.executable }}</code><p v-if="entry.error">{{ entry.error }}</p></article>
    </div>
    <template v-else>
      <div class="computer-observe-toolbar">
        <button :disabled="busy || !selectedWindow" @click="perform(observe)">{{ busy ? '正在读取…' : '刷新画面' }}</button>
        <button :disabled="busy || !observation" @click="perform(() => action({ action: 'focusWindow' }))">切换到窗口</button>
        <label>清晰度<select v-model.number="imageSize" :disabled="busy" @change="perform(observe)"><option :value="1280">标准 · 1280</option><option :value="1920">清晰 · 1920</option><option :value="2560">精细 · 2560</option></select></label>
      </div>
      <template v-if="observation">
        <details class="computer-identity"><summary><span>{{ observation.window.title }}</span><time>{{ new Date(observation.capturedAt).toLocaleTimeString() }}</time></summary><dl><dt>进程</dt><dd>{{ observation.window.processId }} · {{ observation.window.executable || '路径不可读' }}</dd><dt>启动时间</dt><dd>{{ observation.window.processStartedAt || '不可读' }}</dd><dt v-if="observation.window.commandLine">启动命令</dt><dd v-if="observation.window.commandLine">{{ observation.window.commandLine }}</dd><dt>窗口位置</dt><dd>{{ observation.window.bounds.x }}, {{ observation.window.bounds.y }} · {{ observation.window.bounds.width }} × {{ observation.window.bounds.height }} · {{ observation.window.dpi }} DPI</dd></dl></details>
        <p v-if="observation.accessibilityError" class="computer-error">{{ observation.accessibilityError }}</p>
        <template v-if="tab === 'screen'">
          <div v-if="imageUrl" class="computer-picture-toolbar">
            <select v-model="pointerMode" :disabled="busy" aria-label="截图操作"><option value="inspect">仅查看</option><option value="click">单击</option><option value="double">双击</option><option value="right">右键</option><option value="drag">拖动</option></select>
            <button :aria-pressed="actualSize" @click="actualSize = !actualSize">{{ actualSize ? '适应面板' : '原始像素' }}</button>
            <span>{{ observation.screenshot!.width }} × {{ observation.screenshot!.height }}</span>
          </div>
          <div v-if="imageUrl" class="computer-stage" :class="{ 'actual-size': actualSize }"><img :src="imageUrl" alt="所选窗口的当前截图" draggable="false" :class="{ interactive: pointerMode !== 'inspect' }" @pointerdown="pointerDown" @pointerup="pointerUp" @pointercancel="cancelPointer" @lostpointercapture="cancelPointer"></div>
          <div v-else class="computer-empty"><strong>当前窗口没有可用画面</strong><p>窗口最小化时可先切换到窗口，再刷新；也可使用“控件与输入”查看可访问的内容。</p></div>
          <p class="computer-caption">{{ pointerMode === 'inspect' ? '画面按需刷新。选择操作方式后，可在图中定位。' : '操作作用于真实窗口，完成后刷新画面。' }} 清晰度数值为图片最长边像素；小字难辨时可提高。这里查看的截图不发送给模型。</p>
        </template>
        <div v-else class="computer-controls">
          <div class="computer-elements" aria-label="可见控件"><button v-for="item in elements" :key="item.id" :aria-pressed="selectedElement === item.id" :disabled="busy || !item.enabled" @click="chooseElement(item)"><small :title="item.type">{{ controlLabels[item.type] || item.type }}</small><span>{{ item.name || item.automationId || '未命名控件' }}</span><small v-if="item.focused">焦点</small><span v-if="item.value" class="computer-value">{{ item.value }}</span></button></div>
          <p v-if="!elements.length" class="computer-hint">此窗口没有提供可见控件，可返回画面定位。</p><p v-if="observation.truncated" class="computer-hint">控件列表已截断，当前焦点仍单独保留。可收起窗口内无关内容后重新观察。</p>
          <div class="computer-input"><p>{{ element ? `已选择：${element.name || element.type}` : '选择控件，或向当前已核实的焦点输入文字。' }}</p><textarea v-model="text" placeholder="要输入的文字" aria-label="电脑输入文字" :disabled="busy" rows="3"></textarea><div><button v-for="[, type, label] in patternActions" :key="type" :disabled="busy || element?.password" @click="perform(() => action({ action: type, elementId: selectedElement, text }))">{{ label }}</button><button :disabled="busy || !element || element.password" @click="perform(() => action({ action: 'focusElement', elementId: selectedElement }))">聚焦控件</button><button :disabled="busy || !text || element?.password || (!element && !observation.focusedElementId)" @click="perform(() => action({ action: 'type', text, elementId: selectedElement || undefined }))">输入到当前焦点</button></div><div><input v-model="key" aria-label="按键组合" placeholder="Control+A"><button :disabled="busy || !key" @click="perform(() => action({ action: 'key', key, elementId: selectedElement || undefined }))">发送按键</button><button :disabled="busy || !element" @click="perform(() => action({ action: 'scroll', elementId: selectedElement, scrollY: 3 }))">向下滚动</button><button :disabled="busy || !element" @click="perform(() => action({ action: 'scroll', elementId: selectedElement, scrollY: -3 }))">向上滚动</button></div></div>
        </div>
      </template>
      <div v-else class="computer-empty"><span class="computer-empty-icon" aria-hidden="true">▣</span><strong>{{ busy ? '正在读取窗口…' : '选择窗口，查看当前画面' }}</strong><p>画面支持放大查看、点击和拖动。控件及文字输入位于独立标签中。</p></div>
    </template>
  </section>
</template>
