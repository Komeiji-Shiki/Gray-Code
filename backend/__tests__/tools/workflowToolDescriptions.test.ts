/**
 * 工作流与工程日志记忆工具的模型说明：锁定改写后必须保留的行为约束。
 *
 * 覆盖：
 * - update_plan：progress_sync 只传 path/todos/updateMode/changeSummary，续接字段只在主说明写一次，
 *   updateMode / sourceArtifact 参数各提一句；
 * - create_plan：todos 为必填，sourceArtifact 用于检查计划是否仍与来源文档一致；
 * - review 系列：一次审查一份文档、同一会话只有一个进行中的审查、finalize 后需 reopen；
 * - memory_*：区分工程日志记忆（memory_note）与个人长期记忆（memory_search / memory_remember）；
 * - 所有文本不含内部实现名（ConversationMetadata、Cursor-style 等）与全大写强调词。
 */

import { createTodoWriteToolDeclaration } from '../../tools/todo/todo_write';
import { createTodoUpdateToolDeclaration } from '../../tools/todo/todo_update';
import { createCreatePlanToolDeclaration } from '../../tools/plan/create_planRuntime';
import { createUpdatePlanToolDeclaration } from '../../tools/plan/update_planRuntime';
import { createCreateDesignToolDeclaration } from '../../tools/design/create_designRuntime';
import { createUpdateDesignToolDeclaration } from '../../tools/design/update_designRuntime';
import { createCreateProgressToolDeclaration } from '../../tools/progress/create_progressRuntime';
import { createUpdateProgressToolDeclaration } from '../../tools/progress/update_progressRuntime';
import { createRecordProgressMilestoneToolDeclaration } from '../../tools/progress/record_progress_milestoneRuntime';
import { createValidateProgressDocumentToolDeclaration } from '../../tools/progress/validate_progress_documentRuntime';
import { createCreateReviewToolDeclaration } from '../../tools/review/create_reviewRuntime';
import { createRecordReviewMilestoneToolDeclaration } from '../../tools/review/record_review_milestoneRuntime';
import { createFinalizeReviewToolDeclaration } from '../../tools/review/finalize_reviewRuntime';
import { createReopenReviewToolDeclaration } from '../../tools/review/reopen_reviewRuntime';
import { createValidateReviewDocumentToolDeclaration } from '../../tools/review/validate_review_documentRuntime';
import { createCompareReviewDocumentsToolDeclaration } from '../../tools/review/compare_review_documentsRuntime';
import { createMemoryWakeDeclaration } from '../../tools/memory/memory_wake';
import { createMemoryNoteDeclaration } from '../../tools/memory/memory_note';
import { createMemoryRecallDeclaration } from '../../tools/memory/memory_recall';
import { createMemoryCompressDeclaration } from '../../tools/memory/memory_compress';
import { createMemoryZoomDeclaration } from '../../tools/memory/memory_zoom';
import { createMemoryForgetDeclaration } from '../../tools/memory/memory_forget';
import { createMemoryConfigDeclaration } from '../../tools/memory/memory_config';
import { workflow } from '../../tools/localization/catalogs/zh-CN/workflow';
import { auxiliary } from '../../tools/localization/catalogs/zh-CN/auxiliary';
import { overrides } from '../../tools/localization/catalogs/en/overrides';
import type { ToolDeclaration } from '../../tools/types';
import type { ToolDescriptionLocalization } from '../../tools/localization/types';

const WORKFLOW_DECLARATIONS: ToolDeclaration[] = [
    createTodoWriteToolDeclaration(),
    createTodoUpdateToolDeclaration(),
    createCreatePlanToolDeclaration(),
    createUpdatePlanToolDeclaration(),
    createCreateDesignToolDeclaration(),
    createUpdateDesignToolDeclaration(),
    createCreateProgressToolDeclaration(),
    createUpdateProgressToolDeclaration(),
    createRecordProgressMilestoneToolDeclaration(),
    createValidateProgressDocumentToolDeclaration(),
    createCreateReviewToolDeclaration(),
    createRecordReviewMilestoneToolDeclaration(),
    createFinalizeReviewToolDeclaration(),
    createReopenReviewToolDeclaration(),
    createValidateReviewDocumentToolDeclaration(),
    createCompareReviewDocumentsToolDeclaration()
];

const MEMORY_DECLARATIONS: ToolDeclaration[] = [
    createMemoryWakeDeclaration(),
    createMemoryNoteDeclaration(),
    createMemoryRecallDeclaration(),
    createMemoryCompressDeclaration(),
    createMemoryZoomDeclaration(),
    createMemoryForgetDeclaration(),
    createMemoryConfigDeclaration()
];

function byName(name: string): ToolDeclaration {
    const found = [...WORKFLOW_DECLARATIONS, ...MEMORY_DECLARATIONS].find(decl => decl.name === name);
    if (!found) throw new Error(`declaration not found: ${name}`);
    return found;
}

/** 递归收集参数 schema 中的全部 description */
function collectSchemaDescriptions(node: unknown, out: string[] = []): string[] {
    if (!node || typeof node !== 'object') return out;
    const record = node as Record<string, unknown>;
    if (typeof record.description === 'string') out.push(record.description);
    for (const value of Object.values(record)) {
        if (value && typeof value === 'object') collectSchemaDescriptions(value, out);
    }
    return out;
}

function declarationTexts(decl: ToolDeclaration): string[] {
    return [decl.description, ...collectSchemaDescriptions(decl.parameters.properties)];
}

function catalogTexts(entry: ToolDescriptionLocalization | undefined): string[] {
    if (!entry) return [];
    return [entry.description, ...Object.values(entry.parameters ?? {})]
        .filter((text): text is string => typeof text === 'string');
}

const ALL_TEXTS: Array<[string, string[]]> = [
    ...[...WORKFLOW_DECLARATIONS, ...MEMORY_DECLARATIONS].map(decl => [`source:${decl.name}`, declarationTexts(decl)] as [string, string[]]),
    ...Object.entries(workflow).map(([name, entry]) => [`zh-CN:${name}`, catalogTexts(entry)] as [string, string[]]),
    ...Object.entries(auxiliary).map(([name, entry]) => [`zh-CN:${name}`, catalogTexts(entry)] as [string, string[]]),
    ...Object.entries(overrides).map(([name, entry]) => [`en:${name}`, catalogTexts(entry)] as [string, string[]])
];

describe('工具说明不暴露内部实现、不使用全大写强调', () => {
    test.each(ALL_TEXTS)('%s', (_label, texts) => {
        for (const text of texts) {
            expect(text).not.toMatch(/ConversationMetadata|todoList"|Cursor|V4|新鲜度|不变量|invariant|freshness/i);
            // 路径 glob（.graycode/plans/**.md）含 **，因此只排除 markdown 加粗形式 **词**
            expect(text).not.toMatch(/\b(IMPORTANT|MANDATORY|NEVER)\b|Do NOT|\*\*[^*.\s][^*]*\*\*/);
        }
    });
});

describe('update_plan：progress_sync 约束只在主说明完整写一次', () => {
    const decl = byName('update_plan');
    const props = decl.parameters.properties;

    test('英文源声明：主说明列出允许字段与续接字段，参数各提一句', () => {
        expect(decl.description).toContain('progress_sync');
        expect(decl.description).toContain('path, todos, updateMode and the optional changeSummary');
        expect(decl.description).toMatch(/sourcePath.*planContent.*continuationIntent/);
        expect(decl.description).toContain('ignored with a warning');
        expect(decl.description).toContain('make the call fail');
        expect(props.updateMode.description).toContain('progress_sync');
        expect(props.sourceArtifact.description).toContain('revision');
        // 续接字段长名单不在参数里重复
        expect(props.updateMode.description).not.toContain('continuationIntent');
        expect(props.sourceArtifact.description).not.toContain('sourceArtifactType');
        expect(props.path.description).not.toContain('planPath');
    });

    test('中文目录：主说明列出允许字段与续接字段，参数各提一句', () => {
        const zh = workflow.update_plan;
        expect(zh.description).toContain('只传 path、todos、updateMode 和可选的 changeSummary');
        expect(zh.description).toMatch(/sourcePath.*planContent.*continuationIntent/);
        expect(zh.description).toContain('会被忽略并给出警告');
        expect(zh.parameters!.updateMode).toContain('progress_sync');
        expect(zh.parameters!.sourceArtifact).toContain('revision');
        expect(zh.parameters!.updateMode).not.toContain('continuationIntent');
        expect(zh.parameters!.sourceArtifact).not.toContain('sourceArtifactType');
    });
});

describe('create_plan / create_design：路径约束与已存在拒绝', () => {
    test('create_plan 的 todos 标为必填，sourceArtifact 说明为检查计划是否仍与来源一致', () => {
        const decl = byName('create_plan');
        expect(decl.parameters.required).toEqual(['plan', 'todos']);
        expect(decl.parameters.properties.todos.description).toContain('Required');
        expect(decl.description).toContain('still matches');
        expect(workflow.create_plan.parameters!.todos).toContain('必填');
        expect(workflow.create_plan.description).toContain('计划是否仍与来源文档一致');
    });

    test.each(['create_plan', 'create_design', 'create_review'])('%s：路径必须在 .graycode 下，已存在时失败', (name) => {
        const decl = byName(name);
        expect(decl.description).toMatch(/\.graycode\/(plans|design|review)\/\*\*\.md/);
        expect(decl.description).toContain('already exists');
        expect(decl.parameters.properties.path.description).toContain('workspace/.graycode/');
        expect(workflow[name].description).toContain('已存在时调用会失败');
    });
});

describe('review 系列：会话内单一审查与 finalize / reopen 规则', () => {
    test('create_review：一次审查一份文档、同一会话只有一个进行中的审查', () => {
        expect(byName('create_review').description).toContain('Each review uses one document');
        expect(byName('create_review').description).toContain('only one review in progress');
        expect(workflow.create_review.description).toContain('一次审查只对应一份文档');
        expect(workflow.create_review.description).toContain('只能有一个进行中的审查');
    });

    test.each(['record_review_milestone', 'finalize_review'])('%s：finalize 之后需 reopen_review 才能继续记录', (name) => {
        expect(byName(name).description).toContain('reopen_review');
        expect(byName(name).description).toContain('in progress');
        expect(workflow[name].description).toContain('除非先用 reopen_review 重新打开');
    });

    test('reopen_review：已有其他进行中的审查时失败', () => {
        expect(byName('reopen_review').description).toContain('another review is already in progress');
        expect(workflow.reopen_review.description).toContain('已有其他进行中的审查时，调用会失败');
    });
});

describe('progress 系列：保留默认值与替换语义', () => {
    test('create_progress：已存在时返回快照，默认 status/phase', () => {
        expect(byName('create_progress').description).toContain('instead of creating a second file');
        expect(byName('create_progress').description).toContain('status defaults to active and phase to design');
        expect(workflow.create_progress.description).toContain('不会再建第二份');
    });

    test('update_progress：只改传入字段，todos/risks 整体替换', () => {
        expect(byName('update_progress').description).toContain('todos and risks replace their whole lists');
        expect(workflow.update_progress.description).toContain('todos 和 risks 整体替换原有列表');
    });
});

describe('memory_*：区分工程日志记忆与个人长期记忆', () => {
    test('memory_wake / memory_recall / memory_note 指向个人长期记忆工具', () => {
        expect(byName('memory_wake').description).toContain('工程日志记忆');
        expect(byName('memory_wake').description).toContain('memory_search');
        expect(byName('memory_recall').description).toContain('memory_search');
        expect(byName('memory_note').description).toContain('memory_remember');
        expect(overrides.memory_wake.description).toContain('personal long-term memory');
        expect(overrides.memory_note.description).toContain('memory_remember');
        expect(overrides.memory_recall.description).toContain('memory_search');
    });

    test('zh-CN 目录的 memory_* 与中文源声明保持一致', () => {
        for (const decl of MEMORY_DECLARATIONS) {
            const entry = auxiliary[decl.name];
            expect(entry).toBeDefined();
            expect(entry.description).toBe(decl.description);
            for (const [key, text] of Object.entries(entry.parameters ?? {})) {
                expect(text).toBe(decl.parameters.properties[key].description);
            }
        }
    });

    test('memory_note 的长度按 UTF-8 字节计算，memory_config 不再声称只影响输出格式', () => {
        expect(byName('memory_note').parameters.properties.text.description).toContain('UTF-8 字节');
        expect(overrides.memory_note.parameters!.text).toContain('UTF-8 bytes');
        expect(byName('memory_config').description).not.toContain('只影响输出格式');
        expect(byName('memory_config').description).toContain('不会改写已保存的记忆');
    });
});
