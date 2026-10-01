/**
 * Prompts sent to the model after the user confirms a design, review or plan card.
 * Shared by the platform server and the VS Code host so both give the same instructions.
 */

function sourceLine(label: string, modified: boolean): string {
    return modified
        ? `The user edited the ${label} before confirming it. The latest version above is the source of truth.`
        : `The confirmed ${label} above is the source of truth.`;
}

export function buildPlanGenerationPrompt(artifactType: 'design' | 'review', modified: boolean): string {
    return [
        `The user confirmed the ${artifactType} and asked for the implementation plan now.`,
        '',
        sourceLine(artifactType, modified),
        `Create the plan right away with create_plan, and pass sourceArtifact pointing to the confirmed ${artifactType} document. The review step is over, so do not ask for confirmation again or say that the ${artifactType} is ready for review.`
    ].join('\n');
}

export function buildPlanExecutionPrompt(modified: boolean): string {
    return [
        'The user confirmed the plan and asked you to start implementing it now.',
        '',
        sourceLine('plan', modified),
        'Start implementation immediately. The plan is final, so do not say it is ready for review, and do not create another plan unless the user asks for a revision.',
        'As you work, keep the TODO list current with todo_update, and when TODO status changes meaningfully, sync it back to the plan with update_plan in progress_sync mode, passing only path, todos, updateMode and an optional changeSummary.',
        'When project-level progress changes meaningfully, keep .graycode/progress.md current with update_progress and record_progress_milestone.'
    ].join('\n');
}
