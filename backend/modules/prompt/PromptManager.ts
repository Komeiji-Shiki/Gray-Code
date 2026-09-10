import * as vscode from 'vscode'
import { getGlobalSettingsManager } from '../../core/settingsContext'
import { PromptContextSectionBuilder } from './contextSections'
import { PromptAssembler } from './PromptAssembler'
import type { PromptConfig } from './types'
export * from './PromptAssembler'

/** VS Code composition adapter; the independent desktop uses its own host ports. */
export class PromptManager extends PromptAssembler {
    constructor(config: Partial<PromptConfig> = {}) {
        super({ settings: getGlobalSettingsManager,
            workspacePaths: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
            sections: new PromptContextSectionBuilder() }, config)
    }
}

let globalPromptManager: PromptManager | null = null
export function getPromptManager(): PromptManager {
    return globalPromptManager ??= new PromptManager()
}
export function setPromptManager(manager: PromptManager): void { globalPromptManager = manager }
