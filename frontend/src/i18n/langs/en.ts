/**
 * GrayCode - English Language Pack
 * Organized by component directory structure
 */

import type { LanguageMessages } from '../types';

const en: LanguageMessages = {
    common: {
        save: 'Save',
        cancel: 'Cancel',
        confirm: 'Confirm',
        delete: 'Delete',
        edit: 'Edit',
        add: 'Add',
        remove: 'Remove',
        enable: 'Enable',
        disable: 'Disable',
        enabled: 'Enabled',
        disabled: 'Disabled',
        loading: 'Loading...',
        error: 'Error',
        success: 'Success',
        warning: 'Warning',
        info: 'Info',
        close: 'Close',
        back: 'Back',
        next: 'Next',
        done: 'Done',
        yes: 'Yes',
        no: 'No',
        ok: 'OK',
        copy: 'Copy',
        paste: 'Paste',
        reset: 'Reset',
        default: 'Default',
        custom: 'Custom',
        auto: 'Auto',
        manual: 'Manual',
        none: 'None',
        all: 'All',
        select: 'Select',
        search: 'Search',
        filter: 'Filter',
        sort: 'Sort',
        refresh: 'Refresh',
        retry: 'Retry',
        settings: 'Settings',
        help: 'Help',
        about: 'About',
        version: 'Version',
        name: 'Name',
        description: 'Description',
        status: 'Status',
        type: 'Type',
        size: 'Size',
        path: 'Path',
        time: 'Time',
        date: 'Date',
        actions: 'Actions',
        more: 'More',
        less: 'Less',
        expand: 'Expand',
        collapse: 'Collapse',
        preview: 'Preview',
        download: 'Download',
        upload: 'Upload',
        import: 'Import',
        export: 'Export',
        create: 'Create',
        update: 'Update',
        apply: 'Apply',
        install: 'Install',
        uninstall: 'Uninstall',
        start: 'Start',
        stop: 'Stop',
        pause: 'Pause',
        resume: 'Resume',
        running: 'Running',
        stopped: 'Stopped',
        pending: 'Pending',
        completed: 'Completed',
        failed: 'Failed',
        unknown: 'Unknown'
    },

    components: {
        announcement: {
            title: 'What\'s New',
            gotIt: 'Got it'
        },
        update: {
            title: 'Update Available',
            intro: 'Gray Code v{version} is available. Download and install now?',
            releaseNotes: 'What\'s New',
            install: 'Download & Install',
            later: 'Later',
            viewPage: 'View on GitHub',
            downloading: 'Downloading and installing…',
            installed: 'Installed. Reload the window to apply.',
            failed: 'Download or install failed'
        },
        attachment: {
            preview: 'Preview',
            download: 'Download',
            close: 'Close',
            downloadFile: 'Download File',
            unsupportedPreview: 'This file type cannot be previewed',
            imageFile: 'Image File',
            videoFile: 'Video File',
            audioFile: 'Audio File',
            documentFile: 'Document File',
            otherFile: 'Other File'
        },

        common: {
            confirmDialog: {
                title: 'Confirm',
                message: 'Are you sure you want to proceed?',
                confirm: 'Confirm',
                cancel: 'Cancel'
            },
            inputDialog: {
                title: 'Input',
                confirm: 'OK',
                cancel: 'Cancel'
            },
            deleteDialog: {
                title: 'Delete Message',
                message: 'Are you sure you want to delete this message?',
                messageWithCount: 'Are you sure you want to delete this message? This will also delete the following {count} messages, {total} messages will be deleted in total.',
                checkpointHint: 'A backup was detected before this message. You can choose to restore to that backup point before deleting to recover file changes.',
                cancel: 'Cancel',
                delete: 'Delete',
                restoreToUserMessage: 'Restore to before user message',
                restoreToAssistantMessage: 'Restore to before assistant message',
                restoreToToolBatch: 'Restore to before batch tool execution',
                restoreToTool: 'Restore to before {toolName} execution',
                restoreToAfterUserMessage: 'Restore to after user message',
                restoreToAfterAssistantMessage: 'Restore to after assistant message',
                restoreToAfterToolBatch: 'Restore to after batch tool execution',
                restoreToAfterTool: 'Restore to after {toolName} execution'
            },
            editDialog: {
                title: 'Edit Message',
                placeholder: 'Enter new message content... (paste attachments, drag files to add badges, Ctrl+Shift+drag to insert @path text, type @ to search files)',
                addAttachment: 'Add Attachment',
                checkpointHint: 'A tool execution backup was detected before this message. You can choose to restore to before tool execution and then edit to recover file changes.',
                cancel: 'Cancel',
                save: 'Save',
                saveInPlace: 'Save In Place (Keep Branch)',
                rootMessageHint: 'This is the first message of the conversation: Save will update the text and regenerate the follow-up reply (the previous answer is kept as a switchable version); "Save In Place" only updates the text without regenerating.',
                rootSaveHint: 'Save and regenerate the follow-up reply',
                restoreToUserMessage: 'Restore to before user message',
                restoreToAssistantMessage: 'Restore to before assistant message',
                restoreToToolBatch: 'Restore to before batch tool execution',
                restoreToTool: 'Restore to before {toolName} execution',
                restoreToAfterUserMessage: 'Restore to after user message',
                restoreToAfterAssistantMessage: 'Restore to after assistant message',
                restoreToAfterToolBatch: 'Restore to after batch tool execution',
                restoreToAfterTool: 'Restore to after {toolName} execution'
            },
            retryDialog: {
                title: 'Retry Message',
                message: 'Generate a new version of this message? The current response will be kept, and you can switch between versions afterwards.',
                checkpointHint: 'A tool execution backup was detected before this message. You can choose to restore to before tool execution and then retry.',
                cancel: 'Cancel',
                retry: 'Retry',
                restoreToUserMessage: 'Restore to before user message',
                restoreToAssistantMessage: 'Restore to before assistant message',
                restoreToToolBatch: 'Restore to before batch tool execution',
                restoreToTool: 'Restore to before {toolName} execution',
                restoreToAfterUserMessage: 'Restore to after user message',
                restoreToAfterAssistantMessage: 'Restore to after assistant message',
                restoreToAfterToolBatch: 'Restore to after batch tool execution',
                restoreToAfterTool: 'Restore to after {toolName} execution'
            },
            dependencyWarning: {
                title: 'Dependencies Required',
                defaultMessage: 'This feature requires the following dependencies:',
                hint: 'Please go to',
                linkText: 'Extension Dependencies'
            },
            emptyState: {
                noData: 'No data',
                noResults: 'No results found'
            },
            tooltip: {
                copied: 'Copied',
                copyFailed: 'Copy failed'
            },
            modal: {
                close: 'Close'
            },
            markdown: {
                copyCode: 'Copy code',
                wrapEnable: 'Wrap lines',
                wrapDisable: 'No wrap',
                copied: 'Copied',
                imageLoadFailed: 'Failed to load image'
            },
            markdownRenderer: {
                mermaid: {
                    title: 'Mermaid Diagram',
                    copyCode: 'Copy Mermaid code',
                    zoomIn: 'Zoom in',
                    zoomOut: 'Zoom out',
                    resetZoom: 'Reset zoom',
                    tip: 'Scroll to zoom, drag to pan',
                    closePreview: 'Close preview'
                }
            },
            scrollToTop: 'Scroll to top',
            scrollToBottom: 'Scroll to bottom'
        },

        header: {
            newChat: 'New Chat',
            history: 'History',
            settings: 'Settings',
            model: 'Model',
            channel: 'Channel'
        },

        tabs: {
            newChat: 'New Chat',
            newTab: 'New Tab',
            closeTab: 'Close Tab',
            appTitle: 'GrayCode',
            toggleLanguage: 'Switch Language',
            settings: 'Settings',
            monitor: 'SubAgent Monitor',
            monitorOpen: 'Open SubAgent Monitor panel',
            monitorClose: 'Close SubAgent Monitor panel',
            workspaceSelector: {
                auto: 'Follow Active Editor',
                noWorkspace: 'No Workspace',
                openWorkspaces: 'Open Workspaces',
                savedWorkspaces: 'Saved Workspaces',
                openWorkspaceFolder: 'Open Workspace Folder…',
                removeWorkspace: 'Remove from saved',
                openTag: 'Open',
                notOpen: 'Not open',
                noSavedWorkspaces: 'No saved workspaces'
            }
        },

        usage: {
            title: 'Usage Statistics',
            backToChat: 'Back to Chat',
            refresh: 'Refresh',
            loading: 'Calculating…',
            loadFailed: 'Failed to load usage stats',
            retry: 'Retry',
            empty: 'No usage data yet',
            totalTokens: 'Total Tokens',
            promptTokens: 'Input',
            candidatesTokens: 'Output',
            thoughtsTokens: 'Thinking',
            cacheCreationTokens: 'Cache Write',
            cacheReadTokens: 'Cache Read',
            conversations: 'Conversations',
            modelMessages: 'Responses',
            byConversation: 'By Conversation',
            byModel: 'By Model',
            byDay: 'By Date',
            unknownModel: 'Unknown model',
            skippedHint: '{count} conversation(s) skipped due to read errors',
            generatedAt: 'Generated at',
            rangeAll: 'All',
            rangeToday: 'Today',
            range7d: 'Last 7 days',
            range30d: 'Last 30 days',
            estimatedCost: 'Est. Cost',
            editPricing: 'Set pricing ($ per 1M tokens)',
            inputPrice: 'Input price',
            outputPrice: 'Output price',
            save: 'Save',
            cancel: 'Cancel',
            openConversation: 'Click to open this conversation'
        },

        usageTime: {
            title: 'Usage Time',
            refresh: 'Refresh',
            loading: 'Loading…',
            loadFailed: 'Failed to load',
            empty: 'No usage time data yet (activity in the editor starts recording)',
            today: 'Today',
            currentSession: 'Current session',
            totalInRange: 'Total in range',
            range7d: '7 days',
            range30d: '30 days',
            range90d: '90 days',
            range1y: '1 year',
            rangeAll: 'All',
            hours: 'h',
            minutes: 'm',
            durationHM: '{hours}h {minutes}m',
            shortHour: 'h',
            shortMinute: 'm',
            dailyTitle: 'Daily usage',
            monthlyTitle: 'Monthly usage (click a month for daily details)',
            monthlyTitleShort: 'Monthly usage',
            monthActiveDays: '{days} active days',
            onlyShowLatest: 'Showing latest {days} days only',
            expandMonth: 'Expand daily details for this month',
            heatmapTitle: 'Activity heatmap (last 7 days, hover for details)'
        },

        history: {
            title: 'Chat History',
            empty: 'No conversations yet',
            deleteConfirm: 'Are you sure you want to delete this conversation?',
            searchPlaceholder: 'Search conversations...',
            clearSearch: 'Clear search',
            noSearchResults: 'No matching conversations',
            today: 'Today',
            yesterday: 'Yesterday',
            thisWeek: 'This Week',
            earlier: 'Earlier',
            noTitle: 'Untitled',
            currentWorkspace: 'Current Workspace',
            allWorkspaces: 'All Workspaces',
            backToChat: 'Back to Chat',
            showHistory: 'Show history:',
            revealInExplorer: 'Reveal in Explorer',
            deleteConversation: 'Delete Conversation',
            renameConversation: 'Rename Conversation',
            renameDialogTitle: 'Rename Conversation',
            renamePlaceholder: 'Enter a new conversation title',
            renameConfirm: 'Save',
            renameCancel: 'Cancel',
            deleteConversationConfirm: 'Delete this conversation and all of its messages?',
            messages: 'messages'
        },

        home: {
            welcome: 'Welcome to GrayCode',
            welcomeMessage: 'AI coding assistant helping you write code more efficiently',
            welcomeHint: 'Type a message in the input box below to start a conversation',
            quickStart: 'Quick Start',
            recentChats: 'Recent Chats',
            noRecentChats: 'No conversation history',
            viewAll: 'View All'
        },

        input: {
            placeholder: 'Type a message...',
            placeholderHint: 'Type a message... (Enter to send, paste attachments, Shift+drag or @ to add paths, Ctrl+Shift+drag to insert @path text)',
            resizeInput: 'Resize message input; use arrow keys, Home, or double-click to restore automatic height',
            send: 'Send message',
            sendPreserveDynamicContext: 'Send and preserve old dynamic context in place',
            stopGenerating: 'Stop generating',
            sendWhileBusy: 'Send new message (a running command moves to background, AI responds first)',
            interruptDelivered: 'Inserted into the current turn — AI will handle it shortly',
            attachFile: 'Attach file',
            pinnedFiles: 'Pinned files',
            skills: 'Skills',
            summarizeContext: 'Summarize context',
            createCheckpoint: 'Create checkpoint (save current workspace state for later restore)',
            tpsTooltip: 'TPS (tokens per second)',
            tpsTokenizerReal: 'Accurate model tokenizer counting',
            tpsTokenizerEstimate: 'Tokenizer not ready, estimating by characters',
            selectChannel: 'Select channel',
            selectModel: 'Select model',
            clickToPreview: 'Click to preview',
            remove: 'Remove',
            tokenUsage: 'Usage',
            context: 'Context',
            fileNotExists: 'File does not exist',
            queue: {
                title: 'Queued Messages',
                sendNow: 'Send now',
                remove: 'Remove',
                queued: 'Queued',
                drag: 'Drag to reorder',
                edit: 'Edit'
            },
            mode: {
                selectMode: 'Select mode',
                manageMode: 'Manage Modes',
                search: 'Search modes...',
                noResults: 'No matching modes'
            },
            channelSelector: {
                placeholder: 'Select config',
                searchPlaceholder: 'Search channels...',
                noMatch: 'No matching channels'
            },
            modelSelector: {
                placeholder: 'Select model',
                searchPlaceholder: 'Search models...',
                noMatch: 'No matching models',
                addInSettings: 'Please add models in settings'
            },
            pinnedFilesPanel: {
                title: 'Pinned Files',
                description: 'Pinned file contents will be sent to AI in every conversation',
                loading: 'Loading...',
                empty: 'No pinned files',
                notExists: 'Does not exist',
                dragHint: 'Hold Shift and drag text files from workspace here to add',
                dropHint: 'Release to add file'
            },
            skillsPanel: {
                title: 'Skills',
                description: 'Skills are user-defined knowledge modules. Check the box to make a skill visible to AI. AI loads skill content on demand via the read_skill tool.',
                loading: 'Loading...',
                empty: 'No skills available. Click the folder icon in the top right to open the directory. Create a folder containing a SKILL.md file to add a skill.',
                notExists: 'Does not exist',
                enableTooltip: 'Enable this skill in current conversation',
                hint: 'AI can load skill content on demand via read_skill tool when it determines the task matches a skill',
                openDirectory: 'Open Skills Directory',
                refresh: 'Refresh Skills list'
            },
            promptContext: {
                title: 'Prompt Context',
                description: 'These contents will be attached before your message in XML format to provide extra context for AI',
                empty: 'No context content',
                emptyHint: 'Drag files here, or click + to add custom text',
                addText: 'Add Custom Text',
                addFile: 'Add File Content',
                titlePlaceholder: 'Enter title...',
                contentPlaceholder: 'Enter content...',
                typeFile: 'File',
                typeText: 'Text',
                typeSnippet: 'Snippet',
                hint: 'Content will be sent to AI wrapped in <context> tags',
                dropHint: 'Release to add file content',
                fileAdded: 'Added file content: {path}',
                readFailed: 'Failed to read file',
                addFailed: 'Add failed: {error}'
            },
            filePicker: {
                title: 'Select File',
                subtitle: 'Type after @ to filter paths',
                loading: 'Searching...',
                empty: 'No matching files found',
                navigate: 'navigate',
                select: 'select',
                close: 'close',
                ctrlClickHint: 'Insert as @path text'
            },
            notifications: {
                summarizeFailed: 'Summarize failed: {error}',
                summarizeSuccess: 'Successfully summarized {count} messages',
                summarizeError: 'Summarize failed: {error}',
                checkpointCreated: 'Checkpoint created — you can restore this state anytime',
                checkpointCreateFailed: 'Failed to create checkpoint, please try again',
                checkpointCreateError: 'Failed to create checkpoint: {error}',
                holdShiftToDrag: 'Please hold Shift key to drag files',
                fileNotInWorkspace: 'File is not in workspace',
                fileNotInAnyWorkspace: 'File is not in any open workspace',
                fileInOtherWorkspace: 'File belongs to another workspace: {workspaceName}',
                fileAdded: 'Added pinned file: {path}',
                addFailed: 'Add failed: {error}',
                cannotGetFilePath: 'Cannot get file path, please drag from VSCode Explorer or tab',
                fileNotMatchOrNotInWorkspace: 'File is not in workspace or filename does not match',
                removeFailed: 'Remove failed: {error}'
            }
        },

        message: {
            roles: {
                user: 'User',
                tool: 'Tool',
                assistant: 'Assistant'
            },
            actions: {
                edit: 'Edit message',
                copy: 'Copy',
                retry: 'Regenerate',
                viewResponse: 'View response',
                branchFromHere: 'Branch from here',
                delete: 'Delete message'
            },
            branch: {
                previous: 'Previous candidate',
                next: 'Next candidate',
                candidateList: 'Candidate list',
                switchTo: 'Switch to this candidate',
                delete: 'Delete candidate',
                deleteConfirm: 'Click again to confirm deletion',
                active: 'Active',
                noPreview: '(no preview)',
                workspaceConfirmTitle: 'Switch Branch',
                workspaceConfirmMessage: 'This branch used write tools or has a workspace checkpoint. Restore the workspace together?',
                workspaceConfirmChatOnly: 'Chat only',
                workspaceConfirmChatAndWorkspace: 'Switch & restore workspace',
                workspaceConfirmCancel: 'Cancel'
            },
            branchTree: {
                open: 'View branch history',
                close: 'Close',
                title: 'Branch history',
                empty: 'No branches yet',
                nodeCount: '{count} nodes',
                navigationMode: 'Branch navigation',
                fullMode: 'Message graph',
                navigationHint: 'Collapse linear messages and focus on branch points',
                fullHint: 'Track-based full message graph: lanes follow concurrent candidate branches',
                collapsedMessages: '{count} linear messages collapsed',
                candidateCount: '{count} candidates',
                deleted: 'Deleted',
                system: 'System',
                restore: 'Restore',
                rename: 'Rename',
                renamePlaceholder: 'Enter a branch label…',
                save: 'Save',
                cancel: 'Cancel',
                expandAllMessages: 'Expand all messages',
                collapseLinearMessages: 'Collapse linear runs'
            },
            responseViewer: {
                commonMode: 'Common mode',
                advancedMode: 'Advanced mode',
                body: 'Response body',
                thought: 'Thought content',
                toolCalls: 'Tool calls',
                responseInfo: 'Response info',
                basicInfo: 'Basic info',
                parts: 'Parts',
                metadata: 'Metadata',
                attachments: 'Attachment summary',
                rawJson: 'Raw JSON',
                openRawJson: 'Open raw JSON',
                rawJsonHint: 'Only response-related structured data is kept here.',
                empty: 'No content available',
                noThought: 'No thought content',
                noTools: 'No tool calls',
                noParts: 'No parts data',
                noMetadata: 'No metadata',
                noAttachments: 'No attachments',
                id: 'ID',
                role: 'Role',
                timestamp: 'Time',
                backendIndex: 'Backend index',
                modelVersion: 'Model version',
                totalTokens: 'Total tokens',
                promptTokens: 'Input tokens',
                outputTokens: 'Output tokens',
                thoughtTokens: 'Thought tokens',
                thinkingDuration: 'Thinking duration',
                responseDuration: 'Response duration',
                streamDuration: 'Stream duration',
                chunkCount: 'Chunk count',
                tokenRate: 'Token rate',
                flags: 'Flags',
                functionResponseMessage: 'Function response message',
                summaryMessage: 'Summary message',
                model: 'Model',
                legacyTotalTokens: 'Legacy total tokens',
                latency: 'Latency',
                firstChunkTime: 'First chunk time',
                promptTokenDetails: 'Input token details',
                outputTokenDetails: 'Output token details',
                yes: 'Yes',
                no: 'No',
                name: 'Name',
                mimeType: 'MIME type',
                size: 'Size',
                fileUri: 'File URI',
                status: 'Status',
                duration: 'Duration',
                moreMetadata: 'More metadata',
                attachmentType: 'Attachment type',
                hasData: 'Has raw data',
                copyBody: 'Copy body',
                copySuccess: 'Response body copied',
                copyFailed: 'Failed to copy response body',
                pairedFunctionResponse: 'Paired function response',
                responseSource: 'Result source',
                sourceMessage: 'Source message',
                responseSources: {
                    tool: 'Tool result field',
                    partFunctionResponse: 'functionResponse in current message',
                    hiddenFunctionResponse: 'Hidden functionResponse message'
                },

                hasThumbnail: 'Has thumbnail',
                partTypes: {
                    text: 'Text',
                    thought: 'Thought',
                    functionCall: 'Function call',
                    functionResponse: 'Function response',
                    inlineData: 'Inline data',
                    fileData: 'File data',
                    unknown: 'Unknown'
                },
                toolStatuses: {
                    streaming: 'Generating',
                    queued: 'Queued',
                    awaitingApproval: 'Awaiting approval',
                    executing: 'Executing',
                    awaitingApply: 'Awaiting apply',
                    success: 'Success',
                    error: 'Error',
                    warning: 'Warning',
                    unknown: 'Unknown'
                }
            },
            emptyResponse: '(Empty response from model)',
            historyFolded: 'Earlier messages are folded ({count} discarded). Scroll up to load them.',
            stats: {
                ttft: 'Time to first token (TTFT)',
                responseDuration: 'Response Duration',
                tokenRate: 'Token Rate'
            },
            thought: {
                thinking: 'Thinking...',
                thoughtProcess: 'Thought Process',
                viewCollapsed: 'Collapse',
                viewMedium: 'Scroll view',
                viewExpanded: 'Expand all',
                trimmedHint: 'Content too long — showing only the latest part. Use expand-all to view the full text'
            },
            contextBlocks: {
                clickToView: 'Click to view full content'
            },
            summary: {
                title: 'Context Summary',
                compressed: 'Compressed {count} messages',
                deleteTitle: 'Delete Summary',
                restoreTitle: 'Restore Original (undo summary, resend compressed messages)',
                autoTriggered: 'Auto Triggered',
                compressionTokens: 'Replaced history → new summary (estimated {saved} tokens saved; actual context updates after the next response)',
                legacyRequestTokens: 'Legacy record: summarizer request input → output, not main-context before/after',
                historyTokenLabel: 'History',
                requestTokenLabel: 'Request',
                dividerMarker: 'Context summary truncation point: above this line is summarized history (original messages still viewable), below is the active content sent to the AI',
                dividerMarkerPrefix: 'Summary Cut',
                marker: 'Context Summary · {count} messages compressed',
                markerPrefix: 'Context Summary'
            },
            checkpoint: {
                userMessageBefore: 'Before User Message',
                userMessageAfter: 'After User Message',
                assistantMessageBefore: 'Before Assistant Message',
                assistantMessageAfter: 'After Assistant Message',
                toolBatchBefore: 'Before Tool Batch',
                toolBatchAfter: 'After Tool Batch',
                userMessageUnchanged: 'User Message · Unchanged',
                assistantMessageUnchanged: 'Assistant Message · Unchanged',
                toolBatchUnchanged: 'Tool Batch Completed · Unchanged',
                toolExecutionUnchanged: 'Tool Execution Completed · Unchanged',
                restoreTooltip: 'Restore workspace to this checkpoint',
                fileCount: '{count} files',
                yesterday: 'Yesterday',
                daysAgo: '{days} days ago',
                restoreConfirmTitle: 'Restore Checkpoint',
                restoreConfirmMessage: 'Are you sure you want to restore the workspace to this checkpoint? This will overwrite the corresponding files in your current workspace, and this action cannot be undone.',
                restoreConfirmBtn: 'Restore',
                restoreConfirmRetryTitle: 'Restore and Retry',
                restoreConfirmDeleteTitle: 'Restore and Delete',
                restoreConfirmEditTitle: 'Restore and Edit',
                restorePreviewFailed: 'Unable to preview restore, please try again later',
                restorePreviewFilesUpdated: '{count} files will be updated',
                restorePreviewFilesDeleted: '{count} files will be deleted',
                restorePreviewFilesUnchanged: '{count} files unchanged',
                restorePreviewNoChanges: 'Workspace already matches the checkpoint; no file changes',
                restorePreviewLegacy: 'Legacy checkpoint (no file manifest): restore will use backup contents and may overwrite workspace files; no files will be deleted',
                restoreDeleteListTitle: 'The following {count} files will be deleted:',
                restoreDeleteListMore: '...and {count} more files',
                restoreDeleteListEmpty: 'No files will be deleted by this restore',
                restoreDeleteUntrackedNote: 'Includes files created after the checkpoint was created (deleted after confirmation)',
                restoreUnbackedTip: 'These files were not backed up when the checkpoint was created (too large or unreadable), so they will not be touched: {paths}',
                restoreResultErrorTitle: 'Restore Failed',
                restoreResultPartialTitle: 'Restore Partially Completed',
                restoreResultWarningTitle: 'Unbacked Files Notice',
                restoreResultSuccessTitle: 'Restore Completed',
                restoreResultFailed: 'Failed to restore checkpoint',
                restoreResultPartial: 'Restore partially completed. The following files failed: {files}',
                restoreResultPartialMore: 'Restore partially completed. The following files failed: {files} and {count} more files',
                restoreResultUnbacked: 'The following files were not backed up when the checkpoint was created (too large or unreadable) and were not processed by this restore: {paths}',
                restoreResultUnbackedMore: 'The following files were not backed up when the checkpoint was created (too large or unreadable) and were not processed by this restore: {paths} and {count} more files',
                restoreResultSuccess: 'Workspace restored to checkpoint ({count} files)',
                restoreResultSuccessWithPrune: 'Workspace restored to checkpoint ({count} files); {pruned} old checkpoints were auto-pruned',
                restoreConversationChanged: 'Conversation switched; restore was cancelled',
                dirtyConfirmTitle: 'Unsaved Changes',
                dirtyConfirmMessage: 'Restoring will discard unsaved changes in {count} file(s). Continue?',
                dirtyConfirmDiscard: 'Discard changes & continue',
                dirtyConfirmCancel: 'Cancel',
                dirtyConfirmMore: '...and {count} more files'
            },
            continue: {
                title: 'Conversation Paused',
                description: 'Tool execution completed. You can send a new message or click "Continue" to let AI continue responding',
                button: 'Continue'
            },
            error: {
                title: 'Request Failed',
                retry: 'Retry',
                dismiss: 'Dismiss'
            },
            interrupt: {
                delivered: 'Delivered "{text}" — will be processed after the current round ends',
                deliverFailed: 'Message not delivered: {detail}'
            },
            tool: {
                parameters: 'Parameters',
                result: 'Result',
                error: 'Error',
                paramCount: '{count} parameters',
                streamingArgs: 'Generating arguments...',
                confirmExecution: 'Click to confirm execution',
                confirm: 'Confirm Execution',
                saveAll: 'Save All',
                rejectAll: 'Reject All',
                reject: 'Reject',
                confirmed: 'Confirmed',
                rejected: 'Rejected',
                viewDiff: 'View Diff',
                viewDiffInVSCode: 'View diff in VSCode',
                openDiffFailed: 'Failed to open diff preview',
                pendingDiffNotFound: 'Pending diff not found. Please retry after status sync.',
                acceptDiffFailed: 'Failed to accept diff. Please retry.',
                rejectDiffFailed: 'Failed to reject diff. Please retry.',
                openDetails: 'Open details',
                openSubAgentMonitorDetails: 'Open SubAgent Monitor details',
                todoWrite: {
                    label: 'TODO',
                    labelWithCount: 'TODO · {count}',
                    mergePrefix: 'Merge · ',
                    description: 'Pending {pending} · In Progress {inProgress} · Completed {completed}'
                },
                todoUpdate: {
                    label: 'TODO Update',
                    labelWithCount: 'TODO Update · {count}',
                    description: 'Add {add} · Status {setStatus} · Content {setContent} · Cancel {cancel} · Remove {remove}'
                },
                createPlan: {
                    label: 'Create Plan',
                    fallbackTitle: 'Plan'
                },
                updatePlan: {
                    label: 'Update Plan',
                    fallbackTitle: 'Plan'
                },
                createDesign: {
                    label: 'Create Design',
                    fallbackTitle: 'Design'
                },
                updateDesign: {
                    label: 'Update Design',
                    fallbackTitle: 'Design'
                },
                createProgress: {
                    label: 'Create Progress',
                    fallbackTitle: 'Project Progress'
                },
                updateProgress: {
                    label: 'Update Progress',
                    fallbackTitle: 'Project Progress'
                },
                validateProgressDocument: {
                    label: 'Validate Progress Document',
                    fallbackTitle: 'Progress Validation'
                },
                recordProgressMilestone: {
                    label: 'Record Progress Milestone',
                    fallbackTitle: 'Progress Milestone'
                },
                createReview: {
                    label: 'Create Review',
                    fallbackTitle: 'Review'
                },
                validateReviewDocument: {
                    label: 'Validate Review Document',
                    fallbackTitle: 'Review Validation'
                },
                finalizeReview: {
                    label: 'Finalize Review',
                    fallbackTitle: 'Review Conclusion'
                },
                recordReviewMilestone: {
                    label: 'Record Review Milestone',
                    fallbackTitle: 'Review Milestone'
                },
                reopenReview: {
                    label: 'Reopen Review',
                    fallbackTitle: 'Reopen Review'
                },
                compareReviewDocuments: {
                    label: 'Compare Review Documents',
                    fallbackTitle: 'Review Compare',
                    base: 'Base Review',
                    target: 'Target Review',
                    addedFindings: 'Added Findings',
                    removedFindings: 'Removed Findings',
                    persistedFindings: 'Persisted Findings',
                    severityChanged: 'Severity Changed',
                    trackingChanged: 'Tracking Changed'
                },
                todoPanel: {
                    title: 'TODO List',
                    modePlan: 'plan',
                    modeUpdate: 'update',
                    modeMerge: 'merge',
                    sourceCurrentInput: 'Current tool input',
                    sourceSnapshot: 'Snapshot at that time',
                    statusPending: 'Pending',
                    statusInProgress: 'In Progress',
                    statusCompleted: 'Completed',
                    statusCancelled: 'Cancelled',
                    totalItems: '{count} items',
                    copyAsMarkdown: 'Copy as Markdown',
                    copyMarkdown: 'Copy Markdown',
                    copied: 'Copied',
                    empty: 'No TODOs',
                    markdownCancelledSuffix: ' (cancelled)',
                    markdownInProgressSuffix: ' (in progress)',
                    copyFailed: 'Copy failed'
                },
                planCard: {
                    title: 'Plan',
                    executeLabel: 'Execute:',
                    executed: 'Executed',
                    executing: 'Executing...',
                    executePlan: 'Execute Plan',
                    openFile: 'Open File',
                    loadChannelsFailed: 'Failed to load channels',
                    loadModelsFailed: 'Failed to load models',
                    executePlanFailed: 'Failed to execute plan',
                    openFileFailed: 'Failed to open file',
                    promptPrefix: 'Please execute the following plan:\n\n{plan}',
                    sourceUpToDate: 'Source: up to date',
                    sourceUntracked: 'Source: untracked',
                    sourceMismatched: 'Source: changed',
                    sourceMissing: 'Source: missing',
                    sourceBlockedMismatched: 'The source document has changed. Please regenerate or revise the plan first.',
                    sourceBlockedMissing: 'The source document is missing or unreadable. Please revise the plan first.'
                },
                designCard: {
                    title: 'Design',
                    generateLabel: 'Plan:',
                    generated: 'Plan Generated',
                    generating: 'Generating Plan...',
                    generatePlan: 'Generate Plan',
                    openFile: 'Open File',
                    loadChannelsFailed: 'Failed to load channels',
                    loadModelsFailed: 'Failed to load models',
                    generatePlanFailed: 'Failed to generate plan',
                    openFileFailed: 'Failed to open file'
                },
                reviewCard: {
                    sourceCreate: 'Create',
                    sourceMilestone: 'Milestone',
                    sourceFinalize: 'Finalize',
                    sourceReopen: 'Reopen',
                    sourceValidate: 'Validate',
                    sourceCompare: 'Compare',
                    statusCompleted: 'Completed',
                    statusInProgress: 'In Progress',
                    decisionAccepted: 'Accepted',
                    decisionConditionallyAccepted: 'Conditionally Accepted',
                    decisionRejected: 'Rejected',
                    decisionNeedsFollowUp: 'Needs Follow-Up',
                    validationAutoUpgrade: 'Upgradeable Legacy Doc',
                    validationInvalid: 'Invalid',
                    validationWarning: 'Warnings',
                    validationValid: 'Valid',
                    issueError: 'Error',
                    issueWarning: 'Warning',
                    severityHigh: 'High',
                    severityMedium: 'Medium',
                    severityLow: 'Low',
                    milestonesChip: '{completed}/{total} milestones',
                    findingsChip: '{total} findings · H{high} M{medium} L{low}',
                    modulesChip: '{count} modules',
                    formatChip: 'Format {format}',
                    status: 'Status',
                    decision: 'Decision',
                    milestones: 'Milestones',
                    findings: 'Findings',
                    format: 'Format',
                    latestConclusion: 'Latest Conclusion',
                    recommendedNextAction: 'Recommended Next Action',
                    tracking: 'Tracking Status',
                    trackingOpen: 'Open',
                    trackingAcceptedRisk: 'Accepted Risk',
                    trackingFixed: 'Fixed',
                    trackingWontFix: "Won't Fix",
                    trackingDuplicate: 'Duplicate',
                    categoryHtml: 'HTML',
                    categoryCss: 'CSS',
                    categoryJavascript: 'JavaScript',
                    categoryAccessibility: 'Accessibility',
                    categoryPerformance: 'Performance',
                    categoryMaintainability: 'Maintainability',
                    categoryDocs: 'Docs',
                    categoryTest: 'Test',
                    categoryOther: 'Other',
                    evidence: 'Evidence',
                    findingDetails: 'Finding Details',
                    compareBase: 'Base Review',
                    compareTarget: 'Target Review',
                    compareAdded: 'Added Findings',
                    compareRemoved: 'Removed Findings',
                    comparePersisted: 'Persisted Findings',
                    compareSeverityChanged: 'Severity Changed',
                    compareTrackingChanged: 'Tracking Changed',
                    compareEvidenceChanged: 'Evidence Changed',
                    compareRelatedMilestonesChanged: 'Related Milestones Changed',
                    compareChanges: 'Changes',
                    changeSeverity: 'Severity',
                    changeTrackingStatus: 'Tracking Status',
                    changeTitle: 'Title',
                    changeDescription: 'Description',
                    changeRecommendation: 'Recommendation',
                    changeEvidence: 'Evidence',
                    changeRelatedMilestoneIds: 'Related Milestones',
                    validation: 'Validation',
                    progress: 'Progress',
                    modules: 'Reviewed Modules',
                    noIssues: 'No issues',
                    issueSummary: '{count} issues · {errors} errors · {warnings} warnings',
                    openFile: 'Open Document',
                    openFileFailed: 'Failed to open review document',
                    copyFailed: 'Failed to copy path',
                    copyPath: 'Copy Path',
                    copied: 'Copied',
                    rawResult: 'Full Result',
                    generatePlan: 'Generate Plan',
                    generatingPlan: 'Generating Plan...',
                    planGenerated: 'Plan Generated',
                    generatePlanFailed: 'Failed to generate plan'
                },
                progressCard: {
                    sourceCreate: 'Create',
                    sourceUpdate: 'Update',
                    sourceMilestone: 'Milestone',
                    sourceValidate: 'Validate',
                    defaultTitle: 'Project Progress',
                    validation: 'Validation',
                    validationInvalid: 'Invalid',
                    validationWarning: 'Warnings',
                    validationValid: 'Valid',
                    issueError: 'Error',
                    issueWarning: 'Warning',
                    issueSummary: '{count} issues · {errors} errors · {warnings} warnings',
                    status: 'Status',
                    phase: 'Phase',
                    statusActive: 'Active',
                    statusBlocked: 'Blocked',
                    statusCompleted: 'Completed',
                    statusArchived: 'Archived',
                    phaseDesign: 'Design',
                    phasePlan: 'Plan',
                    phaseImplementation: 'Implementation',
                    phaseReview: 'Review',
                    phaseMaintenance: 'Maintenance',
                    milestoneStatusCompleted: 'Completed',
                    milestoneStatusInProgress: 'In Progress',
                    currentFocus: 'Current Focus',
                    currentProgress: 'Current Progress',
                    latestConclusion: 'Latest Conclusion',
                    currentBlocker: 'Current Blocker',
                    nextAction: 'Next Action',
                    updatedAt: 'Updated At',
                    milestones: 'Milestones',
                    todos: 'TODOs',
                    activeRisks: 'Active Risks',
                    activeArtifacts: 'Related Artifacts',
                    activeDesign: 'Design',
                    activePlan: 'Plan',
                    activeReview: 'Review',
                    latestMilestone: 'Latest Milestone',
                    openFile: 'Open Document',
                    openFileFailed: 'Failed to open progress document',
                    copyFailed: 'Failed to copy path',
                    copyPath: 'Copy Path',
                    copied: 'Copied',
                    rawResult: 'Full Result'
                }
            },
            attachment: {
                clickToPreview: 'Click to preview',
                removeAttachment: 'Remove attachment'
            }
        },

        settings: {
            title: 'Settings',
            tabs: {
                channel: 'Channel',
                tools: 'Tools',
                autoExec: 'Auto Execute',
                mcp: 'MCP',
                subagents: 'Sub-Agents',
                checkpoint: 'Checkpoint',
                summarize: 'Summarize',
                imageGen: 'Image Generation',
                dependencies: 'Dependencies',
                context: 'Context',
                prompt: 'Prompt',
                tokenCount: 'Token Count',
                sound: 'Notification System',
                appearance: 'Appearance',
                memory: 'Memory',
                sandbox: 'Sandbox',
                general: 'General',
                usage: 'Usage Statistics'
            },
            channelSettings: {
                selector: {
                    placeholder: 'Select Config',
                    rename: 'Rename',
                    add: 'New Config',
                    delete: 'Delete Config',
                    inputPlaceholder: 'Enter config name',
                    confirm: 'Confirm',
                    cancel: 'Cancel'
                },
                empty: {
                    title: 'No channel configured',
                    hint: 'Create a channel and fill in your API Key to start chatting.',
                    create: 'New Channel'
                },
                dialog: {
                    new: {
                        title: 'New Configuration',
                        nameLabel: 'Config Name',
                        namePlaceholder: 'e.g.: My Gemini',
                        nameRequired: 'Please enter a config name',
                        typeLabel: 'API Type',
                        typePlaceholder: 'Select API type',
                        cancel: 'Cancel',
                        create: 'Create'
                    },
                    delete: {
                        title: 'Delete Configuration',
                        message: 'Are you sure you want to delete config "{name}"? This action cannot be undone.',
                        cancel: 'Cancel',
                        confirm: 'Confirm'
                    },
                    changeType: {
                        title: 'Change Channel Type',
                        message: 'Are you sure you want to change the channel type to "{name}"? Type-specific settings (model list, advanced options, etc.) will be reset to the defaults for the new type; the API Key and a custom API URL are kept, and common settings stay unchanged.'
                    }
                },
                form: {
                    apiUrl: {
                        label: 'API URL',
                        placeholder: 'Enter API URL',
                        placeholderResponses: 'Enter base API URL, e.g., https://api.openai.com/v1'
                    },
                    apiKey: {
                        label: 'API Key',
                        placeholder: 'Enter API Key',
                        show: 'Show',
                        hide: 'Hide',
                        useAuthorization: 'Send as Authorization format',
                        useAuthorizationHintGemini: 'Convert x-goog-api-key to Authorization: Bearer format',
                        useAuthorizationHintAnthropic: 'Convert x-api-key to Authorization: Bearer format'
                    },
                    stream: {
                        label: 'Stream Output'
                    },
                    channelType: {
                        label: 'Channel Type',
                        gemini: 'Gemini API',
                        openai: 'OpenAI API',
                        'openai-responses': 'OpenAI Responses API',
                        anthropic: 'Anthropic API',
                        changeHint: 'Changing the channel type resets type-specific settings (model list, advanced options, etc.) to defaults; the API Key and a custom API URL are kept, and common settings stay unchanged.'
                    },
                    toolMode: {
                        label: 'Tool Call Format',
                        placeholder: 'Select tool call format',
                        functionCall: {
                            label: 'Function Calling',
                            description: 'Use native function calling'
                        },
                        xml: {
                            label: 'XML Prompt',
                            description: 'Use XML format prompt'
                        },
                        json: {
                            label: 'JSON Boundary Markers',
                            description: 'Use JSON format + boundary markers'
                        },
                        hint: {
                            functionCall: 'Function Calling: Use API native function calling feature',
                            xml: 'XML Prompt: Convert tools to XML format in system prompt',
                            json: 'JSON Boundary Markers: Use JSON format + <<<TOOL_CALL>>> boundary markers'
                        },
                        openaiWarning: 'OpenAI Function Call mode does not support multimodal tools (such as read_file for reading images, generate_image, remove_background, crop_image, resize_image, rotate_image). To use multimodal features, please switch to XML or JSON mode.'
                    },
                    multimodal: {
                        label: 'Enable Multimodal Tools',
                        supportedTypes: 'Supported file types:',
                        image: 'Image',
                        imageFormats: 'PNG, JPEG, WebP',
                        document: 'Document',
                        documentFormats: 'PDF',
                        capabilities: 'Multimodal Tool Capabilities:',
                        table: {
                            channel: 'Channel / Mode',
                            readImage: 'Read Image',
                            readDocument: 'Read Document',
                            generateImage: 'Generate Image',
                            historyMultimodal: 'History Multimodal'
                        },
                        channels: {
                            geminiAll: 'Gemini (All)',
                            anthropicAll: 'Anthropic (All)',
                            openaiXmlJson: 'OpenAI (XML/JSON)',
                            openaiResponses: 'OpenAI (Responses)',
                            openaiFunction: 'OpenAI (Function Call)'
                        },
                        legend: {
                            supported: 'Supported',
                            notSupported: 'Not Supported'
                        },
                        notes: {
                            requireEnable: 'This option must be enabled to use multimodal tools like read_file for images/documents, generate_image, remove_background, crop_image, resize_image, rotate_image',
                            userAttachment: 'User-submitted attachments are not affected by this config and are always processed according to channel native capabilities',
                            geminiAnthropic: 'Gemini / Anthropic: Tools can directly return images and documents, support image generation',
                            openaiResponses: 'OpenAI Responses: Native support for images/PDFs, supports real-time thinking display',
                            openaiXmlJson: 'OpenAI XML/JSON: Supports reading images and generating images, does not support documents'
                        }
                    },
                    strictTools: {
                        label: 'Enable Strict Tool Use',
                        hint: 'When enabled, the API enforces model output to strictly conform to parameter schemas, eliminating type errors and missing fields. Requires Anthropic or OpenAI channel support. Proxies may not be compatible. Gemini does not support this feature.',
                        support: {
                            anthropic: 'Anthropic: Auto-injects beta header, max 20 strict tools',
                            openai: 'OpenAI: Requires all params required + additionalProperties: false',
                            openaiResponses: 'OpenAI Responses: Strict is enabled by default',
                            gemini: 'Gemini: Not supported'
                        }
                    },
                    timeout: {
                        label: 'Timeout (ms)',
                        placeholder: '30000'
                    },
                    maxContextTokens: {
                        label: 'Max Context Tokens',
                        placeholder: '128000',
                        hint: 'Upper limit for displaying context usage'
                    },
                    contextManagement: {
                        title: 'Context Management',
                        enableTitle: 'Enable context management',
                        threshold: {
                            label: 'Context Threshold',
                            placeholder: '80% or 100000',
                            hint: 'When total tokens exceed this threshold, summarize older content first and preserve historical user inputs verbatim. If summarization fails, apply tool-pair-safe granular trimming to this request only.'
                        },
                        extraCut: {
                            label: 'Extra Cut',
                            placeholder: '0 or 10%',
                            hint: 'Extra tokens to cut when trimming. Actual reserve = threshold - extra cut. Supports percentage or absolute value, defaults to 0'
                        },
                        autoSummarize: {
                            label: 'Auto Summarize',
                            enableTitle: 'Enable auto summarize',
                            hint: 'When enabled, automatically summarize old turns when context exceeds threshold (mutually exclusive with context trimming)'
                        },
                        mode: {
                            label: 'Management Mode',
                            hint: 'Model summarization comes first, with safe boundaries inside long tool turns. On failure, use non-persistent granular trimming instead of discarding entire user turns.',
                            trim: 'Legacy Context Trimming',
                            summarize: 'Smart Summary & Safe Trimming'
                        }
                    },
                    toolOptions: {
                        title: 'Tool Configuration'
                    },
                    advancedOptions: {
                        title: 'Advanced Options'
                    },
                    customBody: {
                        title: 'Custom Body',
                        enableTitle: 'Enable custom body'
                    },
                    customHeaders: {
                        title: 'Custom Headers',
                        enableTitle: 'Enable custom headers'
                    },
                    autoRetry: {
                        title: 'Auto Retry',
                        enableTitle: 'Enable auto retry',
                        retryCount: {
                            label: 'Retry Count',
                            hint: 'Maximum retry attempts when API returns error (1-10)'
                        },
                        retryInterval: {
                            label: 'Retry Interval (ms)',
                            hint: 'Wait time between each retry (1000-60000 milliseconds)'
                        }
                    },
                    enabled: {
                        label: 'Enable this configuration'
                    }
                }
            },
            tools: {
                title: 'Tools Settings',
                description: 'Manage and configure available tools',
                enableAll: 'Enable All',
                disableAll: 'Disable All',
                toolName: 'Tool Name',
                toolDescription: 'Tool Description',
                toolEnabled: 'Enabled'
            },
            autoExec: {
                title: 'Auto Execute',
                intro: {
                    title: 'Tool Execution Confirmation',
                    description: 'Configure whether user confirmation is required when AI calls tools. Checked means auto execute (no confirmation needed), unchecked means confirmation required before execution.'
                },
                actions: {
                    refresh: 'Refresh',
                    enableAll: 'Auto Execute All',
                    disableAll: 'Confirm All'
                },
                status: {
                    loading: 'Loading tools list...',
                    empty: 'No tools available',
                    autoExecute: 'Auto Execute',
                    needConfirm: 'Need Confirm'
                },
                categories: {
                    file: 'File Operations',
                    search: 'Search',
                    terminal: 'Terminal',
                    lsp: 'Code Intelligence',
                    media: 'Media Processing',
                    plan: 'Plan',
                    mcp: 'MCP Tools',
                    todo: 'TODO',
                    history: 'History',
                    memory: 'Memory',
                    review: 'Review',
                    progress: 'Progress',
                    skills: 'Skills',
                    design: 'Design',
                    notification: 'Notifications',
                    agents: 'Agents',
                    activity: 'Usage Time',
                    sandbox: 'Sandbox',
                    other: 'Other'
                },
                badges: {
                    dangerous: 'Dangerous'
                },
                diffReview: {
                    label: 'Managed by Diff review',
                    tooltip: 'Changes from this tool are confirmed through the Diff review flow instead of the in-chat confirmation dialog. Configure auto-apply in "Tools Settings → Apply Diff → Auto Apply".',
                    autoApprove: 'Auto Approve',
                    autoApproveTooltip: 'When enabled, diffs from this tool are applied automatically after the delay configured in the Apply Diff settings (write_file / apply_diff / insert_code / delete_code share this single switch).',
                    statusAutoApprove: 'Auto Approve',
                    statusNeedConfirm: 'Needs Confirmation'
                },
                tips: {
                    diffReviewNote: '• Write tools (write_file / apply_diff / insert_code / delete_code) are confirmed via Diff review: enable "Auto Apply" in the Apply Diff tool settings to make them fully automatic — no checkbox needed on this page',
                    dangerousDefault: '• Tools marked as "Dangerous" require user confirmation by default before execution',
                    deleteFileWarning: '• delete_file: File deletion is irreversible, recommend keeping confirmation enabled',
                    executeCommandWarning: '• execute_command: Executing terminal commands may affect the system',
                    mcpToolsDefault: '• MCP Tools: From connected MCP servers, auto execute by default',
                    useWithCheckpoint: '• Recommend using with checkpoint feature to restore in case of mistakes'
                }
            },
            mcp: {
                title: 'MCP Settings',
                description: 'Configure Model Context Protocol servers',
                addServer: 'Add Server',
                serverName: 'Server Name',
                serverCommand: 'Command',
                serverArgs: 'Arguments',
                serverEnv: 'Environment Variables',
                serverStatus: 'Server Status',
                connecting: 'Connecting',
                connected: 'Connected',
                disconnected: 'Disconnected',
                error: 'Error'
            },
            checkpoint: {
                title: 'Checkpoint Settings',
                loading: 'Loading config...',
                loadError: 'Failed to load checkpoint configuration. Settings are disabled to avoid overwriting the existing configuration.',
                loadRetry: 'Retry',
                sections: {
                    enable: {
                        label: 'Enable Checkpoint Feature',
                        description: 'Automatically create codebase snapshots before and after tool execution, supporting one-click rollback'
                    },
                    messages: {
                        title: 'Message Type Checkpoints',
                        description: 'Choose whether to create checkpoints for user and model messages (independent of tool calls)',
                        beforeLabel: 'Before Message',
                        afterLabel: 'After Message',
                        types: {
                            user: {
                                name: 'User Message',
                                description: 'Messages sent by user'
                            },
                            model: {
                                name: 'Model Message',
                                description: 'Messages replied by model (excluding tool calls)'
                            }
                        },
                        options: {
                            modelOuterLayerOnly: {
                                label: 'When tools are called continuously, only create model message checkpoints at outermost layer',
                                hint: 'When enabled, "before message" checkpoint is only created in first iteration, "after message" checkpoint is only created in last iteration (no tool calls). When disabled, checkpoints are created in every iteration.'
                            },
                            mergeUnchanged: {
                                label: 'Merge checkpoints when content is unchanged before and after messages',
                                hint: 'When enabled, if checkpoint content is the same before and after message, they will be merged and displayed as a single "unchanged" checkpoint. When disabled, before/after checkpoints will always be displayed separately.'
                            }
                        }
                    },
                    tools: {
                        title: 'Tool Backup Configuration',
                        description: 'Select tools that need backups before and after execution',
                        beforeLabel: 'Before Execution',
                        afterLabel: 'After Execution',
                        empty: 'No tools available'
                    },
                    other: {
                        title: 'Other Configuration',
                        maxCheckpoints: {
                            label: 'Maximum Checkpoints',
                            placeholder: '-1',
                            hint: 'Automatically clean up old checkpoints when exceeding this number, -1 means unlimited'
                        }
                    },
                    exclusion: {
                        title: 'Exclusion Configuration',
                        description: 'Control which files are excluded from checkpoints. Default exclusion categories can be toggled individually; excluded files are not backed up but the reason is recorded. Click "Preview Exclusions" to inspect.',
                        patterns: 'patterns',
                        patternsAdd: 'Add',
                        profiles: {
                            logs: 'Log Files',
                            aiModels: 'AI/ML Model Weights',
                            datasets: 'Datasets',
                            caches: 'Caches',
                            pythonVenvs: 'Python Virtual Environments',
                            buildArtifacts: 'Build Artifacts',
                            largeMedia: 'Large Media Files',
                            archives: 'Archives & Binaries'
                        },
                        maxFileSize: {
                            label: 'Max Single File Size (MiB)',
                            hint: 'Files larger than this are excluded from checkpoints (0 = unlimited, default 50)',
                            invalid: 'Enter a valid number (MiB, 0 = unlimited)'
                        },
                        customPatterns: {
                            label: 'Custom Exclusion Patterns',
                            hint: 'One gitignore pattern per line. A leading ! re-includes default categories but cannot override forced exclusions (.git / node_modules / extension storage)',
                            reincludeHint: 'Note: for directory-based default categories (e.g. data/, dist/), re-including files under them requires negating the directory itself, e.g. !data/ + !data/keep.txt',
                            placeholder: '*.log\ngenerated/\n!important/model.gguf',
                            empty: 'No custom patterns yet. Type a pattern and press Enter to add.'
                        },
                        profilePatterns: {
                            edit: 'Edit Patterns',
                            save: 'Save',
                            cancel: 'Cancel',
                            hint: 'Override this category\'s default exclusion patterns; clear and save to restore defaults',
                            placeholder: 'One gitignore pattern per line',
                            empty: 'Using this category\'s default patterns; saving an empty list restores defaults',
                            clear: 'Clear (restore defaults)'
                        },
                        preview: {
                            button: 'Preview Exclusions',
                            loading: 'Scanning...',
                            failed: 'Preview failed, please retry',
                            total: '{count} files/directories excluded, about {size}',
                            partial: ' (some directories are too large; size stats may be incomplete)',
                            empty: 'Nothing is excluded with the current configuration',
                            count: '{count} items',
                            rule: 'Rule',
                            source: 'Source',
                            other: 'Other (.gitignore / custom / size limit, etc.)',
                            noSamples: 'No samples',
                            reasons: {
                                forced: 'Forced',
                                default: 'Default category',
                                gitignore: '.gitignore',
                                custom: 'Custom',
                                size: 'Size limit',
                                unreadable: 'Unreadable'
                            }
                        }
                    },
                    cleanup: {
                        title: 'Cleanup Checkpoints',
                        description: 'Manage and clean up checkpoints in batch to free up storage',
                        searchPlaceholder: 'Search conversation title...',
                        loading: 'Loading...',
                        noMatch: 'No matching conversations found',
                        noCheckpoints: 'No checkpoints',
                        refresh: 'Refresh List',
                        checkpointCount: '{count} checkpoints',
                        selectAll: 'Select All',
                        selectedCount: '{count} selected',
                        selectedSize: 'Total {size}',
                        totalSize: 'Total {size}',
                        deleteSelected: 'Delete Selected',
                        noCheckpointsInConversation: 'No checkpoints in this conversation',
                        checkpointFiles: '{count} files',
                        phaseBefore: 'Before',
                        phaseAfter: 'After',
                        typeFull: 'Full',
                        typeIncremental: 'Incremental',
                        toolUserMessage: 'User Message',
                        toolModelMessage: 'Model Message',
                        toolBatch: 'Batch Tool Calls',
                        confirmDelete: {
                            title: 'Confirm Deletion',
                            conversationsMessage: 'Are you sure you want to delete all checkpoints in the selected {count} conversation(s)?',
                            checkpointsMessage: 'Are you sure you want to delete the selected {count} checkpoint(s)?',
                            stats: 'Will delete {count} checkpoints, freeing {size} storage',
                            warning: 'This operation cannot be undone',
                            cancel: 'Cancel',
                            delete: 'Delete'
                        },
                        rejectedByDependency: '{count} checkpoints kept because later checkpoints depend on them',
                        deleteFailedCount: '{count} checkpoints failed to delete',
                        deleteRequestFailed: 'Delete request failed, please retry',
                        unbackedFiles: '{count} files not backed up',
                        sizeIncomplete: 'Partially counted',
                        sizeIncompleteHint: 'Some legacy checkpoints lack size records; total size only covers counted items',
                        manifestDetail: 'Exclusion Details',
                        manifestLoadFailed: 'Failed to load exclusion manifest',
                        manifestUnavailable: 'This checkpoint is in legacy format; no exclusion manifest is available',
                        manifestExcludedCount: 'Excluded files',
                        manifestNote: 'This checkpoint excluded {count} files using the exclusion rules at creation time',
                        manifestRulesChanged: 'Current exclusion rules have changed; restore will follow current rules',
                        manifestIgnoreSnapshot: 'Exclusion Rules Snapshot',
                        manifestRuleVersion: 'Rules version',
                        manifestForcedRulesVersion: 'Forced rules version',
                        manifestDefaultProfileVersion: 'Default profiles version',
                        manifestMaxFileSize: 'Max file size',
                        manifestEnabledProfiles: 'Enabled exclusion profiles',
                        manifestCustomPatterns: 'Custom exclusion patterns',
                        manifestNone: 'None',
                        manifestClose: 'Close',
                        progress: {
                            pending: 'Pending',
                            scanning: 'Scanning',
                            copying: 'Backing up',
                            cleaning: 'Cleaning up',
                            preparing: 'Preparing',
                            restoring: 'Restoring',
                            deleting: 'Deleting',
                            done: 'Done',
                            failed: 'Failed',
                            cancelled: 'Cancelled',
                            cancel: 'Cancel',
                            cancelFailed: 'Cancel failed, please retry',
                            stale: 'Operation has not made progress for a long time and may be stuck; try cancelling or refreshing the settings page'
                        },
                        timeFormat: {
                            justNow: 'Just now',
                            minutesAgo: '{count} minutes ago',
                            hoursAgo: '{count} hours ago',
                            daysAgo: '{count} days ago'
                        }
                    },
                    branchCleanup: {
                        title: 'Branch Cleanup',
                        description: 'Manage soft-deleted branch candidates to free up storage. Deleted branches can be kept for a retention period before automatic cleanup, or cleaned up manually in one click.',
                        deletedCountLabel: 'Deleted Branches',
                        deletedCountValue: '{count} across {conversations} conversation(s)',
                        deletedCountEmpty: 'No deleted branches',
                        countLoadFailed: 'Failed to load deleted branch count',
                        pruneButton: 'Clean Up Expired Soft-Deletes',
                        pruneLoading: 'Cleaning...',
                        pruneSuccess: 'Cleaned up {count} expired branch node(s)',
                        pruneFailed: 'Cleanup failed: {message}',
                        pruneSkipped: 'Branch data in {count} conversation(s) was not cleaned up (conversation no longer exists)',
                        retention: {
                            label: 'Soft-Delete Retention (days)',
                            hint: 'Deleted branches are auto-cleaned after this many days; enter 0 to never auto-clean (manual cleanup only)',
                            invalid: 'Enter a non-negative integer (0 = never auto-clean)',
                            save: 'Save'
                        }
                    }
                }
            },
            summarize: {
                title: 'Context Summarize',
                description: 'Compress conversation history to reduce token usage',
                enableSummarize: 'Enable Summarize',
                tokenThreshold: 'Token Threshold',
                summaryModel: 'Summary Model',
                summaryPrompt: 'Summary Prompt'
            },
            imageGen: {
                title: 'Image Generation',
                description: 'Configure AI image generation tool',
                enableImageGen: 'Enable Image Generation',
                provider: 'Provider',
                model: 'Model',
                outputPath: 'Output Path',
                maxImages: 'Max Images'
            },
            dependencies: {
                title: 'Extension Dependencies',
                description: 'Manage dependencies for optional features',
                installed: 'Installed',
                notInstalled: 'Not Installed',
                installing: 'Installing',
                installFailed: 'Install Failed',
                install: 'Install',
                uninstall: 'Uninstall',
                required: 'Required',
                optional: 'Optional'
            },
            context: {
                title: 'Context Awareness',
                description: 'Configure workspace context sent to AI',
                includeFileTree: 'Include File Tree',
                includeOpenFiles: 'Include Open Files',
                includeSelection: 'Include Selection',
                maxDepth: 'Max Depth',
                excludePatterns: 'Exclude Patterns',
                pinnedFiles: 'Pinned Files',
                addPinnedFile: 'Add Pinned File'
            },
            prompt: {
                title: 'System Prompt',
                description: 'Customize system prompt structure and content',
                systemPrompt: 'System Prompt',
                customPrompt: 'Custom Prompt',
                templateVariables: 'Template Variables',
                preview: 'Preview',
                sections: {
                    environment: 'Environment',
                    tools: 'Tools',
                    context: 'Context',
                    instructions: 'Instructions'
                }
            },
            general: {
                title: 'General Settings',
                description: 'Basic configuration options',
                proxy: {
                    title: 'Network Proxy',
                    description: 'Configure HTTP proxy for API requests',
                    enable: 'Enable Proxy',
                    url: 'Proxy URL',
                    urlPlaceholder: 'http://127.0.0.1:7890',
                    urlError: 'Please enter a valid proxy address (http:// or https://)'
                },
                language: {
                    title: 'Interface Language',
                    description: 'Choose interface display language',
                    auto: 'Follow System',
                    autoDescription: 'Automatically follow VS Code language setting',
                    followSystem: 'Follow system'
                },
            },
            contextSettings: {
                loading: 'Loading...',
                workspaceFiles: {
                    title: 'Workspace File Tree',
                    description: 'Send workspace directory structure to AI',
                    sendFileTree: 'Send workspace file tree',
                    maxDepth: 'Max Depth',
                    unlimitedHint: '-1 means unlimited'
                },
                openTabs: {
                    title: 'Open Tabs',
                    description: 'Send current open file list to AI',
                    sendOpenTabs: 'Send open tabs',
                    maxCount: 'Max Count'
                },
                activeEditor: {
                    title: 'Current Active Editor',
                    description: 'Send currently editing file path to AI',
                    sendActiveEditor: 'Send current active editor path'
                },
                diagnostics: {
                    title: 'Diagnostics',
                    description: 'Send workspace errors, warnings, and other diagnostics to AI to help fix code issues',
                    enableDiagnostics: 'Enable diagnostics',
                    severityTypes: 'Problem types',
                    severity: {
                        error: 'Error',
                        warning: 'Warning',
                        information: 'Info',
                        hint: 'Hint'
                    },
                    workspaceOnly: 'Workspace files only',
                    openFilesOnly: 'Open files only',
                    maxPerFile: 'Max per file',
                    maxFiles: 'Max files'
                },
                ignorePatterns: {
                    title: 'Ignore Patterns',
                    description: 'Matching files/folders will not appear in context (supports wildcards)',
                    removeTooltip: 'Remove',
                    emptyHint: 'No custom ignore patterns',
                    inputPlaceholder: 'Enter pattern, e.g.: **/node_modules, *.log',
                    addButton: 'Add',
                    helpTitle: 'Wildcard Help:',
                    helpItems: {
                        wildcard: '* - Matches any character (excludes path separator)',
                        recursive: '** - Matches any directory level',
                        examples: 'e.g.: **/node_modules, *.log, .git'
                    }
                },
                preview: {
                    title: 'Current Status Preview',
                    autoRefreshBadge: 'Live Update',
                    description: 'Preview context information to be sent to AI (auto-refresh every 2 seconds)',
                    activeEditorLabel: 'Current Active Editor:',
                    openTabsLabel: 'Open Tabs ({count}):',
                    noValue: 'None',
                    moreItems: '... {count} more'
                },
                saveSuccess: 'Saved successfully',
                saveFailed: 'Save failed'
            },
            dependencySettings: {
                title: 'Extension Dependency Management',
                description: 'Manage dependencies required for optional extension features. These dependencies will be installed to the local file system and not packaged into the plugin.',
                installPath: 'Install Path:',
                installed: 'Installed',
                installing: 'Installing...',
                uninstalling: 'Uninstalling...',
                install: 'Install',
                uninstall: 'Uninstall',
                estimatedSize: 'About {size}MB',
                empty: 'No tools requiring dependencies',
                progress: {
                    processing: 'Processing {dependency}...',
                    complete: '{dependency} processing complete',
                    failed: '{dependency} processing failed',
                    installSuccess: '{name} installed successfully!',
                    installFailed: '{name} installation failed',
                    uninstallSuccess: '{name} uninstalled',
                    uninstallFailed: '{name} uninstallation failed',
                    unknownError: 'Unknown error'
                },
                panel: {
                    installedCount: '{installed}/{total}'
                }
            },
            generateImageSettings: {
                description: 'The image generation tool allows AI to call the image generation model to create images. Generated images will be saved to the workspace and returned to AI for viewing in multimodal form.',
                api: {
                    title: 'API Configuration',
                    url: 'API URL',
                    urlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
                    urlHint: 'Base URL for image generation API',
                    apiKey: 'API Key',
                    apiKeyPlaceholder: 'Enter API Key',
                    apiKeyHint: 'Secret key for image generation API',
                    model: 'Model Name',
                    modelPlaceholder: 'gemini-3-pro-Image-preview',
                    modelHint: 'e.g.: gemini-3-pro-Image-preview',
                    show: 'Show',
                    hide: 'Hide'
                },
                aspectRatio: {
                    title: 'Aspect Ratio Parameters',
                    enable: 'Enable aspect ratio parameters',
                    fixedRatio: 'Fixed Aspect Ratio',
                    placeholder: 'Not fixed (AI can choose)',
                    options: {
                        auto: 'Auto',
                        square: 'Square',
                        landscape: 'Landscape',
                        portrait: 'Portrait',
                        mobilePortrait: 'Mobile Portrait',
                        widescreen: 'Widescreen',
                        ultrawide: 'Ultra-wide'
                    },
                    hints: {
                        disabled: 'When disabled: AI cannot configure this parameter, API call will not include this parameter',
                        fixed: 'Fixed: AI will be told to fix at {ratio}, cannot change',
                        flexible: 'Not fixed: AI can choose using aspect_ratio parameter'
                    }
                },
                imageSize: {
                    title: 'Image Size Parameters',
                    enable: 'Enable image size parameters',
                    fixedSize: 'Fixed Image Size',
                    placeholder: 'Not fixed (AI can choose)',
                    options: {
                        auto: 'Auto'
                    },
                    hints: {
                        disabled: 'When disabled: AI cannot configure this parameter, API call will not include this parameter',
                        fixed: 'Fixed: AI will be told to fix at {size}, cannot change',
                        flexible: 'Not fixed: AI can choose using image_size parameter'
                    }
                },
                batch: {
                    title: 'Batch Generation Limits',
                    maxTasks: 'Max Batch Tasks',
                    maxTasksHint: 'Maximum number of tasks (images with different prompts) allowed per AI call. Range 1-20.',
                    maxImagesPerTask: 'Max Images Per Task',
                    maxImagesPerTaskHint: 'Maximum number of images saved per task (single prompt). Range 1-10.',
                    summary: 'Current config: AI can initiate up to {maxTasks} tasks per call, with up to {maxImages} images saved per task'
                },
                usage: {
                    title: 'Usage Instructions',
                    step1: 'Configure API URL, API Key, and model name above',
                    step2: 'Ensure the tool is enabled in "Tool Settings"',
                    step3: 'Have AI call the generate_image tool in conversation to create images',
                    step4: 'Generated images will be saved to the generated_images directory in the workspace',
                    warning: 'Please configure API Key before using image generation feature'
                }
            },
            mcpSettings: {
                toolbar: {
                    addServer: 'Add Server',
                    editJson: 'Edit JSON',
                    refresh: 'Refresh'
                },
                loading: 'Loading...',
                empty: {
                    title: 'No MCP Servers',
                    description: 'Click "Add Server" button to configure your first MCP server'
                },
                serverCard: {
                    connect: 'Connect',
                    disconnect: 'Disconnect',
                    connecting: 'Connecting...',
                    edit: 'Edit',
                    delete: 'Delete',
                    tools: 'Tools',
                    resources: 'Resources',
                    prompts: 'Prompts'
                },
                status: {
                    connected: 'Connected',
                    connecting: 'Connecting...',
                    error: 'Connection Error',
                    disconnected: 'Disconnected'
                },
                form: {
                    addTitle: 'Add MCP Server',
                    editTitle: 'Edit MCP Server',
                    serverId: 'Server ID',
                    serverIdPlaceholder: 'Optional, leave blank to auto-generate',
                    serverIdHint: 'Can only contain letters, numbers, underscores and hyphens, used to identify server in JSON config',
                    serverIdError: 'ID can only contain letters, numbers, underscores and hyphens',
                    serverName: 'Server Name',
                    serverNamePlaceholder: 'e.g.: My MCP Server',
                    description: 'Description',
                    descriptionPlaceholder: 'Optional description',
                    required: '*',
                    transportType: 'Transport Type',
                    command: 'Command',
                    commandPlaceholder: 'e.g.: npx, python, node',
                    args: 'Arguments',
                    argsPlaceholder: 'Space separated, e.g.: -m mcp_server',
                    env: 'Environment Variables (JSON)',
                    envPlaceholder: '{"KEY": "value"}',
                    url: 'URL',
                    urlPlaceholderSse: 'https://example.com/sse',
                    urlPlaceholderHttp: 'https://example.com/mcp',
                    headers: 'Headers (JSON)',
                    headersPlaceholder: '{"Authorization": "Bearer token"}',
                    options: 'Options',
                    enabled: 'Enabled',
                    autoConnect: 'Auto Connect',
                    cleanSchema: 'Clean Schema',
                    cleanSchemaHint: 'Remove incompatible fields from JSON Schema (e.g. $schema, additionalProperties), required for some APIs (e.g. Gemini)',
                    timeout: 'Connection Timeout (ms)',
                    cancel: 'Cancel',
                    create: 'Create',
                    save: 'Save'
                },
                validation: {
                    nameRequired: 'Please enter server name',
                    idInvalid: 'ID is invalid',
                    idChecking: 'Validating ID, please wait',
                    commandRequired: 'Please enter command',
                    urlRequired: 'Please enter URL',
                    invalidJson: 'Enter a valid JSON object',
                    createFailed: 'Create failed',
                    updateFailed: 'Update failed'
                },
                delete: {
                    title: 'Delete MCP Server',
                    message: 'Are you sure you want to delete server "{name}"? This action cannot be undone.',
                    confirm: 'Delete',
                    cancel: 'Cancel'
                }
            },
            subagents: {
                selectAgent: 'Select Sub-Agent',
                noAgents: 'No sub-agents',
                create: 'Create',
                rename: 'Rename',
                delete: 'Delete',
                disabled: 'Disabled',
                enabled: 'Enable this sub-agent',
                saveFailed: 'Save failed: {error}',
                globalConfig: 'Global Configuration',
                maxConcurrentAgents: 'Max Concurrent Agents',
                maxConcurrentAgentsHint: 'Maximum number of sub-agents running at the same time; extra ones wait in a queue (-1 for unlimited)',
                defaultMaxIterations: 'Default Max Iterations',
                defaultMaxIterationsHint: 'Default iteration limit for sub-agents and General Worker without their own setting (1~200, -1 for unlimited)',
                generalWorker: 'Enable General Worker (easy mode)',
                generalWorkerHint: 'Lets the main model dispatch zero-config "General Worker" agents that inherit the current channel and full tool permissions; the model decides how many to use, no manual agent setup needed',
                basicInfo: 'Basic Info',
                description: 'Description',
                descriptionPlaceholder: 'Describe when the main AI should use this sub-agent',
                maxIterations: 'Max Iterations',
                maxIterationsHint: 'Maximum tool call rounds for this sub-agent (-1 for unlimited)',
                maxRuntime: 'Max Runtime',
                maxRuntimeHint: 'Maximum runtime in seconds (-1 for unlimited)',
                systemPrompt: 'System Prompt',
                systemPromptPlaceholder: 'Enter the sub-agent system prompt...',
                channelModel: 'Channel & Model',
                channel: 'Channel',
                selectChannel: 'Select Channel',
                model: 'Model',
                selectModel: 'Select Model',
                tools: 'Tool Configuration',
                toolsDescription: 'Configure tools available to this sub-agent',
                toolMode: {
                    label: 'Tool Mode',
                    all: 'All Tools',
                    builtin: 'Built-in Only',
                    mcp: 'MCP Only',
                    whitelist: 'Whitelist',
                    blacklist: 'Blacklist'
                },
                noTools: 'No tools available',
                whitelistHint: 'Checked tools will be allowed',
                blacklistHint: 'Checked tools will be blocked',
                emptyState: 'No sub-agents yet, click the button below to create one',
                createFirst: 'Create Sub-Agent',
                deleteConfirm: {
                    title: 'Delete Sub-Agent',
                    message: 'Are you sure you want to delete this sub-agent? This action cannot be undone.'
                },
                createDialog: {
                    title: 'Create Sub-Agent',
                    nameLabel: 'Name',
                    namePlaceholder: 'e.g., Code Review Expert',
                    nameRequired: 'Please enter a name for the sub-agent',
                    nameDuplicate: 'A sub-agent with this name already exists',
                    templateLabel: 'Template'
                },
                presets: {
                    blank: {
                        name: 'Blank',
                        description: 'Configure a sub-agent from scratch'
                    },
                    codeReviewer: {
                        name: 'Code Reviewer',
                        description: 'Read-only review of code in a given scope with structured findings; never modifies files'
                    },
                    deepResearcher: {
                        name: 'Deep Researcher',
                        description: 'In-depth investigation of the codebase and external resources, returning a sourced research report'
                    },
                    parallelEditor: {
                        name: 'Parallel Editor',
                        description: 'Applies and verifies code changes within an assigned scope; designed for parallel editing'
                    },
                    webSearcher: {
                        name: 'Web Searcher',
                        description: 'Searches the web via MCP tools only, returning summaries with source links'
                    }
                }
            },
            modelManager: {
                title: 'Model List',
                fetchModels: 'Fetch Models',
                clearAll: 'Clear All',
                clearAllTooltip: 'Clear all models',
                empty: 'No models, please click "Fetch Models" or add manually',
                addPlaceholder: 'Manually enter model ID',
                addTooltip: 'Add',
                removeTooltip: 'Remove',
                enabledTooltip: 'Currently enabled model',
                filterPlaceholder: 'Filter models...',
                clearFilter: 'Clear filter',
                noResults: 'No matching models',
                clearDialog: {
                    title: 'Clear All Models',
                    message: 'Are you sure you want to clear all {count} models? This action cannot be undone.',
                    confirm: 'Clear',
                    cancel: 'Cancel'
                },
                errors: {
                    addFailed: 'Failed to add model',
                    removeFailed: 'Failed to remove model',
                    setActiveFailed: 'Failed to set active model'
                }
            },
            modelSelectionDialog: {
                title: 'Select Models to Add',
                selectAll: 'Select All',
                deselectAll: 'Deselect All',
                close: 'Close',
                loading: 'Loading...',
                error: 'Failed to load model list',
                retry: 'Retry',
                empty: 'No models available',
                added: 'Added',
                selectionCount: 'Selected {count} models',
                cancel: 'Cancel',
                add: 'Add ({count})',
                filterPlaceholder: 'Filter models...',
                clearFilter: 'Clear filter',
                noResults: 'No matching models'
            },
            promptSettings: {
                loading: 'Loading...',
                enable: 'Enable Custom System Prompt Template',
                enableDescription: 'When enabled, you can customize the structure and content of system prompts using module placeholders',
                modes: {
                    label: 'Prompt Mode',
                    add: 'Add Mode',
                    rename: 'Rename',
                    delete: 'Delete Mode',
                    confirmDelete: 'Are you sure you want to delete this mode? This action cannot be undone.',
                    cannotDeleteDefault: 'Cannot delete the default mode',
                    unsavedChanges: 'The current mode has unsaved changes. Are you sure you want to discard and switch?',
                    newModeName: 'Please enter a name for the new mode',
                    newModeDefault: 'New Mode',
                    renameModePrompt: 'Please enter the new mode name',
                    duplicate: 'Duplicate Mode',
                    copySuffix: 'Copy',
                    exportCurrent: 'Export Current Mode',
                    exportAll: 'Export All Modes',
                    exportSuccess: 'Exported and copied to clipboard',
                    exportDownloadOnly: 'Exported file, but clipboard copy failed',
                    import: 'Import Modes',
                    importDescription: 'Paste GrayCode prompt mode JSON, or read it from a file. Imported modes will receive new IDs and will not overwrite existing modes.',
                    importFromFile: 'Read from file',
                    importPlaceholder: 'Paste exported prompt mode JSON...',
                    importConfirm: 'Import',
                    importInvalid: 'The import content is not a valid prompt mode',
                    importEmpty: 'Import content is empty',
                    importFailed: 'Import failed',
                    importSuccess: 'Imported {count} mode(s)',
                    importedModeDefault: 'Imported Mode',
                    duplicateSuccess: 'Mode duplicated',
                    duplicateFailed: 'Failed to duplicate mode'
                },
                templateSection: {
                    title: 'System Prompt Template',
                    resetButton: 'Reset to Default',
                    description: 'Write system prompts directly, use {{$VARIABLE}} format to reference variables, which will be replaced with actual content when sent',
                    placeholder: 'Enter system prompt, you can use variables like {{$ENVIRONMENT}}...'
                },
                staticSection: {
                    title: 'Static System Prompt',
                    description: 'Included in system prompt, content is relatively stable, can be cached by API providers to speed up responses. Use {{$VARIABLE}} format to reference static variables.',
                    placeholder: 'Enter static system prompt, you can use {{$ENVIRONMENT}}, {{$TOOLS}} and other variables...'
                },
                dynamicSection: {
                    title: 'Dynamic Context Template',
                    description: 'Generated dynamically and appended to the end of messages on each request, contains real-time info (time, file tree, tabs, etc.), not stored in history.',
                    placeholder: 'Enter dynamic context template, you can use {{$WORKSPACE_FILES}}, {{$OPEN_TABS}} and other variables...',
                    enableTooltip: 'Enable/disable dynamic context template',
                    disabledNotice: 'Dynamic context template is disabled. No dynamic context messages will be sent to AI.',
                    strategyTitle: 'Dynamic context strategy',
                    strategySingle: 'Single dynamic context (current behavior)',
                    strategyPreserve: 'Preserve old dynamic context in place',
                    strategyDescription: 'Single mode keeps existing behavior. Preserve mode inserts cached old dynamic contexts back at their original turns and inserts the new context before the new message.',
                    strategyPreserveWarning: 'Preserve mode increases request tokens. More preserved contexts make context trimming or summarization more likely.'
                },
                toolPolicy: {
                    title: 'Tool Policy',
                    description: 'Restrict which tools are available in this mode. When not set, it inherits the Code mode toolset (and still respects global tool toggles).',
                    inherit: 'Inherit (default)',
                    custom: 'Custom (allowlist)',
                    inheritHint: 'This mode will inherit the Code mode toolset.',
                    searchPlaceholder: 'Search tools…',
                    selectAll: 'Select all',
                    clear: 'Clear',
                    loadingTools: 'Loading tools list...',
                    noTools: 'No tools available',
                    disabledBadge: 'Disabled',
                    emptyWarning: 'Custom tool list is enabled, but no tools are selected.',
                    emptyCannotSave: 'Please select at least 1 tool for a custom tool list'
                },
                saveButton: 'Save Configuration',
                saveSuccess: 'Saved successfully',
                saveFailed: 'Save failed',
                tokenCount: {
                    label: 'Token Count',
                    staticLabel: 'Static Template',
                    dynamicLabel: 'Dynamic Context',
                    staticTooltip: 'Token count of static template itself (excluding actual content of placeholders like {{$TOOLS}})',
                    dynamicTooltip: 'Actual token count of dynamic context (including filled content like file tree, diagnostics)',
                    channelTooltip: 'Select channel for token calculation',
                    refreshTooltip: 'Refresh token count',
                    failed: 'Count failed',
                    hint: 'Static template is the template itself, dynamic context is the filled content. Actual requests also include tool definitions.'
                },
                modulesReference: {
                    title: 'Available Variables Reference',
                    insertTooltip: 'Insert at the end of template'
                },
                staticModules: {
                    title: 'Static Variables',
                    badge: 'Cacheable',
                    description: 'These variables are included in the system prompt with relatively stable content, can be cached by API providers to speed up responses.'
                },
                dynamicModules: {
                    title: 'Dynamic Variables',
                    badge: 'Real-time',
                    description: 'These variables are dynamically inserted into the last message as context, containing real-time info like current time and file status, not stored in conversation history.'
                },
                modules: {
                    ENVIRONMENT: {
                        name: 'Environment Info',
                        description: 'Contains workspace path, operating system, current time and timezone information'
                    },
                    CONTEXT_BADGE_FORMAT: {
                        name: 'Context Badge Format',
                        description: 'Explains <lim-context ...>...</lim-context> semantics, including title (title attribute), body (tag content), and binary badge handling'
                    },
                    WORKSPACE_FILES: {
                        name: 'Workspace File Tree',
                        description: 'Lists files and directory structure in the workspace, affected by depth and ignore patterns in context awareness settings',
                        requiresConfig: 'Context Awareness > Send Workspace File Tree'
                    },
                    OPEN_TABS: {
                        name: 'Open Tabs',
                        description: 'Lists file tabs currently open in the editor',
                        requiresConfig: 'Context Awareness > Send Open Tabs'
                    },
                    ACTIVE_EDITOR: {
                        name: 'Active Editor',
                        description: 'Shows the path of the currently editing file',
                        requiresConfig: 'Context Awareness > Send Active Editor'
                    },
                    DIAGNOSTICS: {
                        name: 'Diagnostics',
                        description: 'Shows workspace errors, warnings and other diagnostics to help AI fix code issues',
                        requiresConfig: 'Context Awareness > Enable Diagnostics'
                    },
                    PINNED_FILES: {
                        name: 'Pinned Files Content',
                        description: 'Shows complete content of user-pinned files',
                        requiresConfig: 'Need to add files in the pinned files button next to input box'
                    },
                    SKILLS: {
                        name: 'Skills Content',
                        description: 'Skills are user-defined knowledge modules. AI loads content on demand via the read_skill tool. Skill names and descriptions are listed in the tool description.',
                        requiresConfig: 'Enable skills in the Skills panel, AI loads content via read_skill tool'
                    },
                    TOOLS: {
                        name: 'Tool Definitions',
                        description: 'Generate tool definitions in XML or Function Call format based on channel configuration (this variable is automatically filled by the system)'
                    },
                    MCP_TOOLS: {
                        name: 'MCP Tools',
                        description: 'Additional tool definitions from MCP servers (this variable is automatically filled by the system)',
                        requiresConfig: 'Need to configure and connect servers in MCP settings'
                    },
                    TODO_LIST: {
                        name: 'TODO List',
                        description: 'Displays the TODO list for the current conversation (from todoList metadata persisted by todo_write / todo_update / create_plan)'
                    },
                    MEMORY: {
                        name: 'Memory System',
                        description: 'Instructions for the permanent memory system (OptMem), telling the AI how to record and recall information across sessions.',
                        requiresConfig: 'Customizable in Settings → Memory'
                    }
                },
                exampleOutput: 'Example Output:',
                requiresConfigLabel: 'Requires Config:'
            },
            summarizeSettings: {
                description: 'Context summarization can compress conversation history to reduce Token usage. This page is for manual summary and summary model settings. Auto summarize is configured in "Channel Settings > Context Management".',
                manualSection: {
                    title: 'Manual Summarization',
                    description: 'Click the compress button on the right side of the input box to manually trigger context summarization. The summarized content will replace the original conversation history.'
                },
                optionsSection: {
                    title: 'Summarization Options',
                    keepRounds: 'Minimum Rounds to Keep',
                    keepRoundsUnit: 'rounds',
                    keepRoundsHint: 'Lower-bound protection for the keep budget: at least the most recent N rounds are never summarized',
                    keepRoundsMinNote: 'Minimum is 1 round (backend enforces at least 1 round)',
                    keepTokens: 'Keep Recent Budget',
                    keepTokensHint: 'How much recent context to keep unsummarized: a token count (e.g. 30000) or a percentage of the model context window (e.g. 25%). The actual range aligns to round boundaries within this budget',
                    maxAttempts: 'Max Auto-Summarize Attempts',
                    maxAttemptsUnit: 'attempts/turn',
                    maxAttemptsHint: 'Maximum auto-summarize attempts within one real user turn (1-5, default 2). When exhausted and still over threshold, this request falls back to non-persistent safe trimming',
                    maxInputRatio: 'Summarize Model Input Ratio',
                    maxInputRatioHint: 'Max input ratio of a single auto-summarize request to the summarize model context window (5%-95%, default 50%). When exceeded, the summarize range shrinks to keep the latest tool interaction',
                    manualPrompt: 'Manual Summarization Prompt',
                    manualPromptPlaceholder: 'Enter the prompt used for manual summarization...',
                    manualPromptHint: 'Used when you click the "Summarize context" button',
                    autoPrompt: 'Auto Summarization Prompt',
                    autoPromptPlaceholder: 'Enter the prompt used for auto summarization (leave empty to use built-in prompt)...',
                    autoPromptHint: 'Used when auto summarize is triggered by context threshold',
                    restoreBuiltin: 'Restore built-in default'
                },
                modelSection: {
                    title: 'Dedicated Summarization Model',
                    useSeparate: 'Use Dedicated Summarization Model',
                    useSeparateHint: 'When enabled, summarization will use the model specified below instead of the model used in the conversation.\nYou can choose a cheaper model to save costs.',
                    currentModelHint: 'Currently using the conversation model for summarization',
                    selectChannel: 'Select Channel',
                    selectChannelPlaceholder: 'Select channel for summarization',
                    selectChannelHint: 'Only shows enabled channels',
                    selectModel: 'Select Model',
                    selectModelPlaceholder: 'Select model for summarization',
                    selectModelHint: 'Only shows models added to settings for this channel.\nTo add more models, please go to channel settings to configure.',
                    warningHint: 'Please select a channel and model, otherwise the conversation model will be used for summarization'
                }
            },
            settingsPanel: {
                title: 'Settings',
                backToChat: 'Back to Chat',
                sidebarCollapse: 'Collapse sidebar',
                sidebarExpand: 'Expand sidebar',
                search: {
                    placeholder: 'Search settings…',
                    clear: 'Clear search',
                    noResults: 'No matching settings found',
                    hint: 'Type a keyword to find settings; press Enter to open the first result'
                },
                sections: {
                    channel: {
                        title: 'Channel Settings',
                        description: 'Configure API channels and models'
                    },
                    tools: {
                        title: 'Tool Settings',
                        description: 'Manage and configure available tools'
                    },
                    autoExec: {
                        title: 'Auto Execution',
                        description: 'Configure confirmation behavior when executing tools'
                    },
                    mcp: {
                        title: 'MCP Settings',
                        description: 'Configure Model Context Protocol servers'
                    },
                    checkpoint: {
                        title: 'Checkpoint Settings',
                        description: 'Configure codebase snapshot backup and rollback'
                    },
                    summarize: {
                        title: 'Context Summarization',
                        description: 'Compress conversation history to reduce Token usage'
                    },
                    imageGen: {
                        title: 'Image Generation',
                        description: 'Configure AI image generation tools'
                    },
                    context: {
                        title: 'Context Awareness',
                        description: 'Configure workspace context information sent to AI'
                    },
                    prompt: {
                        title: 'System Prompt',
                        description: 'Customize the structure and content of system prompts'
                    },
                    tokenCount: {
                        title: 'Token Count',
                        description: 'Configure API for counting tokens'
                    },
                    subagents: {
                        title: 'Sub-Agents',
                        description: 'Configure specialized sub-agents that AI can invoke'
                    },
                    dependencies: {
                        title: 'Dependencies',
                        description: 'Install and manage dependency tools such as Python and Node'
                    },
                    sound: {
                        title: 'Notification System',
                        description: 'Configure sound cues and Windows Agent stop notifications'
                    },
                    appearance: {
                        title: 'Appearance',
                        description: 'Configure UI appearance options'
                    },
                    memory: {
                        title: 'Permanent Memory',
                        description: 'Configure cross-session AI memory system (OptMem)'
                    },
                    sandbox: {
                        title: 'Sandbox',
                        description: 'Run code snippets safely in an isolated temporary directory'
                    },
                    general: {
                        title: 'General Settings',
                        description: 'Basic configuration options'
                    },
                    usage: {
                        title: 'Usage Time & Statistics',
                        description: 'View your usage time and token statistics',
                        openFullPage: 'View Full Statistics'
                    }
                },
                proxy: {
                    title: 'Network Proxy',
                    description: 'Configure HTTP proxy for API requests',
                    enable: 'Enable Proxy',
                    url: 'Proxy Address',
                    urlPlaceholder: 'http://127.0.0.1:7890',
                    urlError: 'Please enter a valid proxy address (http:// or https://)',
                    save: 'Save',
                    saveSuccess: 'Saved successfully',
                    saveFailed: 'Save failed'
                },
                language: {
                    title: 'Interface Language',
                    description: 'Select interface display language',
                    placeholder: 'Select Language',
                    autoDescription: 'Auto follow VS Code language settings',
                    followSystem: 'Follow system'
                },
                workspaceBehavior: {
                    title: 'Workspace Behavior',
                    description: 'Choose how to handle the last opened workspace on startup',
                    optionRestore: 'Reopen the workspace from the last session',
                    optionNone: "Don't open any workspace"
                },
                appInfo: {
                    title: 'Application Info',
                    name: '{appName} - Vibe Coding Assistant',
                    version: 'Version: {version}',
                    repository: 'Repository',
                    developer: 'Developer'
                },
                update: {
                    title: 'Auto Update',
                    description: 'Check GitHub Releases for new versions at startup (at most once every 24 hours). New versions can be downloaded and installed automatically.',
                    enableLabel: 'Enable automatic update checks',
                    checkNow: 'Check Now',
                    updateNow: 'Update Now',
                    checking: 'Checking…',
                    upToDate: 'Up to date',
                    updateAvailable: 'Update available: v{version}',
                    installedHint: 'v{version} installed. Reload the window to apply.',
                    error: 'Check failed',
                    disabledHint: 'Automatic check is disabled'
                },
                exportImport: {
                    title: 'Settings Export/Import',
                    description: 'Export all plugin settings (channel configs, MCP servers, Skills, etc.) as a JSON file, or import to restore settings. Conversation history and checkpoints are excluded.',
                    exportBtn: 'Export Settings',
                    importBtn: 'Import Settings',
                    exporting: 'Exporting...',
                    importing: 'Importing...',
                    exportSuccess: 'Settings exported successfully to: {path}',
                    exportFailed: 'Export failed',
                    importSuccess: 'Import completed. Imported: {items}',
                    importNoItems: 'No items to import',
                    importFailed: 'Import failed',
                    vscodeSettings: 'VSCode Settings',
                    channelConfigs: ' channel config(s)',
                    mcpServers: ' MCP server(s)',
                    skills: ' skill(s)'
                },
                memory: {
                    loading: 'Loading memory config...',
                    globalOnlyHint: 'Global setting. Only editable in the "Global Memory" tab.',
                    enabled: {
                        label: 'Enable Permanent Memory',
                        description: 'Allow the AI to recall and record long-term information across sessions.',
                        disabledNotice: 'When disabled, the memory prompt is not injected and memory tools are not provided to the AI. Existing memories and settings are preserved and can still be viewed or edited below.'
                    },
                    saved: 'Saved',
                    saving: 'Saving...',
                    save: 'Save Config',
                    reset: 'Reset to Default',
                    systemPrompt: {
                        title: 'Custom Prompt',
                        description: 'The prompt shown above is currently active and can be edited directly. Click "Reset to Default" to restore the built-in default. Changes take effect in the next session.',
                        placeholder: ''
                    },
                    runtime: {
                        title: 'Runtime Parameters',
                        description: 'Fine-tune the memory system output format and capacity. Changing these only affects display; no recomputation is needed.',
                        wakeLines: {
                            label: 'Wake Output Lines',
                            description: 'How many lines wake prints at most. Larger values = more detail, but higher token cost.',
                            unit: 'lines'
                        },
                        entryChars: {
                            label: 'Max Entry Bytes',
                            description: 'Maximum bytes per single memory entry. Entries exceeding this limit will be truncated.',
                            unit: 'bytes'
                        }
                    },
                    info: {
                        title: 'About Permanent Memory',
                        text: 'The memory system (OptMem) lets the AI automatically recall past agreements, decisions, and knowledge at the start of each session. The AI records important things as it works, and older memories are intelligently compressed into summaries to save tokens.'
                    },
                    rawEntries: {
                        title: 'Raw Memory Entries',
                        description: 'View and edit raw memory entries. Edit clears related summaries (they will be rebuilt on next compress).',
                        empty: 'No memory entries yet.',
                        addPlaceholder: 'Type what you want to remember and click "Add Memory" to write it to permanent memory manually (equivalent to the AI memory_note tool). Ctrl+Enter / ⌘+Enter submits.',
                        add: 'Add Memory',
                        added: 'Memory #{id} added',
                        addEmpty: 'The content is empty. Nothing to add.',
                        addTooLong: 'Content exceeds the per-entry limit ({limit} bytes).',
                        truncatedNotice: 'More than {limit} memories: only the first {limit} are shown here (use memory_recall in chat to search the rest).',
                        deleteConfirmTitle: 'Delete memory entry',
                        deleteConfirmMessage: 'Delete this raw memory entry (#{id})? Entries after it will be renumbered and their summaries cleared (rebuilt on next compress).',
                        selectAll: 'Select All',
                        deleteSelected: 'Delete Selected ({count})',
                        deletedBatch: 'Deleted {count} memories.',
                        batchDeleteConfirmTitle: 'Delete memory entries',
                        batchDeleteConfirmMessage: 'Delete the {count} selected raw memory entries? Remaining entries will be renumbered and their summaries cleared (rebuilt on next compress).',
                        scopeGlobal: 'Global Memory',
                        scopeGlobalHint: 'Default memory shared by all workspaces. The AI uses global memory when there is no workspace context.',
                        scopeWorkspace: 'Workspace Memory',
                        scopeWorkspaceHint: 'Memory stored independently per workspace; it does not affect other workspaces or global memory.',
                        selectScopeWorkspace: 'Select a workspace…',
                        workspaceNone: 'No workspace is currently available. Open or add a workspace and try again.',
                        workspaceMemoryEmpty: 'This workspace has no memories yet. Memories added in this section are only visible in this workspace.',
                        newlineNotAllowed: 'A memory must be a single line. Remove line breaks and try again.'
                    }
                },
                sandbox: {
                    enabled: {
                        label: 'Enable Sandbox',
                        description: 'Allow the AI to run code snippets in an isolated temporary directory. When disabled, the sandbox tool is not provided to the model.',
                        disabledNotice: 'Sandbox is disabled. The AI cannot use the sandbox tool to run code.'
                    },
                    languages: {
                        title: 'Allowed Languages',
                        description: 'Only checked languages can be executed in the sandbox. Uncheck to disable languages you do not need.'
                    },
                    timeout: {
                        title: 'Default Timeout',
                        description: 'Maximum execution duration in milliseconds. The process tree is force-killed on timeout.'
                    },
                    output: {
                        title: 'Max Output Lines',
                        description: 'Maximum output lines returned to the AI. Only the last N lines are kept when exceeded.',
                        unit: 'lines',
                        hint: 'Set to -1 for unlimited (not recommended; may produce very large output).'
                    },
                    cleanup: {
                        title: 'Cleanup Temp Directory',
                        description: 'Automatically delete the temporary directory after execution. Disable to keep artifacts for debugging.',
                        label: 'Clean up temp directory after run'
                    },
                    info: {
                        title: 'About Sandbox Security',
                        text: 'The sandbox provides filesystem isolation (temp directory), timeout, and output limits, but it is NOT OS-level sandboxing. It does not restrict network access, CPU, or memory. Do not use it to run untrusted malicious code.'
                    },
                    save: 'Save',
                    reset: 'Reset Defaults',
                    saved: 'Saved successfully',
                    saveFailed: 'Failed to save',
                    loadFailed: 'Failed to load sandbox config',
                    noLanguage: 'Keep at least one language, otherwise the sandbox cannot run any code'
                },

            },
            toolSettings: {
                files: {
                    applyDiff: {
                        autoApply: 'Auto Apply Changes',
                        enableAutoApply: 'Enable Auto Apply',
                        enableAutoApplyDesc: 'When enabled, AI changes will be automatically saved after specified delay without manual confirmation',
                        autoSaveDelay: 'Auto Save Delay',
                        delayTime: 'Delay Time',
                        delayTimeDesc: 'Wait this amount of time after showing changes before auto-saving',
                        delay005s: '0.05 seconds',
                        delay1s: '1 second',
                        delay2s: '2 seconds',
                        delay3s: '3 seconds',
                        delay5s: '5 seconds',
                        delay10s: '10 seconds',
                        infoEnabled: 'Current setting: After AI modifies files, changes will be automatically saved after {delay} and continue execution.',
                        infoDisabled: 'Current setting: After AI modifies files, you need to manually press Ctrl+S in the editor to confirm and save changes.',

                        format: 'Diff Format',
                        formatDesc: 'Choose the parameter format used when AI calls apply_diff (structured hunks are recommended by default; legacy unified diff patch remains compatible)',
                        formatUnified: 'Structured hunks (recommended; unified diff patch compatible)',
                        formatSearchReplace: 'Legacy (search/replace)',

                        skipDiffView: 'Skip Diff View',
                        enableSkipDiffView: 'Skip diff view when auto-applying',
                        enableSkipDiffViewDesc: 'When enabled, auto-applied changes will be saved directly without opening the diff comparison view',

                        diffGuard: 'Diff Guard',
                        enableDiffGuard: 'Enable deletion guard',
                        enableDiffGuardDesc: 'Show a warning when the number of deleted lines exceeds a specified percentage of the total file lines',
                        diffGuardThreshold: 'Guard Threshold',
                        diffGuardThresholdDesc: 'Trigger a warning when deleted lines exceed this percentage of total file lines',
                        diffGuardWarning: 'This change deletes {deletePercent}% of the file content ({deletedLines}/{totalLines} lines), exceeding the {threshold}% guard threshold. Please review carefully.',
                        outsideWorkspaceAccess: 'Write outside workspace',
                        outsideWorkspaceDesc: 'Control whether apply_diff can modify existing files outside the workspace.',
                        outsideWorkspaceDenyDesc: 'apply_diff can only modify files inside the workspace.',
                        outsideWorkspaceAskDesc: 'Use the original tool-call approval card before modifying outside-workspace files.',
                        outsideWorkspaceTip: 'Outside-workspace apply_diff does not have an “allow directly” option; approval is still followed by the Diff preview/save flow.'
                    },
                    outsideWorkspaceAccess: {
                        deny: 'Deny',
                        ask: 'Ask for approval',
                        allow: 'Allow directly'
                    },
                    readFile: {
                        outsideWorkspaceAccess: 'Read outside workspace',
                        outsideWorkspaceDenyDesc: 'read_file can only read files inside the workspace.',
                        outsideWorkspaceAskDesc: 'Use the original tool-call approval card before reading outside-workspace files.',
                        outsideWorkspaceAllowDesc: 'Allow read_file to read outside-workspace files directly.',
                        outsideWorkspaceTip: 'Relative paths are still resolved from the workspace; absolute paths, file:// URIs, or paths escaping the workspace are controlled by this policy.'
                    },
                    writeFile: {
                        outsideWorkspaceAccess: 'Write outside workspace',
                        outsideWorkspaceDenyDesc: 'write_file can only write files inside the workspace.',
                        outsideWorkspaceAskDesc: 'Use the original tool-call approval card before writing outside-workspace files; the Diff preview is still shown after approval.',
                        outsideWorkspaceTip: 'Outside-workspace writes do not have an “allow directly” option; approval is required before the write flow starts.'
                    },
                    listFiles: {
                        ignoreList: 'Ignore List',
                        ignoreListHint: '(Supports wildcards, e.g. *.log, temp*)',
                        inputPlaceholder: 'Enter file or directory pattern to ignore...',
                        deleteTooltip: 'Delete',
                        addButton: 'Add'
                    }
                },
                search: {
                    findFiles: {
                        excludeList: 'Exclude Patterns',
                        excludeListHint: '(glob format, e.g. **/node_modules/**)',
                        inputPlaceholder: 'Enter file or directory pattern to exclude...',
                        deleteTooltip: 'Delete',
                        addButton: 'Add'
                    },
                    searchInFiles: {
                        excludeList: 'Exclude Patterns',
                        excludeListHint: '(glob format, e.g. **/node_modules/**)',
                        inputPlaceholder: 'Enter file or directory pattern to exclude...',
                        deleteTooltip: 'Delete',
                        addButton: 'Add'
                    }
                },
                history: {
                    searchSection: 'Search Mode',
                    searchScope: 'Search Scope',
                    searchScopeDesc: 'Select the range of history records the tool can search',
                    scopeAll: 'All conversation history (Default)',
                    scopeSummarized: 'Summarized content only',
                    maxSearchMatches: 'Max Matches',
                    maxSearchMatchesDesc: 'Maximum number of matching lines returned per search',
                    searchContextLines: 'Context Lines',
                    searchContextLinesDesc: 'Number of context lines shown before and after each match',
                    readSection: 'Read Mode',
                    maxReadLines: 'Max Read Lines',
                    maxReadLinesDesc: 'Maximum number of lines returned per read request',
                    outputSection: 'Output Limits',
                    maxResultChars: 'Max Result Characters',
                    maxResultCharsDesc: 'Maximum total characters in the result (multi-line read)',
                    lineDisplayLimit: 'Line Display Limit',
                    lineDisplayLimitDesc: 'Max display characters per line; longer lines are truncated (use single-line read for full content)'
                },
                terminal: {
                    executeCommand: {
                        shellEnv: 'Shell Environment',
                        defaultBadge: 'Default',
                        available: 'Available',
                        unavailable: 'Unavailable',
                        setDefaultTooltip: 'Set as default',
                        executablePath: 'Executable Path (optional):',
                        executablePathPlaceholder: 'Leave empty to use path from system PATH',
                        execTimeout: 'Execution Timeout',
                        timeoutHint: 'Commands exceeding this time will be automatically terminated',
                        timeout30s: '30 seconds',
                        timeout1m: '1 minute',
                        timeout2m: '2 minutes',
                        timeout5m: '5 minutes',
                        timeout10m: '10 minutes',
                        timeoutUnlimited: 'Unlimited',
                        maxOutputLines: 'Max Output Lines',
                        maxOutputLinesHint: 'Last N lines of terminal output sent to AI, to avoid excessive output',
                        unlimitedLines: 'Unlimited',
                        tips: {
                            onlyEnabledUsed: '• Only enabled and available shells will be used by AI',
                            statusMeaning: '• ✓ means available, ✗ means unavailable',
                            windowsRecommend: '• Windows recommends using PowerShell (supports UTF-8)',
                            gitBashRequire: '• Git Bash requires Git for Windows to be installed',
                            wslRequire: '• WSL requires Windows Subsystem for Linux to be enabled',
                            confirmSettings: '• To configure execution confirmation, go to "Auto Execute" settings tab'
                        }
                    }
                },
                media: {
                    common: {
                        returnImageToAI: 'Return Image Directly to AI',
                        returnImageDesc: 'When enabled, the processed image base64 will be returned directly to AI as tool response, allowing AI to view and analyze the image content.',
                        returnImageDescDetail: 'When disabled, only text description (e.g. file path) will be returned, AI needs to call read_file tool to view the image.'
                    },
                    cropImage: {
                        title: 'Crop Image',
                        description: 'When enabled, AI can directly view the cropping effect to judge if the area is correct. Disable to save token consumption.'
                    },
                    generateImage: {
                        title: 'Image Generation',
                        description: 'When enabled, AI can directly see the generated image effect to judge if regeneration or adjustment is needed. Disable to save token consumption.'
                    },
                    removeBackground: {
                        title: 'Remove Background',
                        description: 'When enabled, AI can directly view the background removal effect to judge if subject description needs adjustment or reprocessing. Disable to save token consumption.'
                    },
                    resizeImage: {
                        title: 'Resize Image',
                        description: 'When enabled, AI can directly view the resizing effect to judge if the dimensions are appropriate. Disable to save token consumption.'
                    },
                    rotateImage: {
                        title: 'Rotate Image',
                        description: 'When enabled, AI can directly view the rotation effect to judge if the angle is correct. Disable to save token consumption.'
                    }
                },
                common: {
                    loading: 'Loading...',
                    loadingConfig: 'Loading config...',
                    saving: 'Saving...',
                    error: 'Error',
                    retry: 'Retry'
                }
            },
            toolsSettings: {
                maxIterations: {
                    label: 'Max Tool Calls Per Turn',
                    hint: 'Prevents AI from infinite tool call loops, -1 for unlimited',
                    unit: 'calls'
                },
                actions: {
                    refresh: 'Refresh',
                    enableAll: 'Enable All',
                    disableAll: 'Disable All'
                },
                sandboxHint: 'Detailed sandbox parameters can be configured in Settings → Sandbox',
                loading: 'Loading tools list...',
                empty: 'No tools available',
                categories: {
                    file: 'File Operations',
                    search: 'Search',
                    terminal: 'Terminal',
                    lsp: 'Code Intelligence',
                    media: 'Media Processing',
                    plan: 'Plan',
                    todo: 'TODO',
                    history: 'History',
                    memory: 'Memory',
                    review: 'Review',
                    progress: 'Progress',
                    skills: 'Skills',
                    design: 'Design',
                    notification: 'Notifications',
                    agents: 'Agents',
                    mcp: 'MCP Tools',
                    activity: 'Usage Time',
                    sandbox: 'Sandbox',
                    other: 'Other'
                },
                dependency: {
                    required: 'Dependencies Required',
                    requiredTooltip: 'This tool requires dependencies to be installed',
                    disabledTooltip: 'Tool is disabled or missing dependencies'
                },
                config: {
                    tooltip: 'Configure Tool'
                },
                toolDisplayNames: {
                    read_file: 'Read File',
                    write_file: 'Write File',
                    delete_file: 'Delete File',
                    create_directory: 'Create Directory',
                    list_files: 'List Files',
                    apply_diff: 'Apply Diff',
                    execute_command: 'Execute Command',
                    sandbox: 'Sandbox',
                    find_files: 'Find Files',
                    search_in_files: 'Search in Files',
                    history_search: 'History Search',
                    get_symbols: 'Get Symbols',
                    goto_definition: 'Goto Definition',
                    find_references: 'Find References',
                    generate_image: 'Generate Image',
                    resize_image: 'Resize Image',
                    crop_image: 'Crop Image',
                    rotate_image: 'Rotate Image',
                    remove_background: 'Remove Background',
                    todo_write: 'Todo Write',
                    todo_update: 'Todo Update',
                    create_design: 'Create Design',
                    update_design: 'Update Design',
                    create_plan: 'Create Plan',
                    update_plan: 'Update Plan',
                    create_progress: 'Create Progress',
                    update_progress: 'Update Progress',
                    record_progress_milestone: 'Record Progress Milestone',
                    validate_progress_document: 'Validate Progress Document',
                    create_review: 'Create Review',
                    record_review_milestone: 'Record Review Milestone',
                    finalize_review: 'Finalize Review',
                    validate_review_document: 'Validate Review Document',
                    reopen_review: 'Reopen Review',
                    compare_review_documents: 'Compare Review Documents',
                    show_windows_notification: 'Show Windows Notification',
                    memory_wake: 'Memory Wake',
                    memory_note: 'Memory Note',
                    memory_recall: 'Memory Recall',
                    memory_compress: 'Memory Compress',
                    memory_zoom: 'Memory Zoom',
                    memory_forget: 'Memory Forget',
                    memory_config: 'Memory Config',
                    insert_code: 'Insert Code',
                    delete_code: 'Delete Code',
                    read_skill: 'Read Skill',
                    toggle_skills: 'Toggle Skills',
                    subagents: 'Subagents',
                    agent_send_message: 'Send Agent Message',
                    get_activity_stats: 'Get Activity Stats',
                },
                toolDescriptions: {
                    read_file: 'Read a file in the workspace. Supports text and binary files with optional line range.',
                    write_file: 'Write content to a file. Creates if not exists, overwrites if exists.',
                    delete_file: 'Delete one or more files or directories. Supports non-empty directories.',
                    create_directory: 'Create one or more directories in the workspace (auto-creates parents).',
                    list_files: 'List files and subdirectories in directories, supports recursion and line counts.',
                    apply_diff: 'Apply structured content replacements to a file using hunks array format.',
                    sandbox: 'Run code in an isolated sandbox (temporary directory with timeout and output limits). Safer than execute_command for running untrusted code snippets: the code runs in a throwaway temp directory that is cleaned up afterwards, with a hard timeout that kills the process tree and an output line cap to prevent flooding. Supported languages: python, javascript, bash, powershell, sh. Pass the full source code via the `code` parameter; the tool writes it to a file and invokes the corresponding interpreter. Optional `stdin` is piped to the program. NOTE: This is lightweight filesystem isolation, NOT OS-level sandboxing. It does not block network access or limit CPU/memory. Do not use for truly malicious code. By default this tool requires user confirmation before execution (same as execute_command); it can be set to auto-execute in the tool auto-execution settings.',
                    execute_command: 'Execute a shell command and return output. Supports PowerShell, CMD, Bash, WSL and more.',
                    find_files: 'Find files by glob patterns. Returns matched file list with details.',
                    search_in_files: 'Search or search-and-replace content in workspace files. Supports regex.',
                    history_search: 'Search and read conversation history. Supports keyword search and line-range read modes.',
                    get_symbols: 'Get all symbols (classes, functions, variables, etc.) in files. Returns hierarchical symbol list with line numbers.',
                    goto_definition: 'Go to the definition of a symbol and return the complete definition code with line numbers.',
                    find_references: 'Find all references to a symbol across the codebase with context.',
                    generate_image: 'Generate images using AI model. Supports single and batch generation modes with solid backgrounds.',
                    resize_image: 'Resize images to specified target dimensions using stretch fill mode.',
                    crop_image: 'Crop images using normalized coordinates (0-1000), auto-converted to actual pixel coordinates.',
                    rotate_image: 'Rotate images to any angle. Positive for clockwise, negative for counter-clockwise.',
                    remove_background: 'Remove background from images to generate transparent PNG. Uses AI-generated masks.',
                    todo_write: 'Create or replace the per-conversation TODO list to initialize task tracking.',
                    todo_update: 'Incrementally update TODO list status and content without rewriting the entire list.',
                    create_design: 'Create a Markdown design document. Only creates the design, not a plan or implementation.',
                    update_design: 'Update an existing Markdown design document.',
                    create_plan: 'Create a Markdown plan document with TODO checklist. Only creates the plan.',
                    update_plan: 'Update a plan document. Supports revision mode and progress sync mode.',
                    create_progress: 'Create the project progress document and initialize the status ledger.',
                    update_progress: 'Update the project progress document summary, TODOs, risks, and log entries.',
                    record_progress_milestone: 'Record a milestone into the project progress document.',
                    validate_progress_document: 'Validate the progress document metadata, structure, and basic invariants.',
                    create_review: 'Create a Markdown review document for code review scenarios.',
                    record_review_milestone: 'Append a milestone to a review document and update structured summaries.',
                    finalize_review: 'Finalize a review document, normalize its structure, and update the final summary.',
                    validate_review_document: 'Validate a review document format, metadata, and structural integrity.',
                    reopen_review: 'Reopen a finalized review document to continue recording milestones.',
                    compare_review_documents: 'Compare two review documents and return finding deltas and statistics.',
                    show_windows_notification: 'Show a Windows system notification for long task completion or user action alerts.',
                    memory_wake: 'Wake permanent memory to retrieve memory summary at session start.',
                    memory_note: 'Record a permanent memory entry for important information and conventions.',
                    memory_recall: 'Search all permanent memories with regex support.',
                    memory_compress: 'Execute pending memory compression and merging.',
                    memory_zoom: 'Expand a memory tree node to view details.',
                    memory_forget: 'Discard an incorrect memory tree summary; or delete raw memories by single id or closed range (e.g. "5" deletes one, "1,3" deletes ids 1-3).',
                    memory_config: 'View or modify the permanent memory system configuration parameters.',
                    insert_code: 'Insert code before a specified line. Use "last line + 1" to append at the end.',
                    delete_code: 'Delete code within a specified line range in files.',
                    read_skill: 'Read a skill\'s content and instructions.',
                    toggle_skills: 'Enable or disable skills for subsequent requests.',
                    subagents: 'Spawn sub-agents to execute tasks with prompts and context.',
                    agent_send_message: 'Send a message to another agent (sub-agent) or to the main session (the main model) in the current conversation. Delivery is asynchronous: the recipient sees it appended to its most recent tool result. Address by targetRunId (an active sub-agent run in this conversation) or targetAgentName ("main" reaches the main session). Replies in the same thread increment hopDepth; after 5 hops delivery is rejected (loop protection). You are identified automatically; you cannot impersonate another agent.',
                    get_activity_stats: 'Get the user\'s IDE usage time statistics: daily usage minutes, recent schedule (hourly heatmap of when the user is active), and how long the user has been continuously working. Use this to understand the user\'s work-rest rhythm, detect long continuous working sessions, or check whether the user is currently active. Data contains timestamps only, no user content. Returned times are in local time (HH:mm, YYYY-MM-DD).',
                },
            },
            tokenCountSettings: {
                description: 'Configure API for accurate token counting. When enabled, the corresponding channel\'s token counting API will be called before sending requests to get accurate token counts for more precise context management.',
                hint: 'If not configured or API call fails, will fallback to estimation method.',
                enableChannel: 'Enable token counting for this channel',
                baseUrl: 'API URL',
                apiKey: 'API Key',
                apiKeyPlaceholder: 'Enter API Key',
                model: 'Model Name',
                geminiUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}',
                geminiUrlHint: 'Use {model} and {key} as placeholders',
                geminiModelPlaceholder: 'gemini-2.5-pro',
                anthropicUrlPlaceholder: 'https://api.anthropic.com/v1/messages/count_tokens',
                anthropicModelPlaceholder: 'claude-sonnet-4-5',
                comingSoon: 'Coming Soon',
                customApi: 'Custom API',
                openaiDocTitle: 'OpenAI Compatible API Interface',
                openaiDocDesc: 'OpenAI does not provide a standalone token counting API. If you have a self-hosted or third-party compatible token counting service, you can configure it here.',
                openaiUrlPlaceholder: 'https://your-api.example.com/count-tokens',
                openaiUrlHint: 'Your custom token counting API endpoint',
                openaiModelPlaceholder: 'gpt-4o',
                apiDocumentation: 'API Specification',
                requestExample: 'Request Example',
                requestBody: '// Request Body',
                responseFormat: '// Response Format',
                openaiDocNote: 'Your API should return a JSON response with a total_tokens field. The request body uses OpenAI Messages format.',
                saveSuccess: 'Configuration saved',
                saveFailed: 'Save failed'
            },
            soundSettings: {
                overview: {
                    title: 'About This Page',
                    description: 'This page manages Webview sound cues and Windows Agent stop notifications together. The settings below are grouped by function for easier adjustment.'
                },
                sections: {
                    sound: { title: 'Sound Cues', description: 'Configure Webview sound cues, including enable state, volume, events, imported audio files, and test playback.' },
                    windowsNotification: { title: 'Windows Agent Stop Notifications', description: 'Configure Windows notifications shown when the Agent stops, including templates and preview.' }
                },
                enabled: {
                    title: 'Enable Sound Notifications',
                    description: 'Play sound cues on certain events. This switch affects only sound cues and does not control Windows system notifications.',
                    label: 'Enable'
                },
                volume: {
                    title: 'Volume',
                    description: 'Adjust cue volume (0-100)'
                },
                cooldown: {
                    title: 'Minimum Interval',
                    description: 'Limit how often cues can play to avoid spam'
                },
                cues: {
                    title: 'Event Types',
                    description: 'Choose which events should play a cue. Main agent and subagent events are controlled separately.',
                    main: 'Main Agent',
                    subagent: 'Subagents',
                    warning: 'Warning',
                    error: 'Error',
                    taskComplete: 'Task Completed',
                    taskError: 'Task Failed'
                },
                assets: {
                    title: 'Custom Sounds',
                    description: 'Import local audio files to override built-in default sounds (click Save after importing; short sounds recommended; max {size} per file)',
                    none: 'None',
                    choose: 'Choose File',
                    clear: 'Clear',
                    importSuccess: 'Imported: {name}',
                    clearSuccess: 'Cleared',
                    fileTooLarge: 'File too large (max {size})',
                    invalidFile: 'Invalid audio file'
                },
                test: {
                    title: 'Test Playback',
                    description: 'Unlock browser audio policy and preview sound cues',
                    warning: 'Test: Warning',
                    error: 'Test: Error',
                    taskComplete: 'Test: Task Completed',
                    taskError: 'Test: Task Failed'
                },
                windowsAgentStopNotification: {
                    title: 'Windows Agent Stop Notifications',
                    description: 'Only available on Windows. These notifications are used only when the Agent stops. This phase shows a recognizable window title and renders the notification text from templates.',
                    optionsTitle: 'Notification Rules',
                    enabled: 'Enable Windows system notifications',
                    onlyWhenWindowNotFocused: 'Notify only when the current window is not focused',
                    rawTextHint: 'Notification title and body are generated from templates and do not directly display raw Agent text.',
                    bestEffortClickHint: 'Click handling remains best effort and is not a guarantee of precise window recovery in this phase.',
                    casesTitle: 'Notify For',
                    cases: {
                        error: 'Notify on failures',
                        awaitingUserAction: 'Notify when user action is required',
                        continueRequired: 'Notify when continuation is required'
                    },
                    templates: {
                        title: 'Notification Templates',
                        description: 'Templates only support extension-controlled variables for rendering the title and body.',
                        titleTemplate: 'Title Template',
                        errorBodyTemplate: 'Failure Body Template',
                        awaitingUserActionBodyTemplate: 'Awaiting User Action Body Template',
                        continueRequiredBodyTemplate: 'Continue Required Body Template',
                        variables: 'Available Variables',
                        variablesHint: 'Available variables: {appName}, {windowTitle}, {actionLabel}, {reasonLabel}'
                    },
                    preview: {
                        title: 'Notification Preview',
                        description: 'Preview uses the template currently being edited and the current window title, then renders the final notification on the host side.',
                        error: 'Preview Failure Notification',
                        awaitingUserAction: 'Preview Awaiting User Action Notification',
                        continueRequired: 'Preview Continue Required Notification'
                    }
                },
                testBlocked: 'Audio may be blocked by browser policy. Click a test button once to unlock.',
                testPlayed: 'Played',
                testFailed: 'Playback failed (may be blocked by browser policy)',
                saveSuccess: 'Saved successfully',
                saveFailed: 'Save failed'
            },
            appearanceSettings: {
                loadingText: {
                    title: 'Streaming Loading Text',
                    description: 'Text displayed in the animated indicator at the bottom of a message while the AI is streaming output.',
                    placeholder: 'e.g. Thinking...',
                    defaultHint: 'Leave empty to use default: {text}'
                },
                selectionContext: {
                    title: 'Selection Entry',
                    description: 'Controls whether "Add selection to input" appears in both the selection hover and Ctrl / code action entry points.'
                },
                smoothStreaming: {
                    title: 'Smooth Streaming',
                    description: 'Smooth out bursty streaming output into a steady typing effect (off = raw per-chunk output; higher tiers add more latency for a silkier feel).',
                    off: 'Off',
                    smooth: 'Responsive',
                    balanced: 'Balanced',
                    silky: 'Silky'
                },
                tpsBar: {
                    title: 'TPS Live Visualization',
                    description: 'Show a live tokens-per-second chart at the bottom of the input area. Sampling stops while hidden and restarts with the current stream when re-enabled.'
                },
                splash: {
                    title: 'Splash Animation',
                    description: 'Play the Gray Code logo drawing animation on startup. Disable to go straight to the main view.'
                },
                saveSuccess: 'Saved successfully',
                saveFailed: 'Save failed'
            },
            storageSettings: {
                title: 'Storage Path',
                description: 'Configure storage location for conversation history, checkpoints, etc.',
                currentPath: 'Current Path',
                customPath: 'Storage Path',
                customPathPlaceholder: 'Enter custom storage path...',
                customPathHint: 'Leave empty to use default path (extension storage directory)',
                browse: 'Browse',
                apply: 'Apply',
                reset: 'Reset to Default',
                openInExplorer: 'Open in Explorer',
                openInExplorerTitle: 'Open the current storage directory in file explorer',
                migrate: 'Migrate Data',
                migrateHint: 'Migrate existing data to new path',
                migrating: 'Migrating...',
                validating: 'Validating...',
                validation: {
                    valid: 'Path is valid',
                    invalid: 'Path is invalid',
                    checking: 'Checking...'
                },
                dialog: {
                    migrateTitle: 'Confirm Data Migration',
                    migrateMessage: 'Do you want to migrate existing data to the new path? This will copy all conversation history and checkpoints.',
                    migrateWarning: 'Do not close the window during migration',
                    confirm: 'Confirm Migration',
                    cancel: 'Cancel'
                },
                notifications: {
                    pathUpdated: 'Storage path updated',
                    pathReset: 'Storage path reset to default',
                    alreadyDefault: 'Already using the default path',
                    alreadyDefaultTitle: 'Already using the default path',
                    applyEmptyHint: 'Please select or enter a storage path first',
                    migrationSuccess: 'Data migration completed, please reload window for changes to take effect',
                    migrationFailed: 'Data migration failed: {error}',
                    validationFailed: 'Path validation failed: {error}',
                    openInExplorerFailed: 'Failed to open storage directory: {error}'
                },
                reloadWindow: 'Reload Window'
            }
        },

        backgroundTasks: {
            running: 'Running',
            completed: 'Completed',
            failed: 'Failed',
            cancelled: 'Cancelled',
            cancel: 'Cancel task',
            dismiss: 'Dismiss',
            dismissAllCompleted: 'Clear completed',
            dismissAllCompletedTitle: 'Dismiss all completed background tasks (confirmation shown when results are pending report)',
            dismissAllConfirmTitle: 'Clear completed tasks?',
            dismissAllConfirmMessage: '{count} task(s) have results pending report to the model. Dismissing them will prevent the model from receiving these results. Continue?',
            dismissAllConfirmAction: 'Dismiss anyway',
            pendingReport: 'Result pending report to the model',
            outputTitle: 'Command output',
            noOutput: 'No output yet',
            viewCollapsed: 'Collapse',
            viewMedium: 'Scroll view',
            viewExpanded: 'Expand all'
        },
        subagents: {
            monitor: {
                title: 'SubAgent Monitor',
                subtitle: 'Shows each SubAgent run as a chat: system prompt, context, AI output, reasoning and tool calls.',
                runCount: '{count} runs',
                closePanel: 'Close panel',
                empty: 'No SubAgent transcripts yet.',
                defaultAgentName: 'Sub-Agent',
                loadedCount: 'Loaded {loaded} / {total} messages',
                loadOlder: 'Load earlier messages',
                loadingOlder: 'Loading…',
                pause: 'Pause',
                resume: 'Resume',
                exit: 'Exit and fail the parent tool',
                retrying: 'Auto-retry {attempt}/{maxAttempts}',
                retrySuccess: 'Auto-retry succeeded',
                retryFailed: 'Auto-retry failed: {error}',
                readOnly: 'Historical run · view only',
                controlUnavailable: 'This run is no longer controllable; the action had no effect',
                status: {
                    queued: 'Queued',
                    running: 'Running',
                    paused: 'Paused',
                    awaitingMonitorAction: 'Awaiting action',
                    completed: 'Completed',
                    failed: 'Failed',
                    cancelled: 'Cancelled',
                    interrupted: 'Interrupted'
                }
            }
        },
        diff: {
            title: 'Changes',
            fileCount: '{count} file(s)',
            close: 'Close panel',
            empty: 'No change records',
            noChange: 'No content difference for this file',
            accept: 'Accept',
            reject: 'Reject',
            acceptAll: 'Accept all',
            rejectAll: 'Reject all',
            actionFailed: 'Action failed',
            viewNewContent: 'View new content',
            syntaxIssues: '{count} syntax issue(s)',
            noSyntaxIssues: 'No syntax issues found',
            roundLabel: 'Round {round}',
            allProcessed: 'All changes have been processed (history remains viewable)',
            clearHistory: 'Clear history',
            status: {
                pending: 'Pending',
                accepted: 'Accepted',
                rejected: 'Rejected'
            }
        },
        codeView: {
            title: 'Code Viewer',
            close: 'Close panel',
            empty: 'Select a file from the workspace tree on the left, or enter a path to open code',
            pathPlaceholder: 'Enter a file path (e.g. src/main.ts) and press Enter',
            open: 'Open',
            recent: 'Recent...',
            refresh: 'Reload',
            memorySource: 'In-memory content',
            jumpToLine: 'Jump to line',
            issuesFound: '{count} syntax issue(s) found',
            noIssues: 'No syntax issues found ({lines} lines)',
            workspaceFiles: 'Workspace files',
            noWorkspace: 'No workspace folder is open (file tree unavailable)',
            refreshTree: 'Refresh file tree',
            treeEmpty: '(empty directory)',
            errors: {
                openFailed: 'Failed to open file'
            }
        },
        channels: {
            common: {
                temperature: {
                    label: 'Temperature',
                    hint: '0.0 - 1.0, default 1.0',
                    toggleHint: 'When enabled, this parameter will be sent to API'
                },
                maxTokens: {
                    label: 'Max Output Tokens',
                    placeholder: '4096',
                    toggleHint: 'When enabled, this parameter will be sent to API'
                },
                topP: {
                    label: 'Top-P',
                    hint: '0.0 - 1.0',
                    toggleHint: 'When enabled, this parameter will be sent to API'
                },
                topK: {
                    label: 'Top-K',
                    toggleHint: 'When enabled, this parameter will be sent to API'
                },
                thinking: {
                    title: 'Thinking Configuration',
                    toggleHint: 'When enabled, thinking parameters will be sent to API'
                },
                thinkingBackfill: {
                    title: 'Thought Backfill Config',
                    signatures: 'Send Thought Signatures',
                    signaturesHint: 'Backfill reasoning context (history signatures & summaries) to keep multi-turn continuity; disable to skip reasoning items for endpoints that do not support the reasoning input type',
                    content: 'Send Thought Content',
                    currentGroup: 'Current Round',
                    currentSignatures: 'Send Current Signatures',
                    currentSignaturesHint: 'Maintain reasoning context for current step',
                    currentContent: 'Send Current Thoughts',
                    currentContentHint: 'Send reasoning content of the current turn',
                    historyGroup: 'History Rounds',
                    historySignatures: 'Send History Signatures',
                    historySignaturesHint: 'Maintain reasoning context across turns',
                    historyContent: 'Send History Thoughts',
                    historyContentHint: 'Let AI see thought processes of completed rounds',
                    roundsLabel: 'History Thinking Rounds',
                    roundsHint: 'How many non-latest rounds to send. -1 for all, 0 for none, positive N for last N rounds (e.g., 1 for only the second-to-last round)'
                }
            },
            anthropic: {
                thinking: {
                    typeLabel: 'Thinking Mode',
                    typeAdaptive: 'Adaptive',
                    typeEnabled: 'Manual (Enabled)',
                    typeDisabled: 'Disabled',
                    typeAdaptiveHint: 'Claude automatically decides thinking depth, recommended for Opus 4.6+',
                    typeEnabledHint: 'Manually set thinking token budget, works with all thinking-capable models',
                    typeDisabledHint: 'Thinking disabled (request carries {"thinking":{"type":"disabled"}})',
                    budgetLabel: 'Thinking Budget (Budget Tokens)',
                    budgetPlaceholder: '10000',
                    budgetHint: 'Maximum token count for thinking process, recommended 5000-50000',
                    effortLabel: 'Thinking Effort',
                    effortUltra: 'Ultra (highest)',
                    effortMax: 'Maximum',
                    effortXHigh: 'Extra High (Opus 4.7+)',
                    effortHigh: 'High (default)',
                    effortMedium: 'Medium',
                    effortLow: 'Low',
                    effortCustom: 'Custom (manual input)',
                    effortCustomPlaceholder: 'Enter custom effort value (e.g. max, ultra)',
                    effortHint: 'Controls Claude thinking depth. Higher levels think deeper but consume more tokens; choose custom to enter any effort value',
                    displayLabel: 'Thinking Display',
                    displayHint: 'Opus 4.7+ hides thinking by default. Choose "Summarized" to restore visible reasoning output',
                    displayOmitted: 'Omitted',
                    displayOmittedHint: 'No visible thinking content, only signature retained for follow-up turns (Opus 4.7+ default)',
                    displaySummarized: 'Summarized',
                    displaySummarizedHint: 'Returns a thinking summary visible in the chat panel'
                },
                promptCaching: {
                    title: 'Prompt Caching',
                    enable: 'Enable Prompt Caching (manual cache breakpoints)',
                    hint: 'Automatically adds cache markers on key content blocks of system, tools, and messages to leverage Anthropic Prompt Caching for cost and latency reduction',
                    ttlLabel: 'Cache TTL',
                    ttlHint: '5 min: 1.25x write price | 1 hour: 2x write price (cache reads are always 0.1x)',
                    ttl5m: '5 Minutes',
                    ttl5mHint: 'Default option, TTL refreshes on each cache read. Best for frequent conversations',
                    ttl1h: '1 Hour',
                    ttl1hHint: '2x base input price for writes. Best for intermittent long conversations',
                    keepAlive: 'Cache Keep-Alive (auto-refresh at 4m30s)',
                    keepAliveHint: 'When a streaming request exceeds 4m30s, automatically sends a max_tokens=5 keep-alive request to refresh the cache TTL'
                },
                userId: {
                    title: 'Request User ID (metadata.user_id)',
                    enable: 'Inject a stable metadata.user_id into each request',
                    hint: 'Generates a hashed identifier from the conversation ID (run ID for sub-agents), so the main session and each sub-agent are distinguished server-side and caches never mix; contains no private information'
                }
            },
            gemini: {
                maxImages: {
                    label: 'Max Images Upstream',
                    placeholder: '0 = no limit',
                    toggleHint: 'When enabled, the whole request sent to Gemini keeps at most this many images',
                    hint: 'Set to 0 for no limit. Older images over the limit are removed, keeping the newest images first'
                },
                thinking: {
                    includeThoughts: 'Return Thought Content',
                    includeThoughtsHint: 'When enabled, API response will include the model\'s thinking process',
                    mode: 'Thinking Intensity Mode',
                    modeHint: 'Default: Use API default | Level: Choose preset level | Budget: Custom token count',
                    modeDefault: 'Default',
                    modeLevel: 'Level',
                    modeBudget: 'Budget',
                    levelLabel: 'Thinking Level',
                    levelHint: 'minimal: Minimal thinking | low: Less thinking | medium: Moderate | high: Deep thinking',
                    levelMinimal: 'Minimal',
                    levelLow: 'Low',
                    levelMedium: 'Medium',
                    levelHigh: 'High',
                    budgetLabel: 'Thinking Budget (Token)',
                    budgetPlaceholder: '1024',
                    budgetHint: 'Custom token count allowed for thinking process'
                },
                thinkingBackfill: {
                    sendContentHint: 'When enabled, thought content (including summaries) from historical conversations will be sent, which may significantly increase context length'
                }
            },
            openai: {
                deepSeekUserId: {
                    title: 'DeepSeek user_id',
                    hint: 'Send the top-level user_id field for DeepSeek Chat Completions to isolate KVCache per conversation. It only applies when the current main chat request has a conversation ID; internal requests such as summaries and sub-agents do not send it by default. Enable this only for DeepSeek channels.',
                    toggleHint: 'Generate a stable privacy-safe user_id from the current conversation ID'
                },
                pdfAttachment: {
                    title: 'PDF attachment',
                    hint: 'Send PDF attachments as native file content blocks. Only official OpenAI endpoints and compatible endpoints that support the file type work; unsupported endpoints return a 400 error, so enable this only after confirming your endpoint supports it.',
                    toggleHint: 'Send PDF attachments as file content blocks'
                },
                frequencyPenalty: {
                    label: 'Frequency Penalty',
                    hint: '-2.0 - 2.0',
                    toggleHint: 'When enabled, this parameter will be sent to API'
                },
                presencePenalty: {
                    label: 'Presence Penalty',
                    hint: '-2.0 - 2.0',
                    toggleHint: 'When enabled, this parameter will be sent to API'
                },
                thinking: {
                    effortLabel: 'Thinking Effort',
                    effortHint: 'none: Not used | minimal: Minimal | low: Less | medium: Moderate | high: More | xhigh: Extra High | max: Maximum | ultra: Ultra | custom: Custom',
                    effortNone: 'None',
                    effortMinimal: 'Minimal',
                    effortLow: 'Low',
                    effortMedium: 'Medium',
                    effortHigh: 'High',
                    effortXHigh: 'Extra High',
                    effortMax: 'Maximum',
                    effortUltra: 'Ultra',
                    effortCustom: 'Custom',
                    effortCustomPlaceholder: 'Enter custom effort value (e.g. max, ultra)',
                    summaryLabel: 'Output Detail (Summary)',
                    summaryHint: 'auto: Auto select | concise: Brief output | detailed: Detailed output',
                    summaryAuto: 'Auto',
                    summaryConcise: 'Concise',
                    summaryDetailed: 'Detailed'
                },
                thinkingBackfill: {
                    sendSignaturesHint: 'When enabled, thought signatures from historical conversations will be sent (OpenAI not supported). Not recommended, and only signatures from non-latest turns are sent.',
                    sendContentHint: 'Use one policy for reasoning_content in both the current and historical turns, so a message does not rewrite the prompt prefix when it becomes historical'
                }
            },
            'openai-responses': {
                maxOutputTokens: {
                    label: 'Max Output Tokens',
                    placeholder: '8192',
                    hint: 'Maps to API max_output_tokens parameter'
                },
                thinking: {
                    effortLabel: 'Thinking Effort',
                    effortHint: 'none: Not used | minimal: Minimal | low: Less | medium: Moderate | high: More | xhigh: Extra High | max: Maximum | ultra: Ultra | custom: Custom',
                    effortNone: 'None (none)',
                    effortMinimal: 'Minimal (minimal)',
                    effortLow: 'Low (low)',
                    effortMedium: 'Medium (medium)',
                    effortHigh: 'High (high)',
                    effortXHigh: 'Extra High (xhigh)',
                    effortMax: 'Maximum (max)',
                    effortUltra: 'Ultra (ultra)',
                    effortCustom: 'Custom (custom)',
                    effortCustomPlaceholder: 'Enter custom effort value (e.g. max, ultra)',
                    summaryLabel: 'Output Detail (Summary)',
                    summaryHint: 'auto: Auto select | concise: Brief output | detailed: Detailed output',
                    summaryAuto: 'Auto',
                    summaryConcise: 'Concise',
                    summaryDetailed: 'Detailed'
                },
                thinkingBackfill: {
                    sendSignaturesHint: 'Maintain reasoning context across turns',
                    sendContentHint: 'When enabled, reasoning_content from historical conversations will be sent'
                }
            },
            customBody: {
                hint: 'Add custom request body fields, supports nested JSON override',
                modeSimple: 'Simple Mode',
                modeAdvanced: 'Advanced Mode',
                keyPlaceholder: 'Key name (e.g.: extra_body)',
                valuePlaceholder: 'Value (supports JSON, e.g.: {"key": "value"})',
                empty: 'No custom body items',
                addItem: 'Add Item',
                jsonError: 'JSON format error',
                jsonHint: 'Complete JSON format, supports nested override',
                jsonPlaceholder: '{\n  "extra_body": {\n    "google": {\n      "thinking_config": {\n        "include_thoughts": false\n      }\n    }\n  }\n}',
                enabled: 'Enabled',
                disabled: 'Disabled',
                deleteTooltip: 'Delete'
            },
            customHeaders: {
                hint: 'Add custom HTTP request headers, sent to API in order',
                keyPlaceholder: 'Header-Name',
                valuePlaceholder: 'Header Value',
                keyDuplicate: 'Duplicate key name',
                empty: 'No custom headers',
                addHeader: 'Add Header',
                enabled: 'Enabled',
                disabled: 'Disabled',
                deleteTooltip: 'Delete'
            },
            toolOptions: {
                cropImage: {
                    title: 'Crop Image (crop_image)',
                    useNormalizedCoords: 'Use Normalized Coordinates (0-1000)',
                    enabledTitle: 'When Enabled',
                    enabledNote: 'Suitable for models using normalized coordinates like Gemini',
                    disabledTitle: 'When Disabled',
                    disabledNote: 'Model needs to calculate actual pixel coordinates',
                    coordTopLeft: '= Top-left corner',
                    coordBottomRight: '= Bottom-right corner',
                    coordCenter: '= Center point'
                }
            },
            tokenCountMethod: {
                title: 'Token Count Method',
                label: 'Count Method',
                placeholder: 'Select count method',
                hint: 'Select the method for calculating token count, affects context trimming accuracy',
                options: {
                    channelDefault: 'Use Channel Default',
                    gemini: 'Gemini API',
                    openaiCustom: 'Custom OpenAI Format',
                    openaiCustomDesc: 'Use custom API endpoint',
                    openaiResponses: 'OpenAI Responses API',
                    anthropic: 'Anthropic API',
                    local: 'Local Estimation',
                    localDesc: '~4 chars = 1 token'
                },
                defaultDesc: {
                    gemini: 'Default uses Gemini countTokens API',
                    anthropic: 'Default uses Anthropic count_tokens API',
                    openai: 'Default uses local estimation (OpenAI has no official API)'
                },
                apiConfig: {
                    title: 'API Configuration',
                    url: 'API URL',
                    urlHint: 'Leave empty to use channel URL',
                    apiKey: 'API Key',
                    apiKeyPlaceholder: 'Enter API Key',
                    apiKeyHint: 'Leave empty to use channel API Key',
                    model: 'Model',
                    modelHint: 'Model name for token counting'
                }
            }
        },

        tools: {
            executing: 'Executing...',
            executed: 'Executed',
            failed: 'Execution Failed',
            cancelled: 'Cancelled',
            approve: 'Approve',
            reject: 'Reject',
            autoExecuted: 'Auto Executed',
            terminate: 'Terminate',
            saveToPath: 'Save to path',
            openFile: 'Open File',
            openFolder: 'Open Folder',
            viewDetails: 'View Details',
            hideDetails: 'Hide Details',
            parameters: 'Parameters',
            result: 'Result',
            error: 'Error',
            duration: 'Duration',
            file: {
                readFile: 'Read File',
                writeFile: 'Write File',
                deleteFile: 'Delete File',
                createDirectory: 'Create Directory',
                listFiles: 'List Files',
                applyDiff: 'Apply Diff',
                filesRead: 'Files read',
                filesWritten: 'Files written',
                filesDeleted: 'Files deleted',
                directoriesCreated: 'Directories created',
                changesApplied: 'Changes applied',
                applyDiffPanel: {
                    title: 'Apply Diff',
                    changes: 'changes',
                    diffApplied: 'Diff applied',
                    pending: 'Pending review',
                    accepted: 'Accepted',
                    rejected: 'Rejected',
                    partial: 'Partially accepted',
                    rejectedBlock: 'This block was rejected by the user',
                    line: 'From line',
                    diffNumber: '#',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count} lines',
                    copied: 'Copied',
                    copyNew: 'Copy new content',
                    deletedLines: 'Deleted',
                    addedLines: 'Added',
                    userEdited: 'User Edited',
                    userEditedContent: 'User modified content'
                },
                createDirectoryPanel: {
                    title: 'Create Directory',
                    total: 'Total {count}',
                    noDirectories: 'No directories to create',
                    success: 'Success',
                    failed: 'Failed'
                },
                deleteFilePanel: {
                    title: 'Delete File',
                    total: 'Total {count}',
                    noFiles: 'No files to delete',
                    success: 'Success',
                    failed: 'Failed'
                },
                listFilesPanel: {
                    title: 'List Files',
                    recursive: 'Recursive',
                    totalStat: '{dirCount} directories, {folderCount} folders, {fileCount} files',
                    copyAll: 'Copy all list',
                    copyList: 'Copy list',
                    dirStat: '{folderCount} folders, {fileCount} files',
                    lines: '{count} lines',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count}',
                    emptyDirectory: 'Directory is empty'
                },
                readFilePanel: {
                    title: 'Read File',
                    total: 'Total {count}',
                    lines: '{count} lines',
                    copied: 'Copied',
                    copyContent: 'Copy content',
                    binaryFile: 'Binary file',
                    unknownSize: 'Unknown size',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count} lines',
                    emptyFile: 'File is empty'
                },
                writeFilePanel: {
                    title: 'Write File',
                    total: 'Total {count}',
                    lines: '{count} lines',
                    copied: 'Copied',
                    copyContent: 'Copy content',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count} lines',
                    noContent: 'No content to write',
                    viewContent: 'Content',
                    viewDiff: 'Diff',
                    loadingDiff: 'Loading diff...',
                    actions: {
                        created: 'Created',
                        modified: 'Modified',
                        unchanged: 'Unchanged',
                        write: 'Write'
                    }
                }
            },
            search: {
                findFiles: 'Find Files',
                searchInFiles: 'Search in Files',
                filesFound: 'Files found',
                matchesFound: 'Matches found',
                noResults: 'No results',
                findFilesPanel: {
                    title: 'Find Files',
                    totalFiles: 'Total {count} files',
                    fileCount: '{count} files',
                    lines: '{count} lines',
                    truncated: 'Truncated',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count} files',
                    noFiles: 'No matching files found'
                },
                searchInFilesPanel: {
                    title: 'Search Content',
                    replaceTitle: 'Search and Replace',
                    regex: 'Regex',
                    matchCount: '{count} matches',
                    fileCount: '{count} files',
                    truncated: 'Truncated',
                    keywords: 'Keywords:',
                    replaceWith: 'Replace with:',
                    emptyString: '(empty string)',
                    path: 'Path:',
                    pattern: 'Pattern:',
                    noResults: 'No matching content found',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count} matches',
                    replacements: 'Replaced {count} occurrences',
                    replacementsInFile: '{count} replacements',
                    filesModified: '{count} files',
                    viewMatches: 'Matches',
                    viewDiff: 'Diff',
                    loadingDiff: 'Loading diff...',
                    omittedUnchangedLines: '… {count} unchanged lines omitted …'
                }
            },
            history: {
                historySearch: 'History Search',
                searchHistory: 'Search History',
                readHistory: 'Read History',
                readAll: 'All',
                panel: {
                    searchTitle: 'Search Summarized History',
                    readTitle: 'Read Summarized History',
                    regex: 'Regex',
                    keywords: 'Keywords:',
                    lineRange: 'Lines:',
                    lineCount: '{count} lines',
                    matchLineCount: '{count} matching lines',
                    blockCount: '{count} blocks',
                    contextBlock: 'Block {index}',
                    match: 'Match',
                    noContent: 'No content returned',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count} lines',
                    copyContent: 'Copy Content',
                    copied: 'Copied'
                }
            },
            terminal: {
                executeCommand: 'Execute Command',
                command: 'Command',
                output: 'Output',
                exitCode: 'Exit Code',
                running: 'Running',
                terminated: 'Terminated',
                terminateCommand: 'Terminate Command',
                executeCommandPanel: {
                    title: 'Terminal',
                    status: {
                        failed: 'Failed',
                        terminated: 'Terminated',
                        success: 'Success',
                        exitCode: 'Exit Code: {code}',
                        running: 'Running...',
                        pending: 'Pending'
                    },
                    terminate: 'Terminate',
                    terminateTooltip: 'Terminate Process',
                    copyOutput: 'Copy Output',
                    copied: 'Copied',
                    output: 'Output',
                    truncatedInfo: 'Showing last {outputLines} lines (total {totalLines} lines)',
                    autoScroll: 'Auto Scroll',
                    waitingOutput: 'Waiting for output...',
                    noOutput: 'No output',
                    executing: 'Command executing...'
                }
            },
            lsp: {
                getSymbols: 'Get Symbols',
                gotoDefinition: 'Go to Definition',
                findReferences: 'Find References',
                getSymbolsPanel: {
                    title: 'File Symbols',
                    totalFiles: 'Total {count} files',
                    totalSymbols: 'Total {count} symbols',
                    noSymbols: 'No symbols found',
                    symbolCount: '{count} symbols',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count}',
                    copyAll: 'Copy All',
                    copied: 'Copied'
                },
                gotoDefinitionPanel: {
                    title: 'Definition',
                    definitionFound: 'Definition found',
                    noDefinition: 'No definition found',
                    lines: '{count} lines',
                    copyCode: 'Copy Code',
                    copied: 'Copied'
                },
                findReferencesPanel: {
                    title: 'References',
                    totalReferences: 'Total {count} references',
                    totalFiles: '{count} files',
                    noReferences: 'No references found',
                    referencesInFile: '{count} references',
                    collapse: 'Collapse',
                    expandRemaining: 'Expand remaining {count}'
                }
            },
            mcp: {
                mcpTool: 'MCP Tool',
                serverName: 'Server Name',
                toolName: 'Tool Name',
                mcpToolPanel: {
                    requestParams: 'Request Parameters',
                    errorInfo: 'Error Information',
                    responseResult: 'Response Result',
                    imagePreview: 'Image Preview',
                    waitingResponse: 'Waiting for response...'
                }
            },
            subagents: {
                title: 'Sub-Agent',
                task: 'Task',
                context: 'Context',
                completed: 'Completed',
                failed: 'Failed',
                executing: 'Executing...',
                partialResponse: 'Partial Response',
                background: 'Background',
                steps: '{count} steps',
                noTools: 'No tools called',
                toolsUsed: 'Tools: {tools}'
            },
            media: {
                generateImage: 'Generate Image',
                resizeImage: 'Resize Image',
                cropImage: 'Crop Image',
                rotateImage: 'Rotate Image',
                removeBackground: 'Remove Background',
                generating: 'Generating...',
                processing: 'Processing...',
                imagesGenerated: 'Images generated',
                saveImage: 'Save Image',
                saveTo: 'Save to',
                saved: 'Saved',
                saveFailed: 'Save failed',
                cropImagePanel: {
                    title: 'Crop Image',
                    tasksFailed: '{count} tasks failed',
                    cancel: 'Cancel',
                    cancelCrop: 'Cancel Crop',
                    status: {
                        needDependency: 'Needs Dependency',
                        cancelled: 'Cancelled',
                        failed: 'Failed',
                        success: 'Success',
                        error: 'Error',
                        processing: 'Processing...',
                        waiting: 'Waiting'
                    },
                    checkingDependency: 'Checking dependency status...',
                    dependencyMessage: 'Cropping requires the sharp library to process images.',
                    batchCrop: 'Batch Crop ({count})',
                    cropTask: 'Crop Task',
                    coordsHint: 'Coordinate range 0-1000 (normalized), auto-converted to actual pixels',
                    cancelledMessage: 'User cancelled the crop operation',
                    resultTitle: 'Crop Results ({count} images)',
                    original: 'Original:',
                    cropped: 'Cropped:',
                    cropResultN: 'Crop Result {n}',
                    saved: 'Saved',
                    overwriteSave: 'Overwrite Save',
                    save: 'Save',
                    openInEditor: 'Open in Editor',
                    savePaths: 'Save Paths:',
                    croppingImages: 'Cropping images...',
                    openFileFailed: 'Failed to open file:',
                    saveFailed: 'Save failed'
                },
                generateImagePanel: {
                    title: 'Image Generation',
                    cancel: 'Cancel',
                    cancelGeneration: 'Cancel Generation',
                    status: {
                        needDependency: 'Needs Dependency',
                        cancelled: 'Cancelled',
                        failed: 'Failed',
                        success: 'Success',
                        error: 'Error',
                        generating: 'Generating...',
                        waiting: 'Waiting'
                    },
                    batchTasks: 'Batch Tasks ({count})',
                    generateTask: 'Generation Task',
                    outputPath: 'Output Path',
                    aspectRatio: 'Aspect Ratio',
                    imageSize: 'Image Size',
                    referenceImages: '{count} references',
                    cancelledMessage: 'User cancelled image generation',
                    tasksFailed: '{count} tasks failed',
                    resultTitle: 'Generated Results ({count} images)',
                    saved: 'Saved',
                    overwriteSave: 'Overwrite Save',
                    save: 'Save',
                    openInEditor: 'Open in Editor',
                    savePaths: 'Save Paths:',
                    generatingImages: 'Generating images...',
                    openFileFailed: 'Failed to open file:',
                    saveFailed: 'Save failed'
                },
                removeBackgroundPanel: {
                    title: 'Remove Background',
                    cancel: 'Cancel',
                    cancelRemove: 'Cancel Remove',
                    status: {
                        needDependency: 'Needs Dependency',
                        cancelled: 'Cancelled',
                        failed: 'Failed',
                        success: 'Success',
                        error: 'Error',
                        processing: 'Processing...',
                        waiting: 'Waiting',
                        disabled: 'Disabled'
                    },
                    checkingDependency: 'Checking dependency status...',
                    dependencyMessage: 'Background removal requires the sharp library to process images.',
                    batchTasks: 'Batch Tasks ({count})',
                    removeTask: 'Remove Background Task',
                    subjectDescription: 'Subject Description',
                    maskPath: 'Mask: {path}',
                    needSharp: {
                        title: 'Sharp library required',
                        message: 'Mask generated, but sharp library is required to complete full background removal.',
                        installCmd: 'pnpm add sharp'
                    },
                    cancelledMessage: 'User cancelled background removal',
                    tasksFailed: '{count} tasks failed',
                    resultTitle: 'Processing Results ({count} images)',
                    maskImage: 'Mask Image',
                    resultImage: 'Result Image {n}',
                    saved: 'Saved',
                    overwriteSave: 'Overwrite Save',
                    save: 'Save',
                    openInEditor: 'Open in Editor',
                    savePaths: 'Save Paths:',
                    processingImages: 'Processing images...',
                    openFileFailed: 'Failed to open file:',
                    saveFailed: 'Save failed'
                },
                resizeImagePanel: {
                    title: 'Resize Image',
                    tasksFailed: '{count} tasks failed',
                    cancel: 'Cancel',
                    cancelResize: 'Cancel Resize',
                    status: {
                        needDependency: 'Needs Dependency',
                        cancelled: 'Cancelled',
                        failed: 'Failed',
                        success: 'Success',
                        error: 'Error',
                        processing: 'Processing...',
                        waiting: 'Waiting'
                    },
                    checkingDependency: 'Checking dependency status...',
                    dependencyMessage: 'Resizing requires the sharp library to process images.',
                    batchResize: 'Batch Resize ({count})',
                    resizeTask: 'Resize Task',
                    sizeHint: 'Image will be stretched to fill target dimensions (aspect ratio not preserved)',
                    cancelledMessage: 'User cancelled resize operation',
                    resultTitle: 'Resize Results ({count} images)',
                    resizeResultN: 'Resize Result {n}',
                    dimensions: {
                        original: 'Original:',
                        resized: 'Resized:'
                    },
                    saved: 'Saved',
                    overwriteSave: 'Overwrite Save',
                    save: 'Save',
                    openInEditor: 'Open in Editor',
                    savePaths: 'Save Paths:',
                    resizingImages: 'Resizing images...',
                    openFileFailed: 'Failed to open file:',
                    saveFailed: 'Save failed'
                },
                rotateImagePanel: {
                    title: 'Rotate Image',
                    tasksFailed: '{count} tasks failed',
                    cancel: 'Cancel',
                    cancelRotate: 'Cancel Rotate',
                    status: {
                        needDependency: 'Needs Dependency',
                        cancelled: 'Cancelled',
                        failed: 'Failed',
                        success: 'Success',
                        error: 'Error',
                        processing: 'Processing...',
                        waiting: 'Waiting'
                    },
                    checkingDependency: 'Checking dependency status...',
                    dependencyMessage: 'Rotation requires the sharp library to process images.',
                    batchRotate: 'Batch Rotate ({count})',
                    rotateTask: 'Rotate Task',
                    angleHint: 'Positive angles rotate counterclockwise, negative angles rotate clockwise. PNG/WebP fills transparent, JPG fills black',
                    angleFormat: {
                        counterclockwise: 'counterclockwise',
                        clockwise: 'clockwise'
                    },
                    cancelledMessage: 'User cancelled rotate operation',
                    resultTitle: 'Rotate Results ({count} images)',
                    rotateResultN: 'Rotate Result {n}',
                    dimensions: {
                        rotation: 'Rotation:',
                        size: 'Size:'
                    },
                    saved: 'Saved',
                    overwriteSave: 'Overwrite Save',
                    save: 'Save',
                    openInEditor: 'Open in Editor',
                    savePaths: 'Save Paths:',
                    rotatingImages: 'Rotating images...',
                    openFileFailed: 'Failed to open file:',
                    saveFailed: 'Save failed'
                }
            }
        }
    },

    app: {
        retryPanel: {
            title: 'Request failed, retrying automatically',
            cancelTooltip: 'Cancel retry',
            defaultError: 'Request failed'
        },
        autoSummaryPanel: {
            summarizing: 'Auto summarizing...',
            manualSummarizing: 'Summarizing context...',
            cancelTooltip: 'Cancel summarize request'
        },
        agentStopNotification: {
            errorTitle: 'GrayCode Agent stopped',
            errorMessage: 'The current conversation failed. Click the notification to return to the originating window.',
            errorMessageWithConversation: 'Conversation "{title}" failed. Click the notification to return to the originating window.',
            awaitingUserActionTitle: 'GrayCode is waiting for your action',
            awaitingUserActionMessage: 'The current conversation needs you to click "{action}". Click the notification to return to the originating window.',
            awaitingUserActionMessageWithConversation: 'Conversation "{title}" needs you to click "{action}". Click the notification to return to the originating window.',
            continueRequiredTitle: 'GrayCode is waiting to continue',
            continueRequiredMessage: 'The current conversation needs to continue. Click the notification to return to the originating window.',
            continueRequiredMessageWithConversation: 'Conversation "{title}" needs to continue. Click the notification to return to the originating window.',
            actions: {
                generatePlan: 'Generate Plan',
                executePlan: 'Execute Plan',
                continue: 'Continue',
                genericConfirmation: 'Return to GrayCode and continue'
            }
        }
    },

    errors: {
        networkError: 'Network error, please check your connection',
        apiError: 'API request failed',
        timeout: 'Request timeout',
        invalidConfig: 'Invalid configuration',
        fileNotFound: 'File not found',
        permissionDenied: 'Permission denied',
        unknown: 'Unknown error',
        connectionFailed: 'Connection failed',
        authFailed: 'Authentication failed',
        rateLimited: 'Rate limited, please try again later',
        serverError: 'Server error',
        invalidResponse: 'Invalid response format',
        cancelled: 'Operation cancelled'
    },

    composables: {
        useAttachments: {
            errors: {
                validationFailed: 'Attachment validation failed',
                createThumbnailFailed: 'Failed to create thumbnail',
                createVideoThumbnailFailed: 'Failed to create video thumbnail',
                readFileFailed: 'Failed to read file',
                loadVideoFailed: 'Failed to load video',
                readResultNotString: 'Read result is not a string'
            }
        }
    },

    stores: {
        terminalStore: {
            errors: {
                killTerminalFailed: 'Failed to kill terminal',
                refreshOutputFailed: 'Failed to refresh terminal output'
            }
        },
        chatStore: {
            defaultTitle: 'Untitled',
            errors: {
                loadConversationsFailed: 'Failed to load conversations',
                createConversationFailed: 'Failed to create conversation',
                deleteConversationFailed: 'Failed to delete conversation',
                sendMessageFailed: 'Failed to send message',
                streamError: 'Stream response error',
                loadHistoryFailed: 'Failed to load history',
                retryFailed: 'Retry failed',
                editRetryFailed: 'Edit retry failed',
                deleteFailed: 'Delete failed',
                noConversationSelected: 'No conversation selected',
                unknownError: 'Unknown error',
                restoreFailed: 'Restore failed',
                restoreCheckpointFailed: 'Failed to restore checkpoint',
                restoreRetryFailed: 'Restore and retry failed',
                restoreDeleteFailed: 'Restore and delete failed',
                noConfigSelected: 'No config selected',
                summarizeFailed: 'Summarize failed',
                restoreEditFailed: 'Restore and edit failed',
                messageChanged: 'Message has changed, please refresh the history and try again'
            },
            relativeTime: {
                justNow: 'Just now',
                minutesAgo: '{minutes}m ago',
                hoursAgo: '{hours}h ago',
                daysAgo: '{days}d ago'
            }
        }
    }
};

export default en;
