## fast-tavern（Python 版）

**Repo**: [Lianues/fast-tavern](https://github.com/Lianues/fast-tavern)

这是主项目 `fast-tavern` 的 **Python 移植版**，目标是对齐 TypeScript 实现的行为（提示词组装与多阶段调试输出）。

### 安装（开发期）

在本目录下执行：

```bash
pip install -e .[dev]
pytest
```

### 打包/发布

在本目录下执行：

```bash
pip install build twine
python -m build
twine upload dist/*
```

### 快速开始（与 TS 用法对齐）

```python
from fast_tavern import build_prompt, History

result = build_prompt(
    preset=preset,
    character=character,
    globals={"worldBooks": world_books, "regexScripts": regex_scripts},
    history=History.openai(
        [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi!"},
        ]
    ),
    view="model",
    macros={"user": "Bob"},
    variables={"score": 1},
    output_format="openai",
    system_role_policy="keep",
)

print(result["stages"]["tagged"]["afterPostRegex"])

### 旧酒馆格式直接调用（包装入口）

```python
from fast_tavern import build_prompt_from_silly_tavern

result = build_prompt_from_silly_tavern(
    preset=legacy_preset_settings,   # 旧 ST preset/settings
    character=legacy_character,      # 可选，旧 ST character
    globals={
        "worldBooks": legacy_worldbooks,
        "regexScripts": legacy_regexes,
    },
    history=legacy_chat,
    view="model",
    outputFormat="openai",
)
```

也可单独调用转换函数：

- `convert_preset_from_silly_tavern` / `convert_worldbook_from_silly_tavern`
- `convert_regex_from_silly_tavern` / `convert_character_from_silly_tavern` / `convert_history_from_silly_tavern`

print(result["stages"]["output"]["afterPostRegex"])
```

### Regex flags 说明（与 TS 的差异点）

- `findRegex` 支持 `"/pattern/flags"` 与 `"pattern"` 两种写法。
- flags 映射：`i/m/s` -> Python `re` 对应 flags；`g` 用于决定“替换一次/全部”；`u` 默认等价；`y` 不支持（若遇到会按普通正则处理）。

### 发布后安装

```bash
pip install fast-tavern
```
