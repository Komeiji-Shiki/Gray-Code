/**
 * GrayCode Backend - English Language Pack
 */

import type { BackendLanguageMessages } from '../types';

const en: BackendLanguageMessages = {
    modules: {
        config: {
            errors: {
                configNotFound: 'Configuration not found: {configId}',
                configExists: 'Configuration already exists: {configId}, use overwrite option to replace',
                invalidConfig: 'Invalid configuration',
                validationFailed: 'Configuration validation failed: {errors}',
                saveFailed: 'Failed to save configuration',
                loadFailed: 'Failed to load configuration'
            },
            validation: {
                nameRequired: 'Name is required',
                typeRequired: 'Type is required',
                invalidUrl: 'API URL is invalid',
                apiKeyEmpty: 'API Key is empty, configuration required before use',
                modelNotSelected: 'Models available but none selected',
                temperatureRange: 'temperature must be between 0.0 and 2.0',
                maxOutputTokensMin: 'maxOutputTokens must be greater than 0',
                maxOutputTokensHigh: 'maxOutputTokens is too high, may cause high latency',
                temperatureRangeAnthropic: 'temperature must be between 0.0 and 1.0 (Anthropic)',
                maxTokensMin: 'max_tokens must be greater than 0',
                topPRange: 'top_p must be between 0.0 and 1.0',
                topKMin: 'top_k must be greater than or equal to 0',
                thinkingBudgetMin: 'thinking.budget_tokens must be at least 1024',
                unsupportedType: 'Unsupported channel type: {type}',
                retryCountInvalid: 'retryCount must be a non-negative integer',
                retryIntervalInvalid: 'retryInterval must be a positive number',
                timeoutInvalid: 'timeout must be a positive number'
            }
        },

        conversation: {
            defaultTitle: 'Conversation {conversationId}',
            errors: {
                conversationNotFound: 'Conversation not found: {conversationId}',
                conversationExists: 'Conversation already exists: {conversationId}',
                messageNotFound: 'Message not found: {messageId}',
                messageIndexOutOfBounds: 'Message index out of bounds: {index}',
                snapshotNotFound: 'Snapshot not found: {snapshotId}',
                snapshotNotBelongToConversation: 'Snapshot does not belong to this conversation',
                saveFailed: 'Failed to save conversation',
                loadFailed: 'Failed to load conversation'
            }
        },

        mcp: {
            errors: {
                connectionFailed: 'Connection failed: {serverName}',
                serverNotFound: 'Server not found: {serverId}',
                serverNotFoundWithAvailable: 'Server not found: {serverId}. Available servers: {available}',
                serverDisabled: 'Server is disabled: {serverId}',
                serverNotConnected: 'Server not connected: {serverName}',
                clientNotConnected: 'Client not connected',
                toolCallFailed: 'Tool call failed',
                requestTimeout: 'Request timeout ({timeout}ms)',
                invalidServerId: 'ID can only contain letters, numbers, underscores and hyphens',
                serverIdExists: 'Server ID "{serverId}" already exists'
            },
            status: {
                connecting: 'Connecting...',
                connected: 'Connected',
                disconnected: 'Disconnected',
                error: 'Error'
            }
        },

        checkpoint: {
            description: {
                before: 'Before',
                after: 'After'
            },
            restore: {
                success: 'Restored to "{toolName}" {phase} state',
                filesUpdated: '{count} files updated',
                filesDeleted: '{count} files deleted',
                filesUnchanged: '{count} files unchanged',
                chainBroken: 'Incremental chain is broken: a referenced base checkpoint is missing',
                partialFailure: 'Restored to "{toolName}" {phase} state with {count} failure(s)',
                workspaceMismatch: 'Current workspace does not match the workspace recorded in this checkpoint; restore refused',
                multiRootLegacyNotSupported: 'Legacy checkpoints (relative path format) cannot be restored in a multi-root workspace',
                checkpointNotFound: 'Checkpoint not found',
                manifestMissing: 'Checkpoint backup data is missing (manifest not found)',
                cannotBuildChain: 'Cannot build checkpoint chain',
                backupDirNotFound: 'Backup directory not found: {dirs}',
                moreFailures: 'and {count} more failures',
                excludedNote: 'This checkpoint excluded {count} file(s) under the exclusion rules in effect when it was created',
                excludedNoteChanged: 'This checkpoint excluded {count} file(s) under the rules in effect when it was created; current exclusion rules have changed, restore will follow current rules'
            },
            defaultConversationTitle: 'Conversation {conversationId}',
            errors: {
                createFailed: 'Failed to create checkpoint',
                restoreFailed: 'Failed to restore checkpoint',
                deleteFailed: 'Failed to delete checkpoint'
            }
        },

        settings: {
            errors: {
                loadFailed: 'Failed to load settings',
                saveFailed: 'Failed to save settings',
                invalidValue: 'Invalid setting value',
                invalidCheckpointExclusionPatterns: 'Invalid checkpoint exclusion pattern(s): {detail}',
                invalidCheckpointExclusionProfiles: 'Invalid checkpoint exclusion profile(s): {detail}',
                invalidCheckpointMaxFileSize: 'Max file size must be a finite number',
                invalidCheckpointConfigField: 'Invalid checkpoint config field: {field}',
                exclusionPatternReason: {
                    empty: 'empty pattern',
                    absolute: 'absolute path pattern',
                    negationOnly: 'bare ! negation (no rule body)',
                    traversal: 'contains .. traversal',
                    newline: 'contains newline',
                    blanket: 'excludes the entire workspace'
                }
            },
            storage: {
                pathNotAbsolute: 'Path must be absolute: {path}',
                pathNotDirectory: 'Path must be a directory: {path}',
                createDirectoryFailed: 'Failed to create directory: {error}',
                migrationFailed: 'Migration failed: {error}',
                migrationSuccess: 'Storage migration completed',
                migratingFiles: 'Migrating files...',
                migratingConversations: 'Migrating conversations...',
                migratingCheckpoints: 'Migrating checkpoints...',
                migratingConfigs: 'Migrating configs...'
            },
            exporter: {
                parseFailed: 'Failed to parse export file: {error}',
                invalidRoot: 'Invalid export file format: root element must be an object',
                missingVersion: 'Export file is missing the version field',
                unsupportedVersion: 'Unsupported export file version: {version} (only {supported} is supported)',
                missingChannelConfigs: 'Export file is missing the channelConfigs array',
                missingMcpServers: 'Export file is missing the mcpServers array',
                missingSkills: 'Export file is missing the skills array',
                missingVscodeSettings: 'Export file is missing the vscodeSettings object',
                importVscodeSettingsFailed: 'Failed to import VSCode settings: {error}',
                importChannelConfigsFailed: 'Failed to import channel configs: {error}',
                importMcpServersFailed: 'Failed to import MCP server configs: {error}',
                importSkillsFailed: 'Failed to import skills: {error}',
                reloadSettingsFailed: 'Failed to reload settings: {error}',
                partialVscodeSettingsImportFailed: 'Some VSCode settings failed to import: {detail}',
                channelConfigItemError: 'Channel config "{name}": {error}',
                partialChannelConfigsImportFailed: 'Some channel configs failed to import: {detail}',
                mcpServerItemError: 'MCP server "{name}": {error}',
                partialMcpServersImportFailed: 'Some MCP server configs failed to import: {detail}',
                skillItemError: 'Skill "{name}": {error}',
                skillRestoreError: 'Skill "{name}" enabled state restore: {error}',
                skillRestoreFailuresSummary: 'Failed to restore enabled state for {count} skill(s) (files already imported): {detail}',
                partialSkillsImportFailed: 'Some skills failed to import: {detail}'
            }
        },

        update: {
            errors: {
                cannotReadVersion: 'Failed to read the current extension version',
                invalidDownloadUrl: 'Invalid download URL: only vsix packages from this repository\'s GitHub Releases are accepted.',
                invalidVersion: 'Invalid version: {version}',
                downloadFailed: 'Download failed: HTTP {status} {statusText}',
                emptyDownload: 'Downloaded content is empty; the vsix may be corrupted.',
                downloadTimeout: 'Download timed out (exceeded {seconds} seconds)',
                apiError: 'GitHub Releases API returned {status} {statusText}',
                apiResponseInvalid: 'Unexpected GitHub Releases API response format',
                checkTimeout: 'Update check timed out (exceeded {seconds} seconds)'
            }
        },

        dependencies: {
            descriptions: {
                sharp: 'High-performance image processing library for mask application in background removal'
            },
            errors: {
                requiresContext: 'DependencyManager requires ExtensionContext on first call',
                unknownDependency: 'Unknown dependency: {name}',
                nodeModulesNotFound: 'node_modules directory not found after installation',
                moduleNotFound: '{name} module not found after installation',
                installFailed: 'Installation failed: {error}',
                uninstallFailed: 'Failed to uninstall {name}',
                loadFailed: 'Failed to load {name}'
            },
            progress: {
                installing: 'Installing {name}...',
                downloading: 'Downloading {name}...',
                installSuccess: '{name} installed successfully!'
            }
        },

        channel: {
            formatters: {
                streamError: '{provider} returned an error in the stream: {message}',
                gemini: {
                    errors: {
                        invalidResponse: 'Invalid Gemini API response: no candidates',
                        apiError: 'API returned error status: {code}',
                        emptyCandidate: 'Gemini returned a candidate with no content (finishReason: {finishReason}, possibly a safety block)'
                    }
                },
                anthropic: {
                    errors: {
                        invalidResponse: 'Invalid Anthropic API response: no content'
                    }
                },
                openai: {
                    errors: {
                        invalidResponse: 'Invalid OpenAI API response: no choices'
                    }
                }
            },
            errors: {
                configNotFound: 'Configuration not found: {configId}',
                configDisabled: 'Configuration is disabled: {configId}',
                unsupportedChannelType: 'Unsupported channel type: {type}',
                configValidationFailed: 'Configuration validation failed: {configId}',
                buildRequestFailed: 'Failed to build request: {error}',
                apiError: 'API returned error status: {status}',
                parseResponseFailed: 'Failed to parse response: {error}',
                httpRequestFailed: 'HTTP request failed: {error}',
                parseStreamChunkFailed: 'Failed to parse stream chunk: {error}',
                streamRequestFailed: 'Stream request failed: {error}',
                requestTimeout: 'Request timeout ({timeout}ms)',
                requestTimeoutNoResponse: 'Request timeout (no response in {timeout}ms)',
                requestCancelled: 'Request cancelled',
                requestAborted: 'Request aborted',
                noResponseBody: 'No response body',
                emptyResponse: 'The model returned an empty response',
                streamTruncated: 'Stream output was truncated (no completion marker received), possibly due to network/proxy interruption',
                streamBufferOverflow: 'Stream buffer exceeded the size limit: upstream data could not be parsed (buffer kept growing without being consumed)',
                invalidRetryConfig: 'Invalid retry configuration: {configId} (retryCount must be a non-negative integer)'
            },
            modelList: {
                errors: {
                    apiKeyRequired: 'API Key is required',
                    fetchModelsFailed: 'Failed to fetch models: {error}',
                    unsupportedConfigType: 'Unsupported config type: {type}'
                }
            }
        },

        api: {
            channel: {
                errors: {
                    listChannelsFailed: 'Failed to list channel configurations',
                    channelNotFound: 'Channel configuration not found: {channelId}',
                    getChannelFailed: 'Failed to get channel configuration',
                    channelAlreadyExists: 'Channel configuration already exists: {channelId}',
                    createChannelFailed: 'Failed to create channel configuration',
                    updateChannelFailed: 'Failed to update channel configuration',
                    deleteChannelFailed: 'Failed to delete channel configuration',
                    setChannelStatusFailed: 'Failed to set channel status'
                }
            },
            settings: {
                errors: {
                    getSettingsFailed: 'Failed to get settings',
                    updateSettingsFailed: 'Failed to update settings',
                    setActiveChannelFailed: 'Failed to set active channel',
                    setToolStatusFailed: 'Failed to set tool status',
                    batchSetToolStatusFailed: 'Failed to batch set tool status',
                    setDefaultToolModeFailed: 'Failed to set default tool mode',
                    updateUISettingsFailed: 'Failed to update UI settings',
                    updateProxySettingsFailed: 'Failed to update proxy settings',
                    resetSettingsFailed: 'Failed to reset settings',
                    toolRegistryNotAvailable: 'Tool registry not available',
                    getToolsListFailed: 'Failed to get tools list',
                    getToolConfigFailed: 'Failed to get tool config',
                    updateToolConfigFailed: 'Failed to update tool config',
                    updateListFilesConfigFailed: 'Failed to update list_files config',
                    updateApplyDiffConfigFailed: 'Failed to update apply_diff config',
                    getCheckpointConfigFailed: 'Failed to get checkpoint config',
                    updateCheckpointConfigFailed: 'Failed to update checkpoint config',
                    getSummarizeConfigFailed: 'Failed to get summarize config',
                    updateSummarizeConfigFailed: 'Failed to update summarize config',
                    getGenerateImageConfigFailed: 'Failed to get generate image config',
                    updateGenerateImageConfigFailed: 'Failed to update generate image config',
                    tokenCountFailed: 'Token count failed',
                    toolNotFound: 'Tool not found: {toolName}',
                    memoryConfigFailed: 'Failed to get memory config',
                    updateMemoryConfigFailed: 'Failed to update memory config'
                }
            },
            models: {
                errors: {
                    configNotFound: 'Configuration not found',
                    getModelsFailed: 'Failed to get models list',
                    addModelsFailed: 'Failed to add models',
                    removeModelFailed: 'Failed to remove model',
                    modelNotInList: 'Model not in list',
                    setActiveModelFailed: 'Failed to set active model'
                }
            },
            mcp: {
                errors: {
                    listServersFailed: 'Failed to get MCP server list',
                    serverNotFound: 'MCP server not found: {serverId}',
                    getServerFailed: 'Failed to get MCP server',
                    createServerFailed: 'Failed to create MCP server',
                    updateServerFailed: 'Failed to update MCP server',
                    deleteServerFailed: 'Failed to delete MCP server',
                    setServerStatusFailed: 'Failed to set MCP server status',
                    connectServerFailed: 'Failed to connect MCP server',
                    disconnectServerFailed: 'Failed to disconnect MCP server'
                }
            },
            chat: {
                errors: {
                    configNotFound: 'Configuration not found: {configId}',
                    configDisabled: 'Configuration disabled: {configId}',
                    maxToolIterations: 'Maximum tool call iterations reached ({maxIterations})',
                    unknownError: 'Unknown error',
                    toolExecutionSuccess: 'Tool execution successful',
                    mcpToolCallFailed: 'MCP tool call failed',
                    invalidMcpToolName: 'Invalid MCP tool name: {toolName}',
                    toolNotFound: 'Tool not found: {toolName}',
                    toolExecutionFailed: 'Tool execution failed',
                    noHistory: 'Conversation history is empty',
                    lastMessageNotModel: 'Last message is not a model message',
                    noFunctionCalls: 'No pending function calls',
                    userRejectedTool: 'User rejected tool execution',
                    toolCallCancelled: 'User cancelled the request; this tool call was not executed',
                    notEnoughRounds: 'Not enough conversation rounds, current {currentRounds}, keeping {keepRounds}, no summary needed',
                    notEnoughContent: 'Not enough conversation rounds, current {currentRounds}, keeping {keepRounds}, no content to summarize',
                    noMessagesToSummarize: 'No messages to summarize',
                    summarizeAborted: 'Summarize request aborted',
                    emptySummary: 'AI generated summary is empty',
                    lowQualitySummary: 'AI generated summary is too short and may lose important information; history was not replaced',
                    summarizeRangeStale: 'Conversation history changed while summarizing; the summary range is stale and was not written',
                    messageNotFound: 'Message not found: index {messageIndex}',
                    canOnlyEditUserMessage: 'Can only edit user messages, current message role: {role}',
                    messageChanged: 'Message has changed, please refresh and try again',
                    invalidTargetIndex: 'Invalid delete target index: {targetIndex}',
                    editTargetNotInHistory: 'The selected message is no longer in the current conversation history; it may have been removed by context compaction',
                    contextOverflow: 'Unable to build a legal request within the model context window: the smallest candidate needs about {estimatedInputTokens} input tokens, exceeding the {inputTokenLimit}-token window. Please increase the model context window, or reduce history/keep budget',
                    summarizeContextOverflow: 'Content to summarize plus the summary prompt exceeds the summarization model context limit. Please increase the summarization model context window or adjust the keep budget'
                },
                prompts: {
                    defaultSummarizePrompt: `Please summarize the above conversation content concisely, output the summary directly without any format markers.

Requirements:
1. Keep key information and context points
2. Remove redundant content and tool call details
3. Summarize the topic, discussed problems, and conclusions
4. Keep important technical details and decisions
5. Output summary content directly without any prefix, title, or format markers`,
                    summaryPrefix: '[Conversation Summary]',
                    autoSummarizePrompt: `Please summarize the above conversation history and output the following sections, so that the AI can continue completing the unfinished tasks.

## User Requirements
What the user wants to accomplish (overall goal).

## Completed Work
List what has been done in chronological order, including which files were changed and what decisions were made.
File paths, variable names, and configuration values must be preserved exactly, do not generalize.

## Current Progress
What step has been reached, what is currently being done.

## TODO Items
What still needs to be done, listed by priority.

## Important Conventions
Constraints, preferences, and technical requirements raised by the user (e.g., "do not use third-party libraries", "use TypeScript", etc.).

Output content directly without any prefix.`
                }
            }
        }
    },

    tools: {
        errors: {
            toolNotFound: 'Tool not found: {toolName}',
            executionFailed: 'Tool execution failed: {error}',
            invalidParams: 'Invalid parameters',
            timeout: 'Execution Timeout'
        },

        file: {
            errors: {
                fileNotFound: 'File not found: {path}',
                readFailed: 'Failed to read file: {error}',
                writeFailed: 'Failed to write file: {error}',
                deleteFailed: 'Failed to delete file: {error}',
                permissionDenied: 'Permission denied: {path}'
            },
            diffManager: {
                saved: 'Saved changes: {filePath}',
                saveFailed: 'Save failed: {error}',
                savedShort: 'Saved: {filePath}',
                rejected: 'Rejected changes: {filePath}',
                diffTitle: '{filePath} (AI changes - Ctrl+S to save)',
                diffGuardWarning: 'This change deletes {deletePercent}% of the file content ({deletedLines}/{totalLines} lines), exceeding the {threshold}% guard threshold. Please review carefully.'
            },
            diffCodeLens: {
                accept: 'Accept',
                reject: 'Reject',
                acceptAll: 'Accept All',
                rejectAll: 'Reject All'
            },
            diffEditorActions: {
                noActiveDiff: 'No pending diff changes',
                allBlocksProcessed: 'All diff blocks have been processed',
                diffBlock: 'Diff Block #{index}',
                lineRange: 'Lines {start}-{end}',
                acceptAllBlocks: 'Accept All Blocks',
                rejectAllBlocks: 'Reject All Blocks',
                blocksCount: '{count} pending block(s)',
                selectBlockToAccept: 'Select Diff Block to Accept',
                selectBlockToReject: 'Select Diff Block to Reject',
                selectBlockPlaceholder: 'You can select multiple'
            },
            diffInline: {
                hoverOrLightbulb: 'Hover or click 💡 to apply',
                acceptBlock: 'Accept Diff Block #{index}',
                rejectBlock: 'Reject Diff Block #{index}',
                acceptAll: 'Accept All Changes',
                rejectAll: 'Reject All Changes'
            },
            readFile: {
                cannotReadFile: 'Cannot read this file'
            },
            selectionContext: {
                hoverAddToInput: 'Add selection to input',
                codeActionAddToInput: 'LimCode: Add selection to input',
                noActiveEditor: 'No active editor',
                noSelection: 'No selection',
                failedToAddSelection: 'Failed to add selection: {error}'
            }
        },

        terminal: {
            errors: {
                executionFailed: 'Command execution failed',
                timeout: 'Command execution timeout',
                killed: 'Command was terminated'
            },
            shellCheck: {
                wslNotInstalled: 'WSL is not installed or not enabled',
                shellNotFound: 'Not found: {shellPath}',
                shellNotInPath: '{shellPath} is not in PATH'
            }
        },

        search: {
            errors: {
                searchFailed: 'Search failed: {error}',
                invalidPattern: 'Invalid search pattern: {pattern}'
            }
        },

        media: {
            errors: {
                processingFailed: 'Processing failed: {error}',
                invalidFormat: 'Invalid format: {format}',
                dependencyMissing: 'Missing dependency: {dependency}'
            }
        },
        
        common: {
            taskNotFound: 'Task {id} not found or already completed',
            cancelTaskFailed: 'Failed to cancel task: {error}',
            toolAlreadyExists: 'Tool already exists: {name}',
            show: 'Show',
            hide: 'Hide'
        },
        
        skills: {
            exampleSkill: {
                description: 'Read before creating a Skill! Learn the correct format, naming rules, and common mistakes.',
                content: `# Read Before Creating a Skill

## ⚠️ Common Mistakes

1. **name must exactly match the folder name**
   - If the folder is \`my-tool\`, the frontmatter must have \`name: my-tool\`
   - A mismatch causes the Skill to be silently skipped

2. **name only allows lowercase letters, digits, and hyphens**
   - ✅ \`my-skill-name\`, \`tool2\`
   - ❌ \`My_Skill\`, \`工具\`, \`my--skill\` (no consecutive hyphens)
   - Length: 1-64 characters

3. **Frontmatter is required**
   - The file must start with \`---\` and contain both \`name\` and \`description\` fields
   - A SKILL.md without frontmatter will be ignored

## Skill File Format

\`\`\`markdown
---
name: your-skill-name
description: "Brief description of what this skill does and when to use it"
---

# Your Skill Name

## Instructions
[Clear, step-by-step guidance for the AI to follow]

## Examples
[Specific examples of using this skill]
\`\`\`

## Steps to Create

1. Create a folder in the skills directory (the folder name is the skill name)
2. Create a \`SKILL.md\` file inside the folder
3. Add frontmatter at the top (\`name\` + \`description\`)
4. Write your skill content after the frontmatter

## Skills Directory Locations

- Project-level: \`.graycode/skills/\` or \`.agents/skills/\`
- User-level: \`~/.graycode/skills/\` or \`~/.agents/skills/\`

Project-level takes priority. Duplicate skill names only load the highest-priority one.

## How It Works

1. The AI sees the name and description of all enabled Skills in the tool description
2. When the AI needs one, it calls the \`read_skill\` tool to read the full content
3. This on-demand loading saves tokens and lets the AI dynamically choose the right knowledge module`
            },
            errors: {
                managerNotInitialized: 'Skills manager not initialized'
            }
        },
        
        history: {
            noSummarizedHistory: 'No summarized history found. Context summarization has not been triggered yet in this conversation.',
            noHistory: 'No conversation history found.',
            searchResultHeader: 'Found {count} match(es) for "{query}" in history ({totalLines} total lines)',
            noMatchesFound: 'No matches found for "{query}" in history ({totalLines} total lines). Try different keywords.',
            keywordFallbackNotice: '[No exact phrase match; searched individual whitespace-separated keywords instead: {terms}]',
            resultsLimited: '[Results limited to {max} matches. Try a more specific query to narrow results.]',
            readResultHeader: 'Lines {start}-{end} of {totalLines} total lines in history',
            readTruncated: '[Output limited to {max} lines. Use start_line={nextStart} to continue reading.]',
            invalidRegex: 'Invalid regular expression: {error}',
            invalidRange: 'Invalid line range: {start}-{end} (document has {totalLines} lines)',
            errors: {
                contextRequired: 'Tool context is required',
                conversationIdRequired: 'conversationId is required in tool context',
                conversationStoreRequired: 'conversationStore is required in tool context',
                getHistoryNotAvailable: 'conversationStore.getHistory is not available',
                invalidMode: 'Invalid mode: "{mode}". Must be "search" or "read"',
                queryRequired: 'query parameter is required for search mode',
                searchFailed: 'History search failed: {error}'
            }
        },
        reviewDocument: {
            sections: {
                scope: 'Review Scope',
                summary: 'Review Summary',
                findings: 'Review Findings',
                milestones: 'Review Milestones',
                finalConclusion: 'Review Final Conclusion',
                snapshot: 'Review Snapshot'
            },
            header: {
                date: 'Date',
                overview: 'Overview',
                status: 'Status',
                overallDecision: 'Overall decision'
            },
            summary: {
                currentStatus: 'Current status',
                reviewedModules: 'Reviewed Modules',
                currentProgress: 'Current Progress',
                totalMilestones: 'Total milestones',
                completedMilestones: 'Completed milestones',
                totalFindings: 'Total findings',
                findingsBySeverity: 'Findings by severity',
                latestConclusion: 'Latest Conclusion',
                recommendedNextAction: 'Recommended Next Action',
                overallDecision: 'Overall decision'
            },
            finding: {
                severity: 'Severity',
                category: 'Category',
                trackingStatus: 'Tracking Status',
                description: 'Description',
                recommendation: 'Recommendation',
                relatedMilestones: 'Related Milestones',
                evidenceFiles: 'Evidence'
            },
            milestone: {
                status: 'Status',
                recordedAt: 'Recorded at',
                reviewedModules: 'Reviewed Modules',
                summary: 'Summary',
                conclusion: 'Conclusion',
                evidenceFiles: 'Evidence',
                recommendedNextAction: 'Recommended Next Action',
                findings: 'Findings'
            },
            values: {
                pending: 'Pending',
                milestoneStatus: {
                    inProgress: 'In Progress',
                    completed: 'Completed'
                },
                overallDecision: {
                    pending: 'Pending',
                    accepted: 'Accepted',
                    conditionallyAccepted: 'Conditionally Accepted',
                    rejected: 'Rejected',
                    needsFollowUp: 'Needs Follow-up'
                },
                severity: {
                    high: 'High',
                    medium: 'Medium',
                    low: 'Low'
                },
                category: {
                    html: 'HTML',
                    css: 'CSS',
                    javascript: 'JavaScript',
                    accessibility: 'Accessibility',
                    performance: 'Performance',
                    maintainability: 'Maintainability',
                    docs: 'Docs',
                    test: 'Test',
                    other: 'Other'
                },
                trackingStatus: {
                    open: 'Open',
                    acceptedRisk: 'Accepted Risk',
                    fixed: 'Fixed',
                    wontFix: 'Won\'t Fix',
                    duplicate: 'Duplicate'
                }
            },
            placeholders: {
                noMilestones: '<!-- no milestones -->',
                noFindings: '<!-- no findings -->',
                defaultReviewScope: '_Review scope not provided._',
                defaultFinalConclusion: '_Final conclusion is pending._'
            },
            templates: {
                currentProgressWithLatest: '{count} milestones recorded; latest: {latestId}',
                currentProgressEmpty: '0 milestones recorded',
                findingsBySeverity: 'high {high} / medium {medium} / low {low}'
            }
        }
    },
    
    notifications: {
        windowsAgentStop: {
            currentWindow: 'Current Window',
            reasonLabels: {
                error: 'Failure',
                awaitingUserAction: 'Waiting for User Action',
                continueRequired: 'Waiting to Continue'
            },
            actionLabels: {
                generatePlan: 'Generate Plan',
                executePlan: 'Execute Plan',
                continue: 'Continue',
                genericConfirmation: 'Confirm'
            }
        }
    },
    
    workspace: {
        noWorkspaceOpen: 'No workspace open',
        singleWorkspace: 'Workspace: {path}',
        multiRootMode: 'Multi-root workspace mode:',
        useWorkspaceFormat: 'Use "workspace_name/path" format to access files in specific workspace'
    },
    
    multimodal: {
        cannotReadFile: 'Cannot read {ext} file: Multimodal tools are not enabled. Please enable "Multimodal Tools" option in channel settings.',
        cannotReadBinaryFile: 'Cannot read binary file {ext}: This file format is not supported.',
        cannotReadImage: 'Cannot read {ext} image: Current channel type does not support image reading.',
        cannotReadDocument: 'Cannot read {ext} document: Current channel type does not support document reading. OpenAI format only supports images, not documents.'
    },
    
    webview: {
        errors: {
            noWorkspaceOpen: 'No workspace open',
            workspaceNotFound: 'Workspace not found',
            invalidFileUri: 'Invalid file URI',
            pathNotFile: 'Path is not a file',
            fileNotExists: 'File does not exist',
            fileNotInWorkspace: 'File is not in current workspace',
            fileNotInAnyWorkspace: 'File is not in any open workspace',
            fileInOtherWorkspace: 'File belongs to another workspace: {workspaceName}',
            readFileFailed: 'Failed to read file',
            attachmentTooLarge: 'File is too large (over {maxSizeMB}MB), please use file picker or preview instead',
            conversationFileNotExists: 'Conversation file does not exist',
            cannotRevealInExplorer: 'Cannot reveal in explorer',
            
            deleteMessageFailed: 'Failed to delete message',
            
            interruptMessageInvalidConversation: 'Invalid conversation ID',
            interruptMessageEmptyText: 'Message text must not be empty',
            interruptMessageConversationNotFound: 'Conversation not found',
            interruptMessageRateLimited: 'Messages can be inserted too frequently, please try again later',
            interruptMessageFailed: 'Failed to insert message',
            
            getModelsFailed: 'Failed to get models list',
            addModelsFailed: 'Failed to add models',
            removeModelFailed: 'Failed to remove model',
            setActiveModelFailed: 'Failed to set active model',
            
            updateUISettingsFailed: 'Failed to update UI settings',
            getSettingsFailed: 'Failed to get settings',
            updateSettingsFailed: 'Failed to update settings',
            setActiveChannelFailed: 'Failed to set active channel',
            
            getToolsFailed: 'Failed to get tools list',
            setToolEnabledFailed: 'Failed to set tool status',
            getToolConfigFailed: 'Failed to get tool config',
            updateToolConfigFailed: 'Failed to update tool config',
            getAutoExecConfigFailed: 'Failed to get auto exec config',
            getMcpToolsFailed: 'Failed to get MCP tools list',
            setToolAutoExecFailed: 'Failed to set tool auto exec',
            updateListFilesConfigFailed: 'Failed to update list_files config',
            updateApplyDiffConfigFailed: 'Failed to update apply_diff config',
            updateExecuteCommandConfigFailed: 'Failed to update terminal config',
            checkShellFailed: 'Failed to check shell',
            
            killTerminalFailed: 'Failed to kill terminal',
            getTerminalOutputFailed: 'Failed to get terminal output',
            
            cancelImageGenFailed: 'Failed to cancel image generation',
            
            cancelTaskFailed: 'Failed to cancel task',
            getTasksFailed: 'Failed to get tasks list',
            
            getCheckpointConfigFailed: 'Failed to get checkpoint config',
            updateCheckpointConfigFailed: 'Failed to update checkpoint config',
            getCheckpointsFailed: 'Failed to get checkpoints list',
            createCheckpointFailed: 'Failed to create checkpoint',
            restoreCheckpointFailed: 'Failed to restore checkpoint',
            previewRestoreFailed: 'Failed to preview restore',
            deleteCheckpointFailed: 'Failed to delete checkpoint',
            deleteAllCheckpointsFailed: 'Failed to delete all checkpoints',
            deleteCheckpointsBatchFailed: 'Failed to batch delete checkpoints',
            getConversationsWithCheckpointsFailed: 'Failed to get conversations with checkpoints',
            previewExclusionsFailed: 'Failed to preview exclusions',
            previewExclusionsNoWorkspace: 'No workspace root available',
            getCheckpointManifestFailed: 'Failed to load checkpoint manifest',
            getCheckpointOperationProgressFailed: 'Failed to get checkpoint operation progress',
            cancelCheckpointOperationFailed: 'Failed to cancel checkpoint operation',
            
            openDiffPreviewFailed: 'Failed to open diff preview',
            diffContentNotFound: 'Diff content not found or expired',
            loadDiffContentFailed: 'Failed to load diff content',
            invalidDiffData: 'Invalid diff data',
            noFileContent: 'No file content',
            unsupportedToolType: 'Unsupported tool type: {toolName}',
            
            getRelativePathFailed: 'Failed to get relative path',
            previewAttachmentFailed: 'Failed to preview attachment',
            readImageFailed: 'Failed to read image',
            openFileFailed: 'Failed to open file',
            saveImageFailed: 'Failed to save image',
            
            openMcpConfigFailed: 'Failed to open MCP config file',
            getMcpServersFailed: 'Failed to get MCP servers list',
            validateMcpServerIdFailed: 'Failed to validate MCP server ID',
            createMcpServerFailed: 'Failed to create MCP server',
            updateMcpServerFailed: 'Failed to update MCP server',
            deleteMcpServerFailed: 'Failed to delete MCP server',
            connectMcpServerFailed: 'Failed to connect MCP server',
            disconnectMcpServerFailed: 'Failed to disconnect MCP server',
            setMcpServerEnabledFailed: 'Failed to set MCP server status',
            
            getSummarizeConfigFailed: 'Failed to get summarize config',
            updateSummarizeConfigFailed: 'Failed to update summarize config',
            summarizeFailed: 'Context summarization failed',
            
            getGenerateImageConfigFailed: 'Failed to get image generation config',
            updateGenerateImageConfigFailed: 'Failed to update image generation config',
            
            getContextAwarenessConfigFailed: 'Failed to get context awareness config',
            updateContextAwarenessConfigFailed: 'Failed to update context awareness config',
            getOpenTabsFailed: 'Failed to get open tabs',
            getActiveEditorFailed: 'Failed to get active editor',
            
            getSystemPromptConfigFailed: 'Failed to get system prompt config',
            updateSystemPromptConfigFailed: 'Failed to update system prompt config',
            
            getPinnedFilesConfigFailed: 'Failed to get pinned files config',
            checkPinnedFilesExistenceFailed: 'Failed to check files existence',
            updatePinnedFilesConfigFailed: 'Failed to update pinned files config',
            addPinnedFileFailed: 'Failed to add pinned file',
            removePinnedFileFailed: 'Failed to remove pinned file',
            setPinnedFileEnabledFailed: 'Failed to set pinned file status',
            
            listDependenciesFailed: 'Failed to get dependencies list',
            installDependencyFailed: 'Failed to install dependency',
            uninstallDependencyFailed: 'Failed to uninstall dependency',
            getInstallPathFailed: 'Failed to get install path',
            
            showNotificationFailed: 'Failed to show notification',
            rejectToolCallsFailed: 'Failed to reject tool calls',
            
            getStorageConfigFailed: 'Failed to get storage config',
            updateStorageConfigFailed: 'Failed to update storage config',
            validateStoragePathFailed: 'Failed to validate storage path',
            migrateStorageFailed: 'Failed to migrate storage'
        },
        
        messages: {
            historyDiffPreview: '{filePath} (History diff preview)',
            newFileContentPreview: '{filePath} (New content preview)',
            fullFileDiffPreview: '{filePath} (Full file diff preview)',
            searchReplaceDiffPreview: '{filePath} (Search replace diff preview)'
        },
        dialogs: {
            selectStorageFolder: 'Select Storage Folder',
            selectFolder: 'Select Folder'
        },

        promptSettings: {
            dynamicSection: {
                strategyTitle: 'Dynamic context strategy',
                strategySingle: 'Single dynamic context',
                strategyPreserve: 'Preserve old dynamic context in place',
                strategyDescription: 'Single mode keeps existing behavior. Preserve mode inserts cached old dynamic contexts back at their original turns and inserts the new context before the new message.',
                strategyPreserveWarning: 'Preserve mode increases request tokens. More preserved contexts make context trimming or summarization more likely.',
                strategyVarsPrefix: 'When preset entries or legacy templates contain',
                strategyVarsSeparator: ', ',
                strategyVarsSuffix: 'or other changing variables, this setting determines whether old-turn snapshots are preserved.',
                strategyVarsWarning: 'Preserving old dynamic context in place fixes old-turn dynamic snapshots back into their original positions and inserts the current context in the current turn, suitable for long contexts and many history turns.'
            },
            assemblyMode: {
                title: 'Prompt assembly mode',
                description: 'Each mode can only use one assembly method: legacy template or preset entries.',
                legacyLabel: 'Legacy template',
                legacyDescription: 'Uses the system prompt template and the dynamic context template.',
                entriesLabel: 'Preset entries',
                entriesDescription: 'Uses sortable entries, with Chat History controlling the actual history position.'
            }
        }
    },

    errors: {
        unknown: 'Unknown error',
        timeout: 'Operation timeout',
        cancelled: 'Operation cancelled',
        networkError: 'Network error',
        invalidRequest: 'Invalid request',
        internalError: 'Internal error'
    }
};

export default en;