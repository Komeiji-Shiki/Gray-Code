/**
 * 工作流与工程日志记忆工具的模型说明：锁定改写后必须保留的行为约束。
 *
 * 覆盖：
 * - update_plan：progress_sync 只传 path/todos/updateMode/changeSummary，更新约束只在主说明写一次，
 *   updateMode / sourceArtifact 参数各提一句；
 * - create_plan：todos 为必填，sourceArtifact 用于检查计划是否仍与来源文档一致；
 * - review 系列：一次审查一份文档、同一会话只有一个进行中的审查、finalize 后需 reopen；
 * - engineering_log：区分工程日志与个人长期记忆（memory_search / memory_remember）；
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
import { createEngineeringLogDeclaration } from '../../tools/memory/engineeringLog';
import type { ToolDeclaration } from '../../tools/types';

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
    createEngineeringLogDeclaration()
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

const ALL_TEXTS: Array<[string, string[]]> = [
    ...[...WORKFLOW_DECLARATIONS, ...MEMORY_DECLARATIONS].map(decl => [`source:${decl.name}`, declarationTexts(decl)] as [string, string[]])
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

    test('平台中文声明：主说明列出允许字段与忽略规则，参数各提一句', () => {
        expect(decl.description).toContain('progress_sync');
        expect(decl.description).toContain('path、todos、updateMode 和可选的 changeSummary');
        expect(decl.description).toContain('sourceArtifact 会被忽略并给出警告');
        expect(decl.description).toContain('schema 外字段会导致调用失败');
        expect(props.updateMode.description).toContain('progress_sync');
        expect(props.sourceArtifact.description).toContain('revision');
        // 主说明已给出输入范围，参数不重复列举旧字段。
        expect(props.updateMode.description).not.toContain('continuationIntent');
        expect(props.sourceArtifact.description).not.toContain('sourceArtifactType');
        expect(props.path.description).not.toContain('planPath');
    });
});

describe('create_plan / create_design：路径约束与已存在拒绝', () => {
    test('create_plan 的 todos 标为必填，sourceArtifact 说明为检查计划是否仍与来源一致', () => {
        const decl = byName('create_plan');
        expect(decl.parameters.required).toEqual(['plan', 'todos']);
        expect(decl.parameters.properties.todos.description).toContain('必填');
        expect(decl.description).toContain('计划是否仍与来源文档一致');
    });

    test.each(['create_plan', 'create_design', 'create_review'])('%s：路径必须在 .graycode 下，已存在时失败', (name) => {
        const decl = byName(name);
        expect(decl.description).toMatch(/\.graycode\/(plans|design|review)\/\*\*\.md/);
        expect(decl.description).toContain('已存在时调用失败');
        expect(decl.parameters.properties.path.description).toContain('workspace/.graycode/');
    });
});

describe('review 系列：会话内单一审查与 finalize / reopen 规则', () => {
    test('create_review：一次审查一份文档、同一会话只有一个进行中的审查', () => {
        expect(byName('create_review').description).toContain('每次审查一份文档');
        expect(byName('create_review').description).toContain('只能有一个进行中的审查');
    });

    test.each(['record_review_milestone', 'finalize_review'])('%s：finalize 之后需 reopen_review 才能继续记录', (name) => {
        expect(byName(name).description).toContain('reopen_review');
        expect(byName(name).description).toContain('进行中的审查');
        expect(byName(name).description).toContain('须先用 reopen_review');
    });

    test('reopen_review：已有其他进行中的审查时失败', () => {
        expect(byName('reopen_review').description).toContain('已有其他进行中的审查时失败');
    });
});

describe('progress 系列：保留默认值与替换语义', () => {
    test('create_progress：已存在时返回快照，默认 status/phase', () => {
        expect(byName('create_progress').description).toContain('已存在时返回其快照');
        expect(byName('create_progress').description).toContain('status 默认为 active，phase 默认为 design');
    });

    test('update_progress：只改传入字段，todos/risks 整体替换', () => {
        expect(byName('update_progress').description).toContain('todos 和 risks 整体替换');
    });
});

describe('engineering_log：区分工程日志与个人长期记忆', () => {
    test('读取与记录操作明确指向独立的个人长期记忆工具', () => {
        const description = byName('engineering_log').description;
        expect(description).toContain('工程日志');
        expect(description).toContain('个人长期记忆');
        expect(description).toContain('memory_search');
        expect(description).toContain('memory_remember');
    });

    test('note 的长度按 UTF-8 字节计算，config 不再声称只影响输出格式', () => {
        const declaration = byName('engineering_log');
        expect(declaration.parameters.properties.text.description).toContain('UTF-8 字节');
        expect(declaration.description).not.toContain('只影响输出格式');
        expect(declaration.description).toContain('不改写已保存的记忆');
    });
});
