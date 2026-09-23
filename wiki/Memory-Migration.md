# LifeBook 记忆迁移

[返回目录](Home.md)

如果你之前使用过 LifeBook 或 Graphiti 记忆系统，GrayCode 提供了完整的历史档案迁移工具，能够将原始日志、图谱实体、多模态附件以及事实关系无损导入 GrayCode 的长期记忆库。

---

## 1. 迁移机制与准备

- **完整性保留**：原始的 Markdown 文本、JSONL 对话、图片附件、SQLite 索引与 Kuzu 图谱数据均按字节完整保留在归档存储中。
- **独立资料库**：导入的数据会先存入独立的“导入资料库”，初始状态为“待核对”，默认不自动混入日常对话召回中，避免未经核对的历史数据污染新会话。
- **环境要求**：确保来源目录是已停止写入的完整静态副本，导入过程不会修改源目录。

---

## 2. 执行导入步骤

### 步骤 1：导出 Kuzu 图谱（如有）
如果原 LifeBook 包含 `.graphiti.kuzu` 知识图谱，可先使用 Python 脚本导出图谱结构：

```powershell
python scripts/export-lifebook-graph.py C:\Migration\lifebook\.graphiti.kuzu C:\Migration\graph-export.json
```

### 步骤 2：执行平台导入命令
运行导入 CLI 命令将数据合并入目标 GrayCode 数据目录：

```powershell
# 编译平台服务
npm run build:platform

# 执行迁移
node apps/server/dist/main.cjs --data C:\GrayCode-Data import-lifebook C:\Migration\lifebook --graph-export C:\Migration\graph-export.json --actor owner --name "LifeBook 导入资料库"
```

*参数说明*：
- `--data`：目标 GrayCode 数据的存储路径。
- `import-lifebook`：源 LifeBook 数据目录。
- `--graph-export`：上一步导出的图谱 JSON 路径（若无图谱可省略）。
- `--actor`：导入所属的账户标识（默认为 `owner`）。
- `--name`：新资料库的展示名称。

---

## 3. 核对与启用召回

1. 打开 GrayCode 桌面端，进入 **资料库 → 长期记忆**。
2. 在左侧选择刚导入的资料库名称，浏览导入的事实条目与关系图。
3. 针对重要记忆条目进行人工确认，将其状态设置为 **已确认**。
4. 勾选 **允许在对话中自动召回**，该资料库中的已确认记忆便会在后续日常编码对话中自动参与语义检索与上下文注入。
