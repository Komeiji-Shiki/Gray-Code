import assert from 'node:assert/strict';

// IMPORTANT:
// 该测试脚本依赖 dist 产物，所以请用：npm run test（会先 build 再执行）。
import {
  History,
  Variables,
  createVariableContext,
  buildPrompt,
  buildPromptFromSillyTavern,
  convertMessagesIn,
  convertMessagesOut,
  convertPresetFromSillyTavern,
  convertWorldBookFromSillyTavern,
  convertRegexFromSillyTavern,
  convertCharacterFromSillyTavern,
  convertHistoryFromSillyTavern,
  normalizeRegexes,
  normalizeWorldbooks
} from '../dist/index.js';

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => {
          console.log(`✓ ${name}`);
        },
        (err) => {
          console.error(`✗ ${name}`);
          console.error(err);
          process.exitCode = 1;
        }
      );
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function makePreset() {
  return {
    name: 'Preset Test',
    utilityPrompts: {},
    other: {},
    regexScripts: [],
    prompts: [
      {
        identifier: 'charBefore',
        name: 'Char Before',
        enabled: true,
        role: 'system',
        content: 'SYSTEM: before char',
        position: 'relative',
        depth: 0,
        order: 0,
        trigger: []
      },
      {
        identifier: 'main',
        name: 'Main',
        enabled: true,
        role: 'system',
        // 用于验证 stages：raw -> macro -> regex
        content: 'Hello {{user}} <X>',
        position: 'relative',
        depth: 0,
        order: 0,
        trigger: []
      },
      {
        identifier: 'chatHistory',
        name: 'Chat History',
        enabled: true,
        role: 'system',
        content: '',
        position: 'relative',
        depth: 0,
        order: 0,
        trigger: []
      },
      {
        identifier: 'charAfter',
        name: 'Char After',
        enabled: true,
        role: 'system',
        content: 'SYSTEM: after char',
        position: 'relative',
        depth: 0,
        order: 0,
        trigger: []
      },

      // 注入测试：插入到 chatHistory 中，depth=1 => 插入到倒数第 1 条之前
      {
        identifier: 'inject1',
        name: 'Inject',
        enabled: true,
        role: 'system',
        position: 'fixed',
        depth: 1,
        order: 0,
        trigger: [],
        content: 'INJECTED'
      }
    ]
  };
}

function makeWorldbooksMultiFile() {
  const wbFile1 = {
    name: 'wb-1',
    entries: [
      {
        index: 1,
        name: 'WB Before',
        content: 'WB_BEFORE',
        enabled: true,
        activationMode: 'always',
        key: [],
        secondaryKey: [],
        selectiveLogic: 'andAny',
        order: 0,
        depth: 0,
        position: 'beforeChar',
        role: null,
        caseSensitive: false,
        excludeRecursion: false,
        preventRecursion: false,
        probability: 100,
        other: {}
      }
    ]
  };

  const wbEntries2 = [
    {
      index: 2,
      name: 'WB Keyword',
      content: 'WB_COND',
      enabled: true,
      activationMode: 'keyword',
      key: ['trigger'],
      secondaryKey: [],
      selectiveLogic: 'andAny',
      order: 1,
      depth: 0,
      position: 'beforeChar',
      role: null,
      caseSensitive: false,
      excludeRecursion: false,
      preventRecursion: false,
      probability: 100,
      other: {}
    }
  ];

  return [wbFile1, wbEntries2];
}

function makeRegexesMultiFile() {
  const file1 = {
    regexScripts: [
      {
        id: 'user-only',
        name: 'user-only',
        enabled: true,
        findRegex: 'Bob',
        replaceRegex: 'USER_VIEW_REPLACED',
        trimRegex: [],
        targets: ['slashCommands'],
        view: ['user'],
        runOnEdit: false,
        macroMode: 'none',
        minDepth: null,
        maxDepth: null
      }
    ]
  };

  const file2 = [
    {
      id: 'x-to-y',
      name: 'x-to-y',
      enabled: true,
      findRegex: '<X>',
      replaceRegex: '<Y>',
      trimRegex: [],
      targets: ['slashCommands'],
      view: ['model'],
      runOnEdit: false,
      macroMode: 'none',
      minDepth: null,
      maxDepth: null
    },
    {
      id: 'y-to-z',
      name: 'y-to-z',
      enabled: true,
      findRegex: '<Y>',
      replaceRegex: 'Z',
      trimRegex: [],
      targets: ['slashCommands'],
      view: ['model'],
      runOnEdit: false,
      macroMode: 'none',
      minDepth: null,
      maxDepth: null
    },
    {
      id: 'inject-fix',
      name: 'inject-fix',
      enabled: true,
      findRegex: 'INJECTED',
      replaceRegex: 'INJECTED_OK',
      trimRegex: [],
      targets: ['slashCommands', 'userInput', 'aiOutput'],
      view: ['model', 'user'],
      runOnEdit: false,
      macroMode: 'none',
      minDepth: null,
      maxDepth: null
    }
  ];

  return [file1, file2];
}

function makeWorldbooksForOrderTest() {
  return [
    {
      name: 'wb-order',
      entries: [
        {
          index: 11,
          name: 'WB Order 2',
          content: 'WB_ORDER_2',
          enabled: true,
          activationMode: 'always',
          key: [],
          secondaryKey: [],
          selectiveLogic: 'andAny',
          order: 2,
          depth: 0,
          position: 'beforeChar',
          role: null,
          caseSensitive: false,
          excludeRecursion: false,
          preventRecursion: false,
          probability: 100,
          other: {}
        },
        {
          index: 10,
          name: 'WB Order 1',
          content: 'WB_ORDER_1',
          enabled: true,
          activationMode: 'always',
          key: [],
          secondaryKey: [],
          selectiveLogic: 'andAny',
          order: 1,
          depth: 0,
          position: 'beforeChar',
          role: null,
          caseSensitive: false,
          excludeRecursion: false,
          preventRecursion: false,
          probability: 100,
          other: {}
        }
      ]
    }
  ];
}

function makePresetForDepthOrderTest() {
  return {
    name: 'Preset Depth/Order Test',
    utilityPrompts: {},
    other: {},
    regexScripts: [],
    prompts: [
      {
        identifier: 'chatHistory',
        name: 'Chat History',
        enabled: true,
        role: 'system',
        content: '',
        position: 'relative',
        depth: 0,
        order: 0,
        trigger: []
      },

      // preset 注入：depth/order 不同
      {
        identifier: 'p_d1_o10',
        name: 'P D1 O10',
        enabled: true,
        role: 'system',
        position: 'fixed',
        depth: 1,
        order: 10,
        trigger: [],
        content: 'P_D1_O10'
      },
      {
        identifier: 'p_missing_order',
        name: 'P missing order',
        enabled: true,
        role: 'system',
        position: 'fixed',
        depth: 1,
        trigger: [],
        content: 'P_MISSING_ORDER_SHOULD_NOT_APPEAR'
      },
      {
        identifier: 'p_d1_o5',
        name: 'P D1 O5',
        enabled: true,
        role: 'system',
        position: 'fixed',
        depth: 1,
        order: 5,
        trigger: [],
        content: 'P_D1_O5'
      },
      {
        identifier: 'p_d2_o0',
        name: 'P D2 O0',
        enabled: true,
        role: 'system',
        position: 'fixed',
        depth: 2,
        order: 0,
        trigger: [],
        content: 'P_D2_O0'
      }
    ]
  };
}

function makeWorldbooksForDepthOrderInjections() {
  return [
    {
      name: 'wb-inject',
      entries: [
        {
          index: 21,
          name: 'W D1 O0',
          content: 'W_D1_O0',
          enabled: true,
          activationMode: 'always',
          key: [],
          secondaryKey: [],
          selectiveLogic: 'andAny',
          order: 0,
          depth: 1,
          position: 'fixed',
          role: 'system',
          caseSensitive: false,
          excludeRecursion: false,
          preventRecursion: false,
          probability: 100,
          other: {}
        },
        {
          index: 22,
          name: 'W D2 O1',
          content: 'W_D2_O1',
          enabled: true,
          activationMode: 'always',
          key: [],
          secondaryKey: [],
          selectiveLogic: 'andAny',
          order: 1,
          depth: 2,
          position: 'fixed',
          role: 'system',
          caseSensitive: false,
          excludeRecursion: false,
          preventRecursion: false,
          probability: 100,
          other: {}
        },
        {
          index: 23,
          name: 'W D2 O2',
          content: 'W_D2_O2',
          enabled: true,
          activationMode: 'always',
          key: [],
          secondaryKey: [],
          selectiveLogic: 'andAny',
          order: 2,
          depth: 2,
          position: 'fixed',
          role: 'system',
          caseSensitive: false,
          excludeRecursion: false,
          preventRecursion: false,
          probability: 100,
          other: {}
        },
        {
          index: 24,
          name: 'W fixed no depth',
          content: 'W_FIXED_NO_DEPTH_SHOULD_NOT_APPEAR',
          enabled: true,
          activationMode: 'always',
          key: [],
          secondaryKey: [],
          selectiveLogic: 'andAny',
          order: 999,
          // depth 缺失：应被 assemble 忽略（不过 normalizeWorldbooks 会默认 depth=0，这里用 NaN 来模拟非法）
          depth: NaN,
          position: 'fixed',
          role: 'system',
          caseSensitive: false,
          excludeRecursion: false,
          preventRecursion: false,
          probability: 100,
          other: {}
        },
        {
          index: 25,
          name: 'W fixed no order',
          content: 'W_FIXED_NO_ORDER_SHOULD_NOT_APPEAR',
          enabled: true,
          activationMode: 'always',
          key: [],
          secondaryKey: [],
          selectiveLogic: 'andAny',
          // order 缺失：同理用 NaN 模拟非法
          order: NaN,
          depth: 1,
          position: 'fixed',
          role: 'system',
          caseSensitive: false,
          excludeRecursion: false,
          preventRecursion: false,
          probability: 100,
          other: {}
        },
        {
          index: 26,
          name: 'W beforeChar with depth',
          content: 'W_BEFORE_CHAR_WITH_DEPTH',
          enabled: true,
          activationMode: 'always',
          key: [],
          secondaryKey: [],
          selectiveLogic: 'andAny',
          order: 0,
          depth: 2,
          position: 'beforeChar',
          role: null,
          caseSensitive: false,
          excludeRecursion: false,
          preventRecursion: false,
          probability: 100,
          other: {}
        }
      ]
    }
  ];
}

function simulateDepthInsert(baseTexts, injections) {
  // 复刻 assembleTaggedPromptList 的注入算法：
  // injections 需已按 depth/order 排序
  const list = [...baseTexts];
  for (const inj of injections) {
    const idx = Math.max(0, list.length - inj.depth);
    list.splice(idx, 0, inj.text);
  }
  return list;
}

function findTaggedByTag(stageTagged, contains) {
  const item = stageTagged.find((x) => String(x.tag).includes(contains));
  assert.ok(item, `Expected tagged item whose tag includes: ${contains}`);
  return item;
}

function assertHasStages(obj, label) {
  for (const key of ['raw', 'afterPreRegex', 'afterMacro', 'afterPostRegex']) {
    assert.ok(key in obj, `${label} should have stage: ${key}`);
  }
}

await test('normalizeWorldbooks: 单文件 entries 数组', () => {
  const wbEntries = makeWorldbooksMultiFile()[0].entries;
  const out = normalizeWorldbooks(wbEntries);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'WB Before');
});

await test('normalizeWorldbooks: 多文件（worldbook.json + entries[]）', () => {
  const out = normalizeWorldbooks(makeWorldbooksMultiFile());
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((e) => e.name),
    ['WB Before', 'WB Keyword']
  );
});

await test('normalizeRegexes: 多文件（{regexScripts} + RegexScriptData[]）', () => {
  const out = normalizeRegexes(makeRegexesMultiFile());
  assert.equal(out.length, 4);
  assert.deepEqual(
    out.map((r) => r.id),
    ['user-only', 'x-to-y', 'y-to-z', 'inject-fix']
  );
});

await test('convertRegexFromSillyTavern: 旧字段映射到 RegexScriptData', () => {
  const out = convertRegexFromSillyTavern({
    id: 'r-old',
    scriptName: 'legacy-regex',
    disabled: false,
    findRegex: 'hello',
    replaceString: 'HELLO',
    trimStrings: ['xx'],
    placement: [2],
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 2,
    minDepth: 1,
    maxDepth: 9
  });

  assert.equal(out.id, 'r-old');
  assert.equal(out.name, 'legacy-regex');
  assert.equal(out.enabled, true);
  assert.equal(out.replaceRegex, 'HELLO');
  assert.deepEqual(out.trimRegex, ['xx']);
  assert.deepEqual(out.targets, ['aiOutput']);
  assert.deepEqual(out.view, ['user']);
  assert.equal(out.macroMode, 'escaped');
  assert.equal(out.minDepth, 1);
  assert.equal(out.maxDepth, 9);
});

await test('convertWorldBookFromSillyTavern: world_info.entries 旧字段映射', () => {
  const out = convertWorldBookFromSillyTavern({
    name: 'LegacyWB',
    entries: {
      1: {
        uid: 1,
        comment: 'Legacy Entry',
        content: 'Legacy Content',
        disable: true,
        constant: false,
        vectorized: true,
        key: ['k1'],
        keysecondary: ['k2'],
        selectiveLogic: 3,
        order: 7,
        depth: 4,
        position: 4,
        role: 2,
        caseSensitive: null,
        excludeRecursion: true,
        preventRecursion: false,
        probability: 88,
        custom: 'x'
      }
    }
  });

  assert.equal(out.name, 'LegacyWB');
  assert.equal(out.entries.length, 1);

  const e = out.entries[0];
  assert.equal(e.name, 'Legacy Entry');
  assert.equal(e.enabled, false);
  assert.equal(e.activationMode, 'vector');
  assert.deepEqual(e.key, ['k1']);
  assert.deepEqual(e.secondaryKey, ['k2']);
  assert.equal(e.selectiveLogic, 'andAll');
  assert.equal(e.position, 'fixed');
  assert.equal(e.role, 'model');
  assert.equal(e.probability, 88);
  assert.equal(e.other.custom, 'x');
});

await test('convertPresetFromSillyTavern: 旧 preset 映射到新格式（other/utilityPrompts）', () => {
  const out = convertPresetFromSillyTavern({
    name: 'Legacy Preset',
    temp: 1.2,
    new_chat_prompt: '[Start a new Chat]',
    prompts: [
      {
        identifier: 'main',
        name: 'Main',
        enabled: true,
        role: 'system',
        content: 'Hello',
        injection_depth: 2,
        injection_order: 5,
        injection_trigger: ['x'],
        injection_position: 1
      }
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [{ identifier: 'main', enabled: false }]
      }
    ],
    extensions: {
      regex_scripts: [
        {
          id: 'preset-r-1',
          scriptName: 'preset-regex',
          disabled: false,
          findRegex: 'A',
          replaceString: 'B',
          trimStrings: [],
          placement: [3],
          markdownOnly: false,
          promptOnly: true,
          runOnEdit: false,
          substituteRegex: 1,
          minDepth: null,
          maxDepth: null
        }
      ]
    }
  });

  assert.equal(out.name, 'Legacy Preset');
  assert.equal(out.prompts.length, 1);
  assert.equal(out.prompts[0].enabled, false); // 来自 prompt_order 覆盖
  assert.equal(out.prompts[0].index, 0);
  assert.equal(out.prompts[0].depth, 2);
  assert.equal(out.prompts[0].order, 5);
  assert.deepEqual(out.prompts[0].trigger, ['x']);
  assert.equal(out.prompts[0].position, 'fixed');

  assert.equal(out.utilityPrompts.newChatPrompt, '[Start a new Chat]');
  assert.equal(Object.prototype.hasOwnProperty.call(out.other, 'new_chat_prompt'), false);
  assert.equal(out.other.temp, 1.2);

  assert.equal(out.regexScripts.length, 1);
  assert.equal(out.regexScripts[0].name, 'preset-regex');
  assert.deepEqual(out.regexScripts[0].targets, ['slashCommands']);
  assert.deepEqual(out.regexScripts[0].view, ['model']);
  assert.equal(out.regexScripts[0].macroMode, 'raw');
});

await test('convertCharacterFromSillyTavern + convertHistoryFromSillyTavern: 旧结构映射', () => {
  const character = convertCharacterFromSillyTavern({
    avatar: 'Alice.png',
    chat: 'chat-1',
    create_date: '2025-01-01T00:00:00.000Z',
    data: {
      name: 'Alice',
      description: 'desc',
      first_mes: 'Hi',
      alternate_greetings: ['Yo'],
      character_book: {
        name: 'AliceBook',
        entries: [
          {
            id: 10,
            comment: 'KB',
            content: 'knowledge',
            enabled: true,
            keys: ['alice'],
            secondary_keys: [],
            insertion_order: 2,
            extensions: { position: 0 }
          }
        ]
      },
      extensions: {
        regex_scripts: [
          {
            id: 'char-r-1',
            scriptName: 'char-regex',
            disabled: false,
            findRegex: 'x',
            replaceString: 'y',
            placement: [3],
            promptOnly: true
          }
        ]
      }
    }
  });

  assert.equal(character.name, 'Alice');
  assert.deepEqual(character.message, ['Hi', 'Yo']);
  assert.equal(character.worldBook?.name, 'AliceBook');
  assert.equal(character.worldBook?.entries.length, 1);
  assert.equal(character.regexScripts.length, 1);
  assert.equal(character.chatDate, 'chat-1');

  const history = convertHistoryFromSillyTavern([
    { is_system: true, mes: 'SYS' },
    { is_user: true, mes: 'U1', swipe_id: 1, swipes: ['U1-A', 'U1-B'] },
    { role: 'assistant', content: 'A1' }
  ]);

  assert.deepEqual(history.map((x) => x.role), ['system', 'user', 'model']);
  assert.equal(history[1].content, 'U1');
  assert.equal(history[1].swipeId, 1);
  assert.deepEqual(history[1].swipes, ['U1-A', 'U1-B']);
});

await test('convertMessagesIn/Out: OpenAI(content) -> internal(parts) -> OpenAI(content)', () => {
  const openai = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'U' },
    { role: 'assistant', content: 'A' }
  ];

  const conv = convertMessagesIn(openai, 'openai');
  assert.deepEqual(
    conv.internal.map((m) => m.role),
    ['system', 'user', 'model']
  );

  const back = convertMessagesOut(conv.internal, 'openai');
  assert.ok(Array.isArray(back));
  assert.deepEqual(
    back.map((m) => m.role),
    ['system', 'user', 'assistant']
  );
});

await test('buildPromptFromSillyTavern: 旧格式转换后执行（内部转换 + buildPrompt）', () => {
  const result = buildPromptFromSillyTavern({
    preset: {
      name: 'Legacy Wrapper Preset',
      prompts: [
        {
          identifier: 'main',
          name: 'Main',
          enabled: true,
          role: 'system',
          content: 'Hello {{user}} <X>',
          injection_depth: 0,
          injection_order: 0,
          injection_trigger: [],
          injection_position: 0
        },
        {
          identifier: 'chatHistory',
          name: 'Chat History',
          enabled: true,
          role: 'system',
          content: '',
          injection_depth: 0,
          injection_order: 0,
          injection_trigger: [],
          injection_position: 0
        }
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'chatHistory', enabled: true }
          ]
        }
      ],
      extensions: {
        regex_scripts: [
          {
            id: 'legacy-rx',
            scriptName: 'legacy-rx',
            disabled: false,
            findRegex: '<X>',
            replaceString: 'Z',
            trimStrings: [],
            placement: [3],
            markdownOnly: false,
            promptOnly: true,
            runOnEdit: false,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null
          }
        ]
      }
    },
    globals: {
      worldBooks: [
        {
          name: 'LegacyWB',
          entries: {
            1: {
              uid: 1,
              comment: 'Legacy Fixed',
              content: 'WBX',
              constant: true,
              position: 4,
              role: 0
            }
          }
        }
      ]
    },
    history: [{ is_user: true, mes: 'Hi' }],
    view: 'model',
    macros: { user: 'Bob' },
    outputFormat: 'tagged'
  });

  const main = findTaggedByTag(result.stages.tagged.afterPostRegex, 'Preset: Main');
  assert.equal(main.text, 'Hello Bob Z');
  const wb = findTaggedByTag(result.stages.tagged.afterPostRegex, 'Worldbook: Legacy Fixed');
  assert.equal(wb.text, 'WBX');
});

await test('buildPrompt: 4 个阶段视图命名清晰 & 内容按管道变化', () => {
  const preset = makePreset();

  const result = buildPrompt({
    preset,
    globals: {
      worldBooks: makeWorldbooksMultiFile(),
      regexScripts: makeRegexesMultiFile()
    },
    history: History.openai([
      { role: 'system', content: 'System history message' },
      { role: 'user', content: 'trigger: hello' },
      { role: 'assistant', content: 'OK' }
    ]),
    view: 'model',
    macros: { user: 'Bob', char: 'Alice' },
    outputFormat: 'openai',
    systemRolePolicy: 'keep'
  });

  // stages 存在且命名正确
  assertHasStages(result.stages.tagged, 'stages.tagged');
  assertHasStages(result.stages.internal, 'stages.internal');
  assertHasStages(result.stages.output, 'stages.output');

  // 世界书 keyword 生效：raw 里应出现 WB_COND
  const rawTextAll = result.stages.tagged.raw.map((x) => x.text).join('\n');
  assert.ok(rawTextAll.includes('WB_COND'), 'Expected WB_COND included in raw stage');

  // 检查 main prompt 的阶段变化：
  // - afterPreRegex == raw（新语义下保留但不做事）
  // - afterMacro：完成 {{user}}
  // - afterPostRegex：执行 RegexScriptData（<X>-><Y>->Z）
  const rawMain = findTaggedByTag(result.stages.tagged.raw, 'Preset: Main');
  const preMain = findTaggedByTag(result.stages.tagged.afterPreRegex, 'Preset: Main');
  const macroMain = findTaggedByTag(result.stages.tagged.afterMacro, 'Preset: Main');
  const postMain = findTaggedByTag(result.stages.tagged.afterPostRegex, 'Preset: Main');

  assert.equal(rawMain.text, 'Hello {{user}} <X>');
  assert.equal(preMain.text, 'Hello {{user}} <X>');
  assert.equal(macroMain.text, 'Hello Bob <X>');
  assert.equal(postMain.text, 'Hello Bob Z');

  // perItem 必须包含同样的阶段
  const per = result.stages.perItem.find((x) => x.tag.includes('Preset: Main'));
  assert.ok(per, 'Expected perItem for Preset: Main');
  assert.equal(per.raw, 'Hello {{user}} <X>');
  assert.equal(per.afterPreRegex, 'Hello {{user}} <X>');
  assert.equal(per.afterMacro, 'Hello Bob <X>');
  assert.equal(per.afterPostRegex, 'Hello Bob Z');

  // 世界书 beforeChar 应当插入到 Char Before 之前
  const idxWB = result.stages.tagged.raw.findIndex((x) => x.text === 'WB_BEFORE');
  const idxCharBefore = result.stages.tagged.raw.findIndex((x) => x.tag.includes('Preset: Char Before'));
  assert.ok(idxWB !== -1 && idxCharBefore !== -1 && idxWB < idxCharBefore, 'Worldbook beforeChar should appear before Char Before block');
});

await test('buildPrompt: depth 注入（fixed prompt 注入 chatHistory 倒数 depth 之前）', () => {
  const preset = makePreset();

  const result = buildPrompt({
    preset,
    globals: { worldBooks: [], regexScripts: [] },
    history: History.openai([
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' }
    ]),
    view: 'model',
    macros: { user: 'Bob', char: 'Alice' },
    outputFormat: 'tagged'
  });

  const list = result.stages.tagged.raw;

  const idxH1 = list.findIndex((x) => x.tag === 'History: user' && x.text === 'm1');
  const idxH2 = list.findIndex((x) => x.tag === 'History: model' && x.text === 'm2');
  const idxH3 = list.findIndex((x) => x.tag === 'History: user' && x.text === 'm3');
  const idxInject = list.findIndex((x) => x.tag === 'Preset: Inject');

  assert.ok(idxH1 !== -1 && idxH2 !== -1 && idxH3 !== -1 && idxInject !== -1, 'history/inject items should exist');

  // depth=1 => 注入应在最后一条历史（m3）之前
  assert.ok(idxH2 < idxInject && idxInject < idxH3, 'inject should be placed before last history item');
});

await test('buildPrompt: worldbook 静态条目按 order 升序插入（beforeChar）', () => {
  const preset = makePreset();

  const result = buildPrompt({
    preset,
    globals: { worldBooks: makeWorldbooksForOrderTest(), regexScripts: [] },
    history: History.text('hi'),
    view: 'model',
    macros: { user: 'Bob', char: 'Alice' },
    outputFormat: 'tagged'
  });

  const raw = result.stages.tagged.raw;
  const idx1 = raw.findIndex((x) => x.text === 'WB_ORDER_1');
  const idx2 = raw.findIndex((x) => x.text === 'WB_ORDER_2');
  const idxCharBefore = raw.findIndex((x) => x.tag.includes('Preset: Char Before'));

  assert.ok(idx1 !== -1 && idx2 !== -1 && idxCharBefore !== -1, 'expected items exist');
  assert.ok(idx1 < idx2, 'expected order=1 entry before order=2 entry');
  assert.ok(idx2 < idxCharBefore, 'expected worldbook entries appear before Char Before block');
});

await test('buildPrompt: fixed 注入按 depth + order 生效（preset + worldbook 混合）', () => {
  const preset = makePresetForDepthOrderTest();

  const result = buildPrompt({
    preset,
    globals: { worldBooks: makeWorldbooksForDepthOrderInjections(), regexScripts: [] },
    history: History.openai([
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
      { role: 'assistant', content: 'm4' }
    ]),
    view: 'model',
    macros: { user: 'Bob', char: 'Alice' },
    outputFormat: 'tagged'
  });

  const raw = result.stages.tagged.raw;
  const rawTexts = raw.map((x) => x.text);

  // 1) fixed 条目若没 depth 或没 order，应不注入到 chatHistory（本测试用 NaN 模拟非法）
  assert.ok(!rawTexts.includes('W_FIXED_NO_DEPTH_SHOULD_NOT_APPEAR'));
  assert.ok(!rawTexts.includes('W_FIXED_NO_ORDER_SHOULD_NOT_APPEAR'));

  // 2) beforeChar 属于插槽条目，若 preset 未包含对应占位块，则不会出现。
  // 本 preset 没有 charBefore，所以不应出现。
  assert.ok(!rawTexts.includes('W_BEFORE_CHAR_WITH_DEPTH'));

  // 3) 注入排序：先 depth，再 order（同 depth 下）。
  const injections = [
    // worldbook
    { depth: 1, order: 0, text: 'W_D1_O0' },
    { depth: 2, order: 1, text: 'W_D2_O1' },
    { depth: 2, order: 2, text: 'W_D2_O2' },
    // preset
    { depth: 1, order: 5, text: 'P_D1_O5' },
    { depth: 1, order: 10, text: 'P_D1_O10' },
    { depth: 2, order: 0, text: 'P_D2_O0' }
  ].sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.order - b.order));

  const expectedChatHistory = simulateDepthInsert(['m1', 'm2', 'm3', 'm4'], injections);

  // rawTexts 包含插槽 + chatHistory(含注入)
  // 所以我们只截取 chatHistory 段来比对
  const start = rawTexts.indexOf('m1');
  assert.ok(start !== -1);
  const chatHistorySlice = rawTexts.slice(start);

  // preset fixed 若没 order，同样应被忽略
  assert.ok(!chatHistorySlice.includes('P_MISSING_ORDER_SHOULD_NOT_APPEAR'));

  assert.deepEqual(chatHistorySlice, expectedChatHistory);
});

await test('systemRolePolicy=to_user: OpenAI 输出不应包含 system role（system -> user）', () => {
  const preset = makePreset();

  const result = buildPrompt({
    preset,
    globals: { worldBooks: [], regexScripts: [] },
    history: History.openai([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'U' },
      { role: 'assistant', content: 'A' }
    ]),
    view: 'model',
    macros: { user: 'Bob', char: 'Alice' },
    outputFormat: 'openai',
    systemRolePolicy: 'to_user'
  });

  const out = result.stages.output.afterPostRegex;
  assert.ok(Array.isArray(out), 'openai output should be array');
  assert.ok(out.every((m) => m.role !== 'system'), 'Expected no system role in output when systemRolePolicy=to_user');
});

await test('view 过滤：global regex 仅 user view 生效', () => {
  const preset = makePreset();
  const globals = { worldBooks: [], regexScripts: makeRegexesMultiFile() };

  const rModel = buildPrompt({
    preset,
    globals,
    history: History.text('hi'),
    view: 'model',
    macros: { user: 'Bob', char: 'Alice' },
    outputFormat: 'tagged'
  });

  const modelStage = findTaggedByTag(rModel.stages.tagged.afterPostRegex, 'Preset: Main');
  assert.equal(modelStage.text, 'Hello Bob Z', 'user-only rule should NOT apply in model view');

  const rUser = buildPrompt({
    preset,
    globals,
    history: History.text('hi'),
    view: 'user',
    macros: { user: 'Bob', char: 'Alice' },
    outputFormat: 'tagged'
  });

  const userStage = findTaggedByTag(rUser.stages.tagged.afterPostRegex, 'Preset: Main');
  assert.ok(userStage.text.includes('USER_VIEW_REPLACED') || userStage.text.includes('Bob') === false);
});

await test('trim + {{match}}: Trim Out 后替换', () => {
  const preset = makePreset();

  const globals = {
    worldBooks: [],
    regexScripts: [
      {
        id: 'trim-match',
        name: 'trim-match',
        enabled: true,
        findRegex: 'apple',
        replaceRegex: '**{{match}}**',
        trimRegex: ['le'],
        targets: ['slashCommands'],
        view: ['model'],
        runOnEdit: false,
        macroMode: 'none',
        minDepth: null,
        maxDepth: null
      }
    ]
  };

  const result = buildPrompt({
    preset: {
      ...preset,
      prompts: preset.prompts.map((p) =>
        p.identifier === 'main'
          ? { ...p, content: 'I like apple' }
          : p
      )
    },
    globals,
    history: History.text('hi'),
    view: 'model',
    macros: { user: 'Bob', char: 'Alice' },
    outputFormat: 'tagged'
  });

  const main = findTaggedByTag(result.stages.tagged.afterPostRegex, 'Preset: Main');
  assert.equal(main.text, 'I like **app**');
});

await test('macroMode=none: findRegex 中的宏不执行，按宏字面量查找', () => {
  const preset = makePreset();

  const globals = {
    worldBooks: [],
    regexScripts: [
      {
        id: 'none-find-literal-macro',
        name: 'none-find-literal-macro',
        enabled: true,
        findRegex: '{{user}}',
        replaceRegex: 'LITERAL_USER',
        trimRegex: [],
        targets: ['slashCommands'],
        view: ['model'],
        runOnEdit: false,
        macroMode: 'none',
        minDepth: null,
        maxDepth: null
      }
    ]
  };

  const result = buildPrompt({
    preset: {
      ...preset,
      prompts: preset.prompts.map((p) =>
        p.identifier === 'main'
          ? { ...p, content: 'Token={{user}}' }
          : p
      )
    },
    globals,
    history: History.text('hi'),
    view: 'model',
    macros: {},
    outputFormat: 'tagged'
  });

  const macroStage = findTaggedByTag(result.stages.tagged.afterMacro, 'Preset: Main');
  assert.equal(macroStage.text, 'Token={{user}}');

  const postStage = findTaggedByTag(result.stages.tagged.afterPostRegex, 'Preset: Main');
  assert.equal(postStage.text, 'Token=LITERAL_USER');
});

await test('macroMode=raw: 先执行宏，不转义（按正则语义匹配）', () => {
  const preset = makePreset();

  const globals = {
    worldBooks: [],
    regexScripts: [
      {
        id: 'raw-find-macro',
        name: 'raw-find-macro',
        enabled: true,
        findRegex: '{{user}}',
        replaceRegex: 'U',
        trimRegex: [],
        targets: ['slashCommands'],
        view: ['model'],
        runOnEdit: false,
        macroMode: 'raw',
        minDepth: null,
        maxDepth: null
      }
    ]
  };

  const result = buildPrompt({
    preset: {
      ...preset,
      prompts: preset.prompts.map((p) =>
        p.identifier === 'main'
          ? { ...p, content: 'Hello aXb and a.b' }
          : p
      )
    },
    globals,
    history: History.text('hi'),
    view: 'model',
    macros: { user: 'a.b' },
    outputFormat: 'tagged'
  });

  const main = findTaggedByTag(result.stages.tagged.afterPostRegex, 'Preset: Main');
  assert.equal(main.text, 'Hello U and a.b');
});

await test('macroMode=escaped: Find Regex 里的宏值应被正则转义', () => {
  const preset = makePreset();

  const globals = {
    worldBooks: [],
    regexScripts: [
      {
        id: 'escape-find',
        name: 'escape-find',
        enabled: true,
        findRegex: '{{user}}',
        replaceRegex: 'U',
        trimRegex: [],
        targets: ['slashCommands'],
        view: ['model'],
        runOnEdit: false,
        macroMode: 'escaped',
        minDepth: null,
        maxDepth: null
      }
    ]
  };

  const result = buildPrompt({
    preset: {
      ...preset,
      prompts: preset.prompts.map((p) =>
        p.identifier === 'main'
          ? { ...p, content: 'Hello aXb and a.b' } // '.' 不应被当通配
          : p
      )
    },
    globals,
    history: History.text('hi'),
    view: 'model',
    macros: { user: 'a.b' },
    outputFormat: 'tagged'
  });

  const main = findTaggedByTag(result.stages.tagged.afterPostRegex, 'Preset: Main');
  assert.equal(main.text, 'Hello aXb and U');
});

await test('replaceRegex: 宏在每次替换结果上立即执行（含变量宏）', () => {
  const preset = makePreset();

  const globals = {
    worldBooks: [],
    regexScripts: [
      {
        id: 'replace-macro-now',
        name: 'replace-macro-now',
        enabled: true,
        findRegex: '(A)',
        replaceRegex: '{{setvar::hit::yes}}{{getvar::hit}}-{{user}}-$1',
        trimRegex: [],
        targets: ['slashCommands'],
        view: ['model'],
        runOnEdit: false,
        macroMode: 'none',
        minDepth: null,
        maxDepth: null
      }
    ]
  };

  const result = buildPrompt({
    preset: {
      ...preset,
      prompts: preset.prompts.map((p) =>
        p.identifier === 'main'
          ? { ...p, content: 'A' }
          : p
      )
    },
    globals,
    history: History.text('hi'),
    view: 'model',
    macros: { user: 'Bob' },
    outputFormat: 'tagged'
  });

  const macroStage = findTaggedByTag(result.stages.tagged.afterMacro, 'Preset: Main');
  assert.equal(macroStage.text, 'A');

  const postStage = findTaggedByTag(result.stages.tagged.afterPostRegex, 'Preset: Main');
  assert.equal(postStage.text, 'yes-Bob-A');
  assert.equal(result.variables.local.hit, 'yes');
});

await test('variables(any): getvar 可输出 number/object（对象 JSON 化）', () => {
  const preset = makePreset();

  const result = buildPrompt({
    preset: {
      ...preset,
      prompts: preset.prompts.map((p) =>
        p.identifier === 'main'
          ? { ...p, content: 'S={{getvar::score}} C={{getvar::cfg}}' }
          : p
      )
    },
    globals: { worldBooks: [], regexScripts: [] },
    history: History.text('hi'),
    view: 'model',
    macros: { user: 'Bob' },
    variables: { score: 100, cfg: { a: 1 } },
    outputFormat: 'tagged'
  });

  const main = findTaggedByTag(result.stages.tagged.afterMacro, 'Preset: Main');
  assert.equal(main.text, 'S=100 C={"a":1}');
  assert.equal(result.variables.local.score, 100);
  assert.deepEqual(result.variables.local.cfg, { a: 1 });
});

await test('variables(any): setvar 会写入 local 并影响后续 getvar', () => {
  const preset = makePreset();

  const result = buildPrompt({
    preset: {
      ...preset,
      prompts: preset.prompts.map((p) =>
        p.identifier === 'main'
          ? { ...p, content: '{{setvar::foo::bar}}X{{getvar::foo}}' }
          : p
      )
    },
    globals: { worldBooks: [], regexScripts: [] },
    history: History.text('hi'),
    view: 'model',
    outputFormat: 'tagged'
  });

  const main = findTaggedByTag(result.stages.tagged.afterMacro, 'Preset: Main');
  assert.equal(main.text, 'Xbar');
  assert.equal(result.variables.local.foo, 'bar');
});

await test('Variables API: get/list/set/add/inc/dec/delete（对齐 wrapper 语义）', () => {
  const ctx = createVariableContext({ a: 1, s: 'hi' }, { g: 10 });

  Variables.add(ctx, { name: 'a', value: 2 });
  assert.equal(ctx.local.a, 3);

  Variables.add(ctx, { name: 's', value: '!' });
  assert.equal(ctx.local.s, 'hi!');

  Variables.inc(ctx, { name: 'a' });
  assert.equal(ctx.local.a, 4);

  Variables.dec(ctx, { name: 'a' });
  assert.equal(ctx.local.a, 3);

  Variables.set(ctx, { name: 'g', value: 20, scope: 'global' });
  assert.equal(ctx.global.g, 20);

  const got = Variables.get(ctx, { name: 'g', scope: 'global' });
  assert.equal(got.value, 20);

  const listed = Variables.list(ctx, { scope: 'local' });
  assert.equal(listed.variables.a, 3);

  Variables.delete(ctx, { name: 'a' });
  assert.equal(Object.prototype.hasOwnProperty.call(ctx.local, 'a'), false);
});

if (process.exitCode) {
  console.error('\nSome tests FAILED.');
  process.exit(process.exitCode);
} else {
  console.log('\nAll tests PASSED.');
}

