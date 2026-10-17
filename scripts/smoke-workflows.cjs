const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function screenshot(window, output, name) {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  return name;
}

async function runProjectSwitchWorkflow({ rpc, ui, evaluate, chat, until, getRequests }) {
  const ordinary = await ui('ui.mode.new', { mode: 'chat', automaticWorkspace: true });
  await evaluate(`window.__projectSwitchFocus = null;
    window.graycode.subscribe(event => {
      if (event.type === 'ui.conversation.focused') window.__projectSwitchFocus = event;
    }); undefined`);
  await rpc('ui.command', { command: 'platform.openModeConversation', data: { conversationId: ordinary.conversationId } });
  await until(() => evaluate(`window.__projectSwitchFocus?.conversationId === ${JSON.stringify(ordinary.conversationId)}`),
    'ordinary conversation before project switch');
  const ordinaryWorkspaceId = await evaluate('window.__projectSwitchFocus.workspaceId');
  assert(ordinaryWorkspaceId && ordinaryWorkspaceId !== 'smoke');

  async function send(message, conversationId) {
    await until(() => chat('!!document.querySelector(".input-editor")'),
      'project switch chat input');
    await chat(`const editor = document.querySelector('.input-editor'); editor.focus(); editor.textContent = ${JSON.stringify(message)};
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: editor.textContent }));`);
    await until(() => chat('!!document.querySelector(".send-button:not([disabled])")'), 'project switch send enabled');
    await chat('document.querySelector(".send-button").click()');
    await until(async () => {
      const run = (await rpc('runs.list')).find(item => item.conversationId === conversationId);
      if (run?.status === 'failed') throw new Error(run.error || 'Project switch model request failed.');
      return run?.status === 'completed';
    }, 'project switch request completed');
  }
  await send('workspace-switch-general-smoke', ordinary.conversationId);
  const navigation = await ui('conversation.navigation', { scope: 'personal' });
  assert(![...navigation.items, ...navigation.pinned].some(item => item.workspaceId === 'smoke'), 'The project must start without a conversation.');
  await until(() => evaluate('Array.from(document.querySelectorAll(".navigation-project-select")).some(node => node.textContent.includes("桌面验证项目"))'),
    'empty project navigation');
  await evaluate('Array.from(document.querySelectorAll(".navigation-project-select")).find(node => node.textContent.includes("桌面验证项目")).click()');
  const focus = await until(async () => {
    const event = await evaluate('window.__projectSwitchFocus');
    return event?.workspaceId === 'smoke' && event.conversationId !== ordinary.conversationId && event;
  }, 'empty project creates and focuses a bound conversation');
  assert.equal(focus.mode, 'code');
  const metadata = await ui('conversation.getConversationMetadata', { conversationId: focus.conversationId });
  assert.equal(metadata.workspaceId, 'smoke');
  await send('workspace-switch-read-smoke', focus.conversationId);
  const readResult = getRequests().flatMap(request => request.messages)
    .find(message => message.role === 'tool' && message.tool_call_id === 'workspace-switch-read');
  assert(readResult && JSON.stringify(readResult.content).includes('Hello GrayCode'), 'read_file must read the selected project fixture.');
  const originalMetadata = await ui('conversation.getConversationMetadata', { conversationId: ordinary.conversationId });
  assert.equal(originalMetadata.workspaceId, ordinaryWorkspaceId, 'The original ordinary conversation must retain its workspace binding.');
  return { ordinaryConversationId: ordinary.conversationId, projectConversationId: focus.conversationId,
    emptyProjectCreatesConversation: true, selectedProjectReadFile: true, ordinaryConversationPreserved: true };
}

async function verifyShellShortcuts({ window, rpc, evaluate, chat, until, projectConversationId }) {
  await evaluate(`window.__shellShortcutSmoke = { newChats: 0, sidebarChanges: 0, views: [], focus: null };
    const sidebar = document.querySelector('.conversation-sidebar');
    window.__shellShortcutObserver = new MutationObserver(records => {
      window.__shellShortcutSmoke.sidebarChanges += records.filter(record => record.attributeName === 'class').length;
    });
    window.__shellShortcutObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    window.__shellShortcutUnsubscribe = window.graycode.subscribe(event => {
      if (event.type === 'ui.message' && event.message?.command === 'newChat') window.__shellShortcutSmoke.newChats++;
      if (event.type === 'ui.conversation.views') window.__shellShortcutSmoke.views = event.views;
      if (event.type === 'ui.conversation.focused') window.__shellShortcutSmoke.focus = event;
    }); undefined`);
  const sidebarExpanded = await evaluate('document.querySelector(".sidebar-toggle").getAttribute("aria-expanded")');
  const keyboard = window.webContents.debugger;
  keyboard.attach('1.3');
  async function press(key, keyCode, shift = false) {
    await chat('document.querySelector(".input-editor").focus()');
    assert(await chat('document.activeElement === document.querySelector(".input-editor")'), 'The chat iframe must own keyboard focus.');
    const event = { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode, modifiers: shift ? 10 : 2 };
    await keyboard.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
    await keyboard.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  try {
    await press('b', 66);
    await until(() => evaluate(`document.querySelector('.sidebar-toggle').getAttribute('aria-expanded') !== ${JSON.stringify(sidebarExpanded)}`),
      'Ctrl+B toggles the sidebar from the chat iframe');
    assert.equal(await evaluate('window.__shellShortcutSmoke.sidebarChanges'), 1, 'Ctrl+B must toggle exactly once.');
    await press('b', 66);
    await until(() => evaluate(`document.querySelector('.sidebar-toggle').getAttribute('aria-expanded') === ${JSON.stringify(sidebarExpanded)}`),
      'Ctrl+B restores the sidebar');
    assert.equal(await evaluate('window.__shellShortcutSmoke.sidebarChanges'), 2);

    await press('n', 78);
    await until(() => evaluate('window.__shellShortcutSmoke.views.some(view => view.active && !view.conversationId)'),
      'Ctrl+N opens a new conversation from the chat iframe');
    assert.equal(await evaluate('window.__shellShortcutSmoke.newChats'), 1, 'Ctrl+N must dispatch one new conversation command.');

    await rpc('ui.command', { command: 'platform.openModeConversation', data: { conversationId: projectConversationId } });
    await until(() => evaluate(`window.__shellShortcutSmoke.focus?.conversationId === ${JSON.stringify(projectConversationId)}`),
      'restore the project conversation for search');
    await evaluate(`if (!document.querySelector('.desktop-workspace').classList.contains('chat-focused'))
      document.querySelector('.titlebar .panel-toggle').click();`);
    await press('f', 70, true);
    await until(() => evaluate('document.querySelector(".search-panel")?.getBoundingClientRect().width > 0'),
      'Ctrl+Shift+F opens project search from the chat iframe');
    return { iframeOwnsFocus: true, sidebarSingleToggleAndRestore: true, newConversationCommandCount: 1, projectSearchVisible: true };
  } finally {
    keyboard.detach();
    await evaluate('window.__shellShortcutObserver.disconnect(); window.__shellShortcutUnsubscribe(); undefined');
  }
}

async function verifyMonacoSearchShortcut({ window, evaluate, until }) {
  await evaluate('document.querySelector(".monaco-editor .inputarea, .monaco-editor .native-edit-context").focus()');
  assert(await evaluate('!!document.activeElement?.closest(".monaco-editor")'), 'Monaco must own keyboard focus.');
  assert(!await evaluate('document.querySelector(".search-panel")?.getBoundingClientRect().width > 0'), 'Project search must start hidden.');
  const keyboard = window.webContents.debugger;
  keyboard.attach('1.3');
  try {
    const key = { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 10 };
    await keyboard.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    await keyboard.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await until(() => evaluate('document.querySelector(".search-panel")?.getBoundingClientRect().width > 0'),
      'Ctrl+Shift+F opens project search from Monaco');
    return true;
  } finally {
    keyboard.detach();
    await evaluate('Array.from(document.querySelectorAll(".workbench-tab [role=tab]")).find(tab => tab.textContent.includes("hello.ts")).click()');
  }
}

async function runCompanionWorkflow({ window, rpc, evaluate, chat, until, output, configId, getRequests }) {
  const resource = (await rpc('pets.list'))[0];
  assert(resource?.actions.length, 'The existing pet smoke must provide an annotated resource.');
  const action = resource.actions[0];
  const previousDescription = '流程烟测旧词表：轻轻挥手。';
  const nextDescription = '流程烟测新词表：开心挥手。';
  await rpc('pets.resource.annotate', { id: resource.id, actions: [{ id: action.id, description: previousDescription }] });
  const created = await rpc('companion.save', { configuration: {
    enabled: true, name: '陪伴流程验证', userName: '主人', tone: '简短自然地交流', petResourceId: resource.id,
  } });
  const conversationId = created.conversationId;
  const pictures = [];
  const closeStates = [];
  const steps = ['character', 'pet', 'screen', 'greeting'];
  await evaluate(`window.__workflowConversationId = '';
    window.graycode.subscribe(event => {
      if (event.type === 'ui.conversation.focused') window.__workflowConversationId = event.conversationId;
    }); undefined`);
  async function openConversation(id) {
    await rpc('ui.command', { command: 'platform.openModeConversation', data: { conversationId: id } });
    await until(() => evaluate(`window.__workflowConversationId === ${JSON.stringify(id)}`), 'workflow conversation focused');
    await until(() => chat('!!document.querySelector(".input-editor")'), 'workflow conversation input');
  }
  async function openSetup() {
    await until(() => evaluate('Array.from(document.querySelectorAll(".titlebar button")).some(node => node.textContent.trim() === "陪伴配置")'),
      'companion entry');
    await evaluate('Array.from(document.querySelectorAll(".titlebar button")).find(node => node.textContent.trim() === "陪伴配置").click()');
    await until(() => evaluate('document.querySelectorAll(".companion-step").length === 4'), 'four companion steps');
  }
  async function openStep(step) {
    await evaluate(`for (const section of document.querySelectorAll('.companion-step')) {
      const details = section.querySelector('details');
      if (details) details.open = section.dataset.step === ${JSON.stringify(step)};
    }
    document.querySelector('.companion-step[data-step="${step}"]').scrollIntoView({ block: 'start' });`);
  }
  async function closeSetup() {
    const closeState = () => evaluate(`(() => {
      const panel = document.querySelector('.companion-setup');
      return { open: !!panel, unsaved: panel?.dataset.unsaved === 'true',
        busy: panel?.querySelector('header button')?.disabled === true,
        leaveConfirmation: !!document.querySelector('.companion-leave') };
    })()`);
    const before = await closeState();
    let ready = before;
    // 后端提交与界面回执各有完成时点，必须等所有分段都已保存且按钮可用。
    await until(async () => {
      ready = await closeState();
      assert(!ready.leaveConfirmation, 'Companion unexpectedly requested confirmation before closing.');
      return ready.open && !ready.unsaved && !ready.busy;
    }, 'companion saved and close ready');
    await evaluate('document.querySelector(".companion-setup > header button").click()');
    await until(async () => {
      const current = await closeState();
      assert(!current.leaveConfirmation, `Companion opened an unsaved-changes confirmation: ${JSON.stringify(current)}`);
      return !current.open;
    }, 'companion closed');
    closeStates.push({ before, ready, leaveConfirmation: false });
  }
  async function sendVocabularyMessage(label) {
    const before = getRequests().length;
    const sent = await rpc('pets.chat.send', { conversationId, configId,
      message: `workflow-vocabulary-smoke ${label}`, streamId: `workflow-vocabulary-${label}` });
    await until(async () => {
      const run = (await rpc('runs.list')).find(item => item.id === sent.runId);
      if (run?.status === 'failed') throw new Error(run.error || 'Vocabulary model request failed.');
      return run?.status === 'completed';
    }, 'vocabulary model request: ' + label);
    assert.equal(getRequests().length, before + 1, 'Vocabulary verification requires one local model response.');
    return getRequests().at(-1);
  }
  function companionPrefix(request) {
    const text = request.messages.filter(message => message.role === 'system' || message.role === 'developer')
      .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    const prefix = text.match(/<companion_configuration>[\s\S]*?<\/companion_configuration>/)?.[0];
    assert(prefix, 'The real request must include the saved companion configuration.');
    return prefix;
  }

  try {
    await openConversation(conversationId);
    await openSetup();
    const initialStatuses = await evaluate(`Array.from(document.querySelectorAll('.companion-step')).map(node => ({
      step: node.dataset.step, status: node.querySelector('.companion-step-status')?.textContent.trim(),
    }))`);
    assert.deepEqual(initialStatuses.map(item => item.step), steps);
    assert(initialStatuses.every(item => item.status), 'Every companion step must expose its current state.');
    for (const step of steps) {
      await openStep(step);
      if (step === 'pet') await until(() => evaluate(
        'document.querySelector(".companion-step[data-step=pet] .pet-player")?.dataset.ready === "true"'), 'embedded pet preview');
      if (step === 'screen') {
        await until(() => evaluate('!!document.querySelector("input[data-testid=screen-auto-start]") && !document.querySelector(".screen-sense-settings fieldset").disabled'),
          'automatic screen capture preference');
        assert.equal(await evaluate('document.querySelector("input[data-testid=screen-auto-start]").checked'), false);
        assert(await evaluate('!!document.querySelector(".sense-bound-conversation")'));
      }
      if (step === 'greeting') await until(() => evaluate(
        '!!document.querySelector(".companion-step[data-step=greeting] .automation-form")'), 'embedded greeting configuration');
      pictures.push(await screenshot(window, output, `companion-step-${step}.png`));
    }
    await evaluate('for (const details of document.querySelectorAll(".companion-step details")) details.open = false; document.querySelector(".companion-step").scrollIntoView({ block: "start" });');
    pictures.push(await screenshot(window, output, 'companion-status.png'));
    await closeSetup();

    const before = await sendVocabularyMessage('before');
    const previousPrefix = companionPrefix(before);
    assert(previousPrefix.includes(previousDescription));
    await rpc('pets.resource.annotate', { id: resource.id, actions: [{ id: action.id, description: nextDescription }] });
    const view = await rpc('companion.get', { conversationId });
    assert.equal(view.petVocabulary.updated, true);
    // 普通保存仍走正式配置写入，不能悄悄替换已经绑定的动作说明。
    await openSetup();
    await evaluate('document.querySelector(".companion-step[data-step=pet] .companion-profile-save button.primary").click()');
    await until(async () => (await rpc('companion.get', { conversationId })).metadataToken !== view.metadataToken,
      'save current companion through UI');
    assert(await evaluate('!!document.querySelector(".companion-setup")'), 'Saving must retain the companion workflow.');
    await closeSetup();
    const unsynced = await sendVocabularyMessage('unsynced');
    assert.equal(companionPrefix(unsynced), previousPrefix);
    assert.deepEqual(unsynced.tools, before.tools, 'Resource annotations must not change the tool catalog.');
    const retained = (await rpc('conversations.history', { id: conversationId })).messages.map(message => message.id);
    await openSetup();
    await openStep('pet');
    await until(() => evaluate('document.querySelector(".companion-vocabulary")?.textContent.includes("桌宠动作词表已更新")'),
      'explicit vocabulary update notice');
    assert(await evaluate('document.querySelector(".companion-vocabulary").textContent.includes("提示词缓存会重建一次")'));
    await evaluate('document.querySelector(".companion-vocabulary").scrollIntoView({ block: "center" })');
    pictures.push(await screenshot(window, output, 'companion-vocabulary-update.png'));
    await evaluate('Array.from(document.querySelectorAll(".companion-vocabulary button")).find(node => node.textContent.trim() === "同步动作词表").click()');
    await until(async () => !(await rpc('companion.get', { conversationId })).petVocabulary.updated, 'explicit vocabulary sync');
    await closeSetup();
    assert.deepEqual((await rpc('conversations.history', { id: conversationId })).messages.map(message => message.id), retained,
      'Vocabulary sync must keep the existing message history.');
    const synced = await sendVocabularyMessage('synced');
    const synchronizedPrefix = companionPrefix(synced);
    assert(synchronizedPrefix.includes(nextDescription));
    assert(!synchronizedPrefix.includes(previousDescription));
    assert.deepEqual(synced.tools, before.tools, 'Vocabulary sync must keep the tool catalog.');

    const options = await rpc('screenSense.options');
    const display = options.targets.displays[0];
    assert(display, 'The native screen directory must include a display.');
    const configuration = {
      conversationId, target: { kind: 'display', display }, trigger: 'interval', intervalSeconds: 3600,
      delivery: 'preview', maxCaptures: 1, visionProviderId: configId, visionModelId: 'smoke-model',
      prompt: '只用于验证开启和停止，不执行画面采集。', autoStartOnOpen: false,
    };
    let screen = await rpc('screenSense.get');
    await rpc('screenSense.configure', { configuration, revision: screen.revision });
    const other = await rpc('pets.chat.create');
    await openConversation(other.id);
    await openConversation(conversationId);
    assert.equal((await rpc('screenSense.status')).active, false, 'Opening a conversation must respect the default disabled preference.');
    await openSetup();
    await openStep('screen');
    await until(() => evaluate('!!document.querySelector("input[data-testid=screen-auto-start]") && !document.querySelector(".screen-sense-settings fieldset").disabled'),
      'screen settings ready');
    await evaluate('document.querySelector("input[data-testid=screen-auto-start]").click()');
    await evaluate('document.querySelector(".screen-sense-settings form button.primary").click()');
    await until(async () => (await rpc('screenSense.get')).configuration?.autoStartOnOpen === true, 'explicit automatic start preference saved');
    await until(() => evaluate('!document.querySelector(".screen-sense-settings fieldset").disabled'), 'screen preferences save completed');
    await closeSetup();
    const requestCount = getRequests().length;
    await openConversation(other.id);
    await openConversation(conversationId);
    screen = await until(async () => { const value = await rpc('screenSense.status'); return value.active && value; }, 'automatic start after conversation ready');
    assert.equal(screen.captures, 0);
    assert(screen.nextCaptureAt > Date.now(), 'Automatic interval must wait before the first capture.');
    await openSetup();
    await openStep('screen');
    await until(() => evaluate('Array.from(document.querySelectorAll(".sense-current button")).some(node => node.textContent.trim() === "立即停止采集")'),
      'immediate screen stop action');
    pictures.push(await screenshot(window, output, 'companion-screen-active.png'));
    await evaluate('Array.from(document.querySelectorAll(".sense-current button")).find(node => node.textContent.trim() === "立即停止采集").click()');
    await until(async () => !(await rpc('screenSense.status')).active, 'screen capture stopped from UI');
    screen = await rpc('screenSense.status');
    assert.equal(screen.captures, 0);
    assert.equal(screen.nextCaptureAt, undefined);
    assert.equal(getRequests().length, requestCount);
    await until(() => evaluate('!Array.from(document.querySelectorAll(".sense-current button")).some(node => node.textContent.trim() === "立即停止采集")'),
      'stopped screen state rendered');
    pictures.push(await screenshot(window, output, 'companion-screen-stopped.png'));
    await closeSetup();
    return { conversationId, initialStatuses, screenshots: pictures, closeStates, modelRequests: 3,
      vocabularyPreservedUntilExplicitSync: true, messageHistoryRetained: true, toolCatalogRetained: true, companionSaveStaysOpen: true,
      automaticScreenStartDefault: false, automaticScreenStartAndStop: true, screenCaptures: 0 };
  } finally {
    await rpc('screenSense.stop').catch(() => {});
    const current = await rpc('screenSense.get').catch(() => undefined);
    if (current?.configuration?.conversationId === conversationId) {
      await rpc('screenSense.configure', { configuration: { ...current.configuration, autoStartOnOpen: false }, revision: current.revision });
    }
    await rpc('pets.resource.annotate', { id: resource.id, actions: [{ id: action.id, description: action.description || '' }] });
  }
}

async function verifyInputToolbar({ window, chat, until, output }) {
  // 工具栏直接显示存档点、总结、提示词预览和保留发送，不再有“更多操作”菜单。
  await until(() => chat('!!document.querySelector(".checkpoint-button") && !!document.querySelector(".summarize-button")'
    + ' && !!document.querySelector(".prompt-preview-button") && !!document.querySelector(".preserve-send-button")'), 'direct input actions');
  assert(await chat('!!document.querySelector(".attach-button") && !!document.querySelector(".send-button")'));
  assert(await chat('!!document.querySelector(".pinned-files-button span") && !!document.querySelector(".skills-button span")'));
  const icons = await chat(`Array.from(document.querySelectorAll('.bottom-toolbar button')).filter(node =>
    node.getBoundingClientRect().width > 0 && !node.textContent.trim()).map(node => ({
      title: node.title, label: node.getAttribute('aria-label'),
    }))`);
  assert(icons.length > 0 && icons.every(icon => icon.title && icon.label), 'Visible toolbar icons need tooltips and accessible names.');
  const actions = await chat(`['.checkpoint-button', '.summarize-button', '.prompt-preview-button', '.preserve-send-button'].map(selector => {
    const node = document.querySelector(selector);
    return node ? (node.getAttribute('aria-label') || '') : null;
  })`);
  assert(actions.every(Boolean), 'All four direct input actions must expose accessible names.');
  assert(actions[0].includes('存档点'), 'Checkpoint action must stay labelled.');
  assert(actions[1].includes('总结'), 'Summarize action must stay labelled.');
  assert(actions[2].includes('提示词'), 'Prompt preview action must stay labelled.');
  assert(actions[3].includes('保留'), 'Preserve-dynamic-context action must stay labelled.');
  const placement = await chat(`(() => {
    const checkpoint = document.querySelector('.checkpoint-button');
    const preview = document.querySelector('.prompt-preview-button');
    const summarize = document.querySelector('.summarize-button');
    const preserve = document.querySelector('.preserve-send-button');
    const send = document.querySelector('.send-button:not(.preserve-send-button)');
    return {
      checkpointInConversationGroup: !!checkpoint?.closest('.toolbar-left .toolbar-group + .toolbar-group'),
      previewInSendActions: !!preview?.closest('.toolbar-right'),
      summarizeInSendActions: !!summarize?.closest('.toolbar-right'),
      sendButtonsAdjacent: !!send && !!preserve && send.previousElementSibling === preserve,
    };
  })()`);
  assert(placement.checkpointInConversationGroup, 'Checkpoint belongs to the left conversation action group.');
  assert(placement.previewInSendActions && placement.summarizeInSendActions, 'Preview and summarize belong to the right send action group.');
  assert(placement.sendButtonsAdjacent, 'Preserve send must sit directly before send.');
  const actionStates = await chat(`['.checkpoint-button', '.prompt-preview-button', '.summarize-button'].map(selector => {
    const node = document.querySelector(selector);
    return { selector, disabled: !!node.disabled };
  })`);
  const enabledActions = actionStates.filter(item => !item.disabled);
  // 与旧菜单的“至少两个可用项”一致：会话状态不同，部分操作会按规则禁用。
  assert(enabledActions.length >= 2, `At least two direct actions must be enabled: ${JSON.stringify(actionStates)}`);
  const pictures = [await screenshot(window, output, 'input-toolbar.png')];
  // 使用 Chromium 的真实按键路径，让 Tab 的原生焦点移动也参与验收。
  const keyboard = window.webContents.debugger;
  keyboard.attach('1.3');
  async function press(key, keyCode, modifiers) {
    const event = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(modifiers ? { modifiers } : {}) };
    await keyboard.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
    await keyboard.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  }
  const describeFocus = () => chat(`(() => {
    const node = document.activeElement;
    if (!node) return 'outside';
    const selectors = ['.checkpoint-button', '.prompt-preview-button', '.summarize-button', '.context-detail-button',
      '.token-ring-wrapper', '.preserve-send-button', '.send-button:not(.preserve-send-button)'];
    return selectors.find(selector => node.matches(selector)) || (node.closest('.bottom-toolbar') ? 'toolbar-control' : 'outside');
  })()`);
  try {
    await chat('document.querySelector(".attach-button").focus()');
    assert.equal(await describeFocus(), 'toolbar-control', 'Attachment action must be focusable.');
    const visited = [];
    for (let step = 0; step < 12; step++) {
      await press('Tab', 9);
      const target = await describeFocus();
      if (target === 'outside') break;
      visited.push(target);
    }
    for (const item of enabledActions)
      assert(visited.includes(item.selector), `Tab must reach enabled action ${item.selector}.`);
    assert(visited.includes('.context-detail-button'), 'Tab must reach context detail.');
    assert(visited.includes('.token-ring-wrapper'), 'Tab must reach token usage.');
    // 反向导航仍可用：从用量环回到相邻的上下文详情。
    await chat('document.querySelector(".token-ring-wrapper").focus()');
    await press('Tab', 9, 8);
    assert.equal(await describeFocus(), '.context-detail-button', 'Shift+Tab must return to context detail.');
  } finally {
    keyboard.detach();
  }
  pictures.push(await screenshot(window, output, 'input-toolbar-keyboard.png'));
  return { actions, icons, screenshots: pictures, directActions: true, keyboardNavigation: true, sendActionsGrouped: true };
}

module.exports = { runProjectSwitchWorkflow, verifyShellShortcuts, verifyMonacoSearchShortcut, runCompanionWorkflow, verifyInputToolbar, screenshot };
