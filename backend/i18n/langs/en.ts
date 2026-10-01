/**
 * GrayCode Backend - English Language Pack
 */

import type { BackendLanguageMessages } from '../types';

const en: BackendLanguageMessages = {
    desktop: {
        responsesNative: {
            "websocket": {
                "title": "Native WebSocket and mid-turn updates",
                "hint": "Off by default. The desktop and Web platform reuse a Responses connection within each task and send user updates during generation. Requires Responses WebSocket and steering support from the model and gateway."
            },
            "asyncTools": {
                "title": "Native async tools",
                "hint": "Off by default. Read, command and browser tools can run while the model continues working, with up to 4 concurrent calls. The model can wait for selected tasks; results return on their original calls. Background commands keep task management and browser operations retain tab order. Permissions and approvals still apply. Requires async tool support."
            }
        },
        "discardQuit": "Discard changes and quit",
        "saveAllProgress": "Saving files and settings…",
        "saveAllDetail": "Save all files and settings before quitting, or discard unsaved changes. Quitting stops background tasks and connections.",
            "saveAllQuit": "Save all and quit",
            "saveAllUnavailable": "The editor is unavailable. The app will stay open.",
            "saveAllIncomplete": "Some changes remain unsaved. Resolve them and try again.",
            "shell": {
                "documentRecoveryConflict": "The file has changed and your draft has been kept. Copy your text, reopen the file, and merge the changes.",
                "connectionTimeout": "The connection timed out. Check the network and try again.",
                "initializationFailed": "Workspace initialization failed",
                "retryInitialization": "Retry connection",
                "chatInitializationFailed": "The chat interface is not ready. Check the connection and retry loading it.",
                "retryChat": "Reload chat interface",
                "reviewRecords": "{count} change records",
                "reviewPendingGroup": "Pending",
                "reviewProcessedGroup": "Processed",
                "reviewPendingStatus": "Awaiting review",
                "reviewAcceptedStatus": "Accepted",
                "reviewRejectedStatus": "Rejected",
                "reviewCancelledStatus": "Cancelled",
                "reviewHideList": "Hide change list",
                "reviewToggleList": "Toggle change list",
                "reviewTitle": "Review",
                "reviewLoading": "Loading changes…",
                "reviewRefresh": "Refresh changes",
                "reviewEmptyTitle": "No changes to review",
                "reviewEmptyDetail": "File changes proposed by AI appear here.",
                "reviewTargetMissing": "The requested change is not in this list",
                "reviewTargetMissingDetail": "Refresh the list or select another change.",
                "reviewReject": "Reject",
                "reviewAccept": "Accept",
                "reviewProcessing": "Processing…",
                "awaitingInput": "Awaiting answer",
                "awaitingApproval": "Awaiting confirmation",
                "chat": "Chat",
                "chatDetail": "Conversation and everyday tasks",
                "code": "Code",
                "codeDetail": "Edit projects and run development tasks",
                "character": "Character",
                "characterDetail": "Character profiles and story conversations",
                "workspace": "Workspace",
                "workbench": "Workbench",
                "backToChat": "Back to chat",
                "openPanel": "Open side panel",
                "closePanel": "Hide side panel",
                "library": "Library",
                "characterSetup": "Character settings",
                "addWorkspace": "Add workspace",
                "chooseFolder": "Choose a folder",
                "connecting": "Connecting to the local core…",
                "close": "Close",
                "copyError": "Copy redacted diagnostics",
                "copied": "Copied",
                "copyFailed": "Copy failed",
                "previewImageTools": "Image tools",
                "previewImageMenu": "Image actions",
                "previewZoomOut": "Zoom out",
                "previewZoomIn": "Zoom in",
                "previewZoomPercent": "Current zoom",
                "previewFit": "Fit",
                "previewFitToWindow": "Fit to window",
                "previewActualSize": "Actual size (100%)",
                "previewRotateLeft": "Rotate left",
                "previewRotateRight": "Rotate right",
                "previewSaveImage": "Save original image",
                "previewSaveAttachment": "Save attachment",
                "previewCopyImage": "Copy image",
                "previewCopyingImage": "Copying…",
                "previewCopyUnavailable": "This browser cannot copy images. Open over HTTPS and allow clipboard access, or save the original image.",
                "previewCopyFailed": "Could not copy the image. Check clipboard permissions and try again, or save the original image.",
                "previewImageLoadFailed": "The image could not be displayed. Save the original and open it with a local app.",
                "previewDoubleClick": "Double-click to switch between actual size (100%) and fit to window",
                "previewPrevious": "Previous image",
                "previewNext": "Next image",
                "previewPdf": "PDF preview",
                "previewUnsupported": "Save this file and open it with a local app.",
                "startupFailed": "GrayCode could not start",
                "startupDetail": "Your original data directory is preserved. Retry, or start with another data directory and use recovery in Settings.",
                "retry": "Retry",
                "openLogs": "Open logs folder",
                "chooseData": "Start with another data folder"
            },
        installerArtwork: {
            tagline: "LOCAL-FIRST AI WORKSPACE",
            intro: "Chat. Create. Make it yours.",
            progress: "Installing your workspace"
        },
        "trayOpen": "Open GrayCode",
        "trayWaiting": "GrayCode · Will exit when background tasks finish",
        "trayResident": "GrayCode · Background residency selected",
        settingsDraft: {
            cleanHint: "All categories share one settings draft.",
            dirtyHint: "You have unsaved changes. Switching categories keeps your draft.",
            discardAll: "Discard all",
            saveAll: "Save all",
            processing: "Processing…",
            unsavedTitle: "Unsaved settings",
            unsavedDescription: "Save changes from all categories, or discard this draft and return to chat.",
            continueEditing: "Keep editing",
            discardAndReturn: "Discard and return",
            saving: "Saving…",
            saveAndReturn: "Save and return",
        },
        settingsGroups: {
            models: "Models and prompts",
            execution: "Execution and permissions",
            context: "Conversations and memory",
            connections: "Integrations and connections",
            application: "Application",
        },
        buildDetails: "Build and application details",
        cancelFailed: "Could not cancel. Please retry.",
        "quitTitle": "Quit GrayCode",
        "quitMessage": "Finish this session?",
        "quitDetail": "Quitting stops background tasks and connections and discards unsaved changes. Saved conversations and settings are kept.",
        "continueWorking": "Keep working",
        "background": "Run in background",
        "quit": "Quit application",
        "unsavedFiles": "{count} unsaved file(s)",
        "unsavedSettings": "Settings have unsaved changes",
        "unsavedRemoteFiles": "Remote clients have {count} unsaved file drafts",
        "unsavedRemoteSettings": "Remote clients have an unsaved settings draft",
        "remoteDraftQuitDetail": "Save drafts from the original remote page before quitting. Disconnected drafts remain available on reconnection. Discard and quit will also discard these unsaved drafts.",
        "activeTasks": "Background tasks or connections are active",
        "backgroundDetail": "Background mode keeps GrayCode in the tray with this window and unsaved changes. Reopen it from the tray.",
        "closingTitle": "Quitting GrayCode",
        "closingMessage": "Closing safely",
        "closingDetail": "The application will exit when cleanup finishes.",
        "closingBackups": "Finishing backup operations",
        "closingWindows": "Closing companions and browser windows",
        "closingCore": "Stopping tasks and connections and saving data",
        "closingUpdate": "Starting the updater",
        "installerTitle": "Install and restore",
        "restart": "Confirm and restart",
        "retry": "Retry",
        "terminalUnavailable": "Terminal output could not be restored. Input is paused.",
        "loadingPanel": "Opening panel…",
        "loadPanelFailed": "The panel could not be loaded.",
        "close": "Close",
        "updateTitle": "Installation & updates",
        "currentVersion": "Current version",
        "installedKind": "Installed",
        "portableKind": "Portable",
        "portableHint": "Install the Windows setup package to apply updates and restore a previous version here. Your existing data directory can be reused.",
        "checkUpdate": "Check for updates",
        "downloadUpdate": "Download update",
        "offlineUpdate": "Choose offline update",
        "releasePage": "Open releases",
        "checking": "Checking for updates",
        "downloading": "Downloading and verifying",
        "backup": "Backing up current data",
        "preparing": "Preparing update",
        "readyTitle": "Update ready",
        "readyDescription": "Version {version} is downloaded and verified. The current application package and a data backup will be kept before installation.",
        "restartInstall": "Restart and install",
        "installLater": "Install later",
        "restorePoint": "Recovery point",
        "recoveryHint": "Restoring a version also restores its pre-update data and saves a separate backup of current data. Reconnect background services manually afterwards.",
        "recoveryRescue": "If an interrupted installation prevents startup, run Restore-GrayCode.cmd in the recovery folder to repair the application files.",
        "rollback": "Restore previous version and data",
        "openRecovery": "Open recovery folder",
        "transitionFailed": "The previous version change did not finish. Version {version} is still running. Retry installation or open the recovery folder.",
        "alreadyCurrent": "No newer version is available.",
        "downloaded": "Version {version} is ready. Save your changes before restarting to install.",
        "restarting": "Stopping background services, then installing and reopening the application.",
        "available": "Version {version} is available.",
        "loadingUpdate": "Reading installation status…",
        "unknownDate": "Unknown date",
        "updateReadyDescription": "The update is downloaded and verified. Save your changes before restarting. Current data will be backed up before installation.",
        "applying": "Preparing to restart and install…",
        "retryUpdate": "Retry update"
    },
    modules: {
        diff: {
            previewNotFound: "The change preview is unavailable. Refresh the current task.",
            previewAmbiguous: "The change preview reference is ambiguous. Refresh the current task.",
        },
        chatgpt: {
            storageUnavailable: "Encrypted credential storage is unavailable. Use the desktop app or configure a server encryption key with --key-env.",
            invalidResponse: "The ChatGPT authorization response is invalid.",
            missingScopes: "The ChatGPT response is missing granted scopes.",
            invalidTokens: "The ChatGPT response is missing a valid token or expiry.",
            unsupportedTokenType: "ChatGPT returned an unsupported token type.",
            invalidIdentityToken: "The ChatGPT identity token is invalid.",
            identityMismatch: "ChatGPT identity or this sign-in attempt could not be verified.",
            accountMismatch: "The returned ChatGPT identity does not match the selected account.",
            missingIdentityToken: "The ChatGPT authorization response is missing an identity token.",
            missingIdentity: "The ChatGPT authorization response is missing identity information.",
            missingRefreshToken: "The ChatGPT response is missing a refresh token.",
            invalidCredentials: "The saved ChatGPT authorization is invalid. Please sign in again.",
            callbackNotFound: "This sign-in callback was not found.",
            callbackSuccess: "ChatGPT authorization is complete. Return to GrayCode.",
            callbackFailed: "Sign-in could not be completed. Return to GrayCode to check the status or sign in again.",
            loginTimeout: "ChatGPT sign-in timed out. Please retry.",
            callbackMismatch: "The callback does not match this authorization attempt.",
            loginEnded: "This sign-in callback has already been used or ended.",
            consentDeclined: "ChatGPT authorization is incomplete. Sign in again and allow plan usage.",
            invalidCallback: "The ChatGPT callback is missing a valid code or client registration.",
            accountMissing: "The selected ChatGPT account does not exist.",
            loginMissing: "There is no pending ChatGPT sign-in.",
            signInRequired: "Sign in to ChatGPT in channel settings and allow GrayCode to use your plan.",
            accountChanged: "The ChatGPT account was switched or signed out. Please send the request again.",
            refreshPermissionMissing: "The refreshed ChatGPT grant does not include plan permission. Sign in again.",
            refreshNotReady: "This ChatGPT session is not ready to refresh. Try again shortly.",
            signInExpired: "ChatGPT sign-in expired. Sign in again in channel settings.",
            unsupportedHost: "This host does not provide ChatGPT plan sign-in.",
            channelRequired: "Select an OpenAI Responses channel.",
            unknownOperation: "Unknown ChatGPT authorization operation.",
            modelsSignInRequired: "Sign in to ChatGPT and grant plan permission first.",
            invalidModels: "The ChatGPT model catalog is invalid.",
            authLabel: "Authentication",
            apiKey: "API key",
            subscription: "ChatGPT plan",
            hint: "Sign in to use your ChatGPT plan. This channel connects directly to OpenAI and always streams; sampling and output token limits are handled by the plan endpoint.",
            account: "ChatGPT account",
            usingPlan: "Using ChatGPT plan",
            notConnected: "Sign in and allow GrayCode to use your ChatGPT plan to fetch models and send requests.",
            needsPermission: "This account has not enabled plan usage or is signed out. Sign in again and grant plan permission.",
            connect: "Continue with ChatGPT",
            reconnect: "Sign in again",
            addAccount: "Add account or workspace",
            disconnect: "Sign out of this account",
            usage: "Manage plan usage",
            waiting: "Complete sign-in and consent in your browser.",
            exchanging: "Verifying identity and saving authorization…",
            openBrowser: "Open authorization page",
            pasteLabel: "If the callback did not complete, paste its full URL",
            pastePlaceholder: "http://127.0.0.1:…/auth/callback?…",
            complete: "Complete sign-in",
            cancel: "Cancel sign-in",
            revocationUnconfirmed: "Signed out locally; remote revocation was not confirmed. You can disconnect GrayCode in ChatGPT settings.",
            failed: "ChatGPT sign-in failed. Please retry.",
            firstUseTitle: "You are using your ChatGPT plan",
            firstUseMessage: "Eligible requests in GrayCode use your ChatGPT plan or credits. Review usage and manage this app’s access and limits in ChatGPT settings.",
            understood: "Got it",
            close: "Close",
        },
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
            contextMethod: {
                defaultTitle: 'Default context management method',
                description: 'Automatic and manual actions use the current channel’s context method. Channels without an explicit method use this default. Original messages and attachments remain available for restoration, search and viewing.',
                defaultHint: 'Channel settings take precedence over this default. Bots retain their own method and timed summaries.',
                channelTitle: 'Context management method',
                channelHint: 'Used for automatic processing and manual summaries on this channel. The threshold only controls automatic triggers. Saved changes apply to new turns and the next manual action.',
            },
            contextRetention: {
                title: 'User messages retained in ordinary conversations',
                first: 'First user message + latest input',
                all: 'All user messages',
                hint: 'Applies to automatic/manual summaries and notes windows in ordinary conversations. The latest real user input before switching is always retained. Bots are unaffected. Changes take effect in later turns or manual actions.',
                summaryHint: 'Reuse the current model, system prompt and tools, then append a summary request. Keep the selected original user messages and the new summary before continuing.',
                notesHint: 'Switch directly without an extra summary request. Keep the selected original user messages and recovery instructions; the model can retrieve notes and history as needed.',
            },
            clawdSettings: {
                title: 'Clawd desktop pet integration',
                description: 'Let a running Clawd show GrayCode thinking, using tools, waiting for input, completing tasks and encountering errors.',
                enabled: 'Enable task status integration',
                agentId: 'Clawd Agent ID',
                setup: 'In Clawd Settings → Agents, add the GrayCode executable or installation folder, scan and register it, then paste the generated Agent ID here.',
                hint: 'Takes effect after Save all. Connects to Clawd on the GrayCode server computer, with automatic port discovery. Approvals stay in GrayCode.',
                check: 'Check connection',
                checking: 'Checking…',
                saveFirst: 'Save all settings before checking the connection.',
                status_disabled: 'Not enabled',
                status_waiting: 'Enabled, waiting for task activity',
                status_connected: 'Clawd accepted the state; Do Not Disturb may hide animations',
                status_offline: 'Clawd is offline or unreachable; tasks continue normally',
                status_unregistered: 'Register and enable this Agent ID in Clawd',
                status_error: 'Clawd did not accept the state; check its version and registration',
                invalidAgentId: 'Enter the complete Agent ID generated when registering GrayCode in Clawd settings.',
            },
            backgroundGalleryPolicy: 'JPG, PNG or WebP, up to 10 MB each. Imported images are saved or discarded with settings; uploads and changes to saved gallery images take effect immediately.',
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
                sharp: 'High-performance image processing library for mask application in background removal',
                pdfjsDist: 'PDF page rendering library for DeepSeek Vision page-by-page image input',
                napiCanvas: 'Native Node.js canvas implementation for rasterizing PDF pages into images'
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
        contextStatus: {
            title: 'Input token usage', remaining: 'Remaining', reservedOutput: 'Reserved output', capacity: 'Context capacity',
            threshold: 'Summary threshold', method: 'Management', retention: 'User messages retained',
            summary: 'Summary', notes: 'Working notes', retainFirst: 'First and latest', retainAll: 'All', retainBot: 'Bot settings',
            summaryOption: 'Summary · Compress history', notesOption: 'Working notes · Restore history as needed',
            notesHint: 'At the threshold, save working notes, switch context, then read the notes and relevant history to continue.',
            switched: 'Context switched', disabled: 'Automatic management off', pending: 'Context switch pending',
            normal: 'Within budget', overThreshold: 'Summary threshold reached', overBudget: 'Input limit exceeded', unknown: 'Not provided',
            localEstimate: 'Local estimate', usageSource: 'Current usage', details: 'Usage details', empty: 'Usage data unavailable',
            fixedPrompt: 'Fixed prompt', history: 'History', messages: 'Messages', measuredAt: 'Checked at',
            thresholdTokens: 'Threshold tokens', contextId: 'Context ID', initial: 'Initial context',
        },
        runtimeControl: {
            contextStatusName: 'Context Status',
            contextStatusDescription: 'Check current token usage and summary policy',
            terminalTaskName: 'Background Terminal Task',
            terminalTaskDescription: 'Inspect execute_command tasks, read incremental output or stop their managed process trees.',
        },
        automation: {
            "actions": {
                "list": "List",
                "create": "Create",
                "show": "Show",
                "close": "Close",
                "snapshot": "Read page",
                "screenshot": "Screenshot",
                "logs": "Read logs",
                "navigate": "Navigate",
                "back": "Back",
                "forward": "Forward",
                "reload": "Reload",
                "click": "Click",
                "hover": "Hover",
                "check": "Set checked state",
                "wait": "Wait for page condition",
                "type": "Type",
                "fill": "Fill",
                "press": "Press key",
                "scroll": "Scroll",
                "drag": "Drag",
                "upload": "Upload",
                "download": "Download",
                "acquire": "Acquire control",
                "status": "Check status",
                "release": "Release control",
                "focusWindow": "Focus window",
                "focusElement": "Focus element",
                "invoke": "Invoke element",
                "setValue": "Set value",
                "select": "Select",
                "toggle": "Toggle",
                "expand": "Expand",
                "collapse": "Collapse",
                "key": "Press key",
                "query": "Query pet",
                "play": "Play action",
                "expression": "Set expression",
                "look": "Look direction",
                "parameters": "Set parameters",
                "cancel": "Cancel action",
                "resume": "Resume",
                "stat": "Attachment info",
                "read": "Read attachment"
            },
            "currentPage": "Current page",
            "openedTabs": "Tabs opened by this action",
            "openedTabsHint": "The screenshot and snapshot below still belong to the original tab. Use the new tab ID to read its page.",
            "closedTab": "Closed",
            "requestedUrl": "Requested URL",
            "profiles": "Login profiles",
            "activeTab": "Active tab",
            "untitled": "Untitled",
            "noTabs": "No open tabs",
            "loading": "Loading",
            "userControlled": "User has control",
            "controlledBy": "Controlling run",
            "windowVisible": "Workbench window visible",
            "logs": "Page logs",
            "noLogs": "No new logs",
            "nextCursor": "Next cursor",
            "snapshotCount": "Returned {count} of {total} matching items",
            "conditionMet": "The page condition is satisfied",
            "conditionTimedOut": "The wait ended before the page condition was satisfied",
            "truncated": "Result truncated; only the returned portion is shown",
            "uploaded": "Placed in the file input",
            "downloaded": "Download saved",
            "observation": "Observation",
            "capturedAt": "Captured at",
            "dimensions": "Image size",
            "imageCoordinates": "Coordinates use the returned image’s actual pixels",
            "observationUnavailable": "Follow-up observation failed (action result is unchanged)",
            "operationStatus": "Action result",
            "operationUnknown": "Result unconfirmed",
            "dispatching": "Dispatched, awaiting confirmation",
            "repeated": "Existing action receipt returned; not executed again",
            "displays": "Displays",
            "primaryDisplay": "Primary display",
            "foreground": "Foreground window",
            "minimized": "Minimized",
            "noWindows": "No available windows",
            "control": "Computer control",
            "controlActive": "Controlled",
            "controlInactive": "Not controlled",
            "reason": "Status reason",
            "controller": "Controller",
            "stopShortcut": "Stop shortcut",
            "available": "Available",
            "unavailable": "Unavailable",
            "focusedElement": "Current focus",
            "accessibilityUnavailable": "Element inspection failed",
            "noElements": "No elements returned in this observation",
            "petModel": "Current pet",
            "noPet": "No pet selected",
            "renderer": "Player",
            "phases": {
                "unloaded": "Not loaded",
                "loading": "Loading",
                "ready": "Ready",
                "failed": "Load failed"
            },
            "visible": "Visible",
            "stopped": "Stopped by user",
            "accepted": "Request accepted",
            "notAccepted": "Request not accepted",
            "applied": "Player confirmed application",
            "notApplied": "Application not confirmed by player",
            "currentCommand": "Current action",
            "confirmedCommand": "Last confirmed action",
            "petActions": "Available actions",
            "expressions": "Available expressions",
            "parameterRanges": "Actual parameter ranges",
            "range": "Range",
            "defaultValue": "Default",
            "duration": "Duration",
            "lookAngle": "Look angle",
            "front": "Face forward",
            "requestId": "Request ID",
            "attachments": "Conversation attachments",
            "noAttachments": "No readable attachments in this conversation",
            "size": "File size",
            "encoding": "Encoding",
            "characterRange": "Characters {start}–{end}",
            "nextOffset": "Next offset",
            "endOfDocument": "End of document",
            "emptyText": "No text in this range"
        },
        platform: {
            "noData": "No result details returned.",
            "partial": "Partial result",
            "nextOffset": "Continue at offset {offset}",
            "nextCursor": "Another page is available; see details for the cursor.",
            "version": "Version {version}",
            "file": {
                "actions": {
                    "list": "List files",
                    "read": "Read file",
                    "write": "Write file",
                    "edit": "Edit file",
                    "delete": "Delete file"
                },
                "range": "Lines {start}–{end} of {total}",
                "nextLine": "Read the next section from line {line}",
                "matches": "{count} matches",
                "scanned": "{count} files scanned",
                "scanIncomplete": "Search is incomplete; the current results cover only the files scanned so far.",
                "scanIncompleteEmpty": "Search is incomplete; 0 results so far do not mean there are no matches in the whole scope.",
                "scanLimit": "File scan limit reached; narrow the directory. Offset cannot reach unscanned files.",
                "matchLimit": "More matches are available; continue with the same query, directory and case option.",
                "saved": "File written",
                "deleted": "File deleted",
                "requested": "Requested file content",
                "before": "Before replacement",
                "after": "After replacement",
                "empty": "No file entries",
                "noMatches": "No matching lines"
            },
            "process": {
                "actions": {
                    "read": "Read process output",
                    "input": "Send process input",
                    "stop": "Stop process"
                },
                "running": "Process is still running",
                "exited": "Process exited",
                "unknown": "Process state not returned",
                "output": "Process output",
                "noOutput": "No process output yet",
                "truncated": "Only the output tail is retained; earlier output was truncated.",
                "input": "Sent input",
                "taskActions": { "list": "Background commands", "status": "Background command status", "read": "Read background output", "stop": "Stop background command" },
                "taskCount": "{count} command tasks",
                "noTasks": "This conversation has no background command tasks",
                "interrupted": "Interrupted",
                "moreOutput": "More output is available to read."
            },
            "team": {
                "actions": {
                    "list": "Shared tasks",
                    "get": "Task details",
                    "create": "Create task",
                    "claim_ready": "Claim ready task",
                    "claim": "Claim task",
                    "complete": "Complete task",
                    "release": "Release task",
                    "set_dependencies": "Update dependencies"
                },
                "task": "Task",
                "dependencies": "{count} dependencies",
                "blockedBy": "{count} unfinished dependencies",
                "ready": "{count} tasks ready to claim",
                "unclaimed": "Unclaimed",
                "assigned": "Claimed",
                "empty": "No tasks returned",
                "noReady": "No task is ready to claim",
                "emptyEvents": "No new team events",
                "nextTasks": "More tasks; continue after creation sequence {sequence}",
                "moreEvents": "More events; continue after sequence {sequence}",
                "reasons": {
                    "events": "Team events received",
                    "ready_work": "Work is ready to claim",
                    "no_progress": "No progress is currently possible",
                    "timeout": "Wait timed out with no new events"
                },
                "noProgress": "No ready task or other active member can advance the team. Resolve the blocker, report it or finish waiting.",
                "events": {
                    "task_created": "Task created",
                    "task_claimed": "Task claimed",
                    "task_completed": "Task completed",
                    "task_released": "Task released",
                    "task_dependencies_changed": "Task dependencies updated",
                    "message_queued": "Message queued",
                    "member_changed": "Member state changed"
                }
            },
            "memory": {
                "topics": "Memory topics",
                "scopes": "Authorized scopes",
                "records": "{count} memories",
                "sources": "Source excerpts",
                "source": "Source",
                "root": "Topic root",
                "empty": "No memories returned",
                "kinds": {
                    "fact": "Fact",
                    "preference": "Preference",
                    "experience": "Experience",
                    "project": "Project",
                    "procedure": "Procedure",
                    "event": "Event",
                    "summary": "Summary"
                },
                "confidence": {
                    "confirmed": "Confirmed",
                    "inferred": "Inferred",
                    "disputed": "Disputed"
                },
                "origins": {
                    "user": "User message",
                    "model": "Model message",
                    "tool": "Tool result",
                    "fiction": "Fiction",
                    "import": "Imported material"
                },
                "scopeKinds": {
                    "personal": "Personal",
                    "workspace": "Workspace",
                    "group": "Group",
                    "library": "Library"
                },
                "preview": "Removal impact preview · Nothing deleted",
                "apply": "Removal receipt",
                "retract": "Retraction receipt",
                "affected": "{total} affected items, including {records} memories",
                "removed": "{count} items removed",
                "requested": "Submitted memory content",
                "append": "Requested appended content",
                "saved": "{count} saved records returned",
                "omitted": "{count} items omitted due to budget or count limits",
                "unavailable": "{count} items unavailable",
                "requiredBudget": "Required token budget: {count}",
                "truncated": "Only some memories were returned; narrow the scope or adjust the budget.",
                "pageRange": "Characters {start}–{end} / {total}",
                "sourcePage": "Source text section",
                "recordPage": "Memory text section",
                "conflicts": "{count} conflicting records",
                "dependencies": "{count} source or memory dependencies",
                "previewIds": "Affected memory and source IDs"
            }
        },
        contextNotes: {
            recorded: 'Recorded {count} notes', submitted: 'Submitted {count} notes',
            recalled: 'Returned {count} note bodies', budget: 'Local estimate: {used} / {budget} tokens',
            alreadyProvided: '{count} notes already provided in the current context',
            providedExplanation: 'The model can still see these note bodies. This call returns history references; use inspect with the note ID to read them again.',
            historyReference: 'History reference:', missingDependencies: '{count} required dependencies were not fully returned',
            unavailable: '{count} notes currently unavailable', omitted: '{count} notes omitted due to budget or item limits',
            truncated: 'This recall did not return all supporting information. Narrow the scope or increase the token budget to continue.',
            empty: 'No currently valid notes found.', replacements: 'Note replacements', about: 'Related topics:',
            sourceRange: 'Source offset={offset}, length={length}', nextOffset: 'Continue with offset={offset}.',
            kinds: { constraint: 'Constraint', decision: 'Decision', observation: 'Observation', hypothesis: 'Hypothesis', task: 'Task', lesson: 'Lesson' },
            states: { current: 'Current', superseded: 'Superseded', outside_time: 'Outside the query time range', source_unavailable: 'Source unavailable' },
            relations: { requires: 'Requires', supports: 'Supports', contradicts: 'Contradicts', applies_to: 'Applies to', supersedes: 'Supersedes' },
            providedReasons: { recorded: 'Provided in the record call', recalled: 'Provided in a recall result', verbatim: 'Present verbatim in the current context' },
            historyActions: { windows: 'List context windows', list: 'List recent messages', search: 'Search history', read: 'Read message' },
        },
        presentation: {
            gotoDefinition: {
                pageSummary: '{returned} definitions on this page, {total} total',
                nextPage: 'Continue with offset={offset} and unchanged query parameters.',
                contentTruncated: 'This definition is truncated. Read the displayed path and line range for the remaining code.',
                emptyPage: 'No definitions on this page'
            },
            // Responses strict follows the channel switch, rather than being enabled implicitly.
            strictToolsOpenaiResponses: 'OpenAI Responses: Off by default; optional parameters allow null when enabled',
            messageBody: 'Message content', recipient: 'Recipient', mainAgent: 'Main agent',
            contentUnavailable: 'This history entry has no saved message body. Existing receipt details remain available.',
            messageSaved: 'Message saved, awaiting delivery at the recipient’s next run boundary.',
            noteContent: 'Note content', appendedContent: 'Appended content', noteDirectory: 'Notes',
            historyMessages: 'History', characters: '{count} characters',
            invalidatedNote: 'This note is no longer valid. Rebuild it from valid sources.',
            partialContent: 'Only part of the content is shown. Continue reading using the returned range.',
            partialSuccess: 'Partially completed', partialRange: 'Partial content', diffUnavailable: 'Unable to read diff content.',
            cancelFailed: 'Could not cancel the task. Please try again.',
            searchReplace: {
                accepted: 'Applied', rejected: 'Rejected', pending: 'Awaiting review',
                filesRejected: 'Rejected {count} files', proposed: '{count} proposed replacements', skipped: 'Skipped {count} files',
                keywordFallback: 'Search used the following keywords:',
            },
            moreHistory: 'Earlier records are available using the returned history position.',
            // Pagination requires another tool call; exclusion sources describe this receipt, not current settings.
            findFiles: {
                returnedFiles: '{count} files returned',
                pageFiles: '{count} files on this page',
                pageOffset: 'This page skips {offset} files',
                nextPage: 'Call again for the next page: offset={offset}, with this pattern and exclusions unchanged',
                expandPage: 'Show {count} more files on this page',
                restartAfterFailure: 'Search is incomplete. Resolve errors and restart at offset=0; this page cannot provide reliable continuation.',
                continuationDetails: 'Continuation guidance',
                workspaceErrors: 'Workspace search failures',
                exclusions: 'Effective exclusions',
                excludeSources: {
                    argument: 'Call argument (replaces settings)',
                    settings: 'Tool settings',
                    fallback: 'Default fallback',
                    includeIgnored: 'Explicitly include ignored files',
                    unknown: 'Source not recorded'
                }
            }
        },
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
            nextActions: {
                processMoreOutput: 'Read the remaining retained output.',
                processIntermediateOutput: 'Read only when intermediate output is needed; continue independent work between reads.',
                processInspect: 'Inspect the current session state and retained output; this does not restart the command.',
                nativePending: 'This native async call remains pending. Continue independent work; use wait_for_tasks with its task_handle only when the final result is needed. Intermediate output is available through terminal_task.',
                nativeWait: 'Wait only when subsequent work needs this native async command result.',
                terminalStatus: 'Inspect status only when needed; completion is delivered automatically.',
                terminalMoreOutput: 'Read the remaining output page.',
                terminalIntermediateOutput: 'Read only when intermediate output or a progress diagnosis is needed.',
                terminalExitedMoreOutput: 'The command has exited; read the remaining output page without waiting.',
                terminalExitedInspect: 'The command has exited; inspect retained output only if further diagnosis is needed.',
                terminalNextPage: 'Read the next page of tasks.',
                terminalResetCursor: 'Read retained output without the invalid cursor to establish a new nextCursor.'
            },
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
