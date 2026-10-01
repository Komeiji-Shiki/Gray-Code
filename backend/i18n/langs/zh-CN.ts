/**
 * GrayCode Backend - 中文语言包
 *
 * 注意：本文件是基准语言包，BackendLanguageMessages 类型由此文件自动推导，
 * 因此这里不做类型标注（避免循环定义）。修改结构后 en/ja 会自动受到类型约束。
 */


const zhCN = {
    desktop: {
        responsesNative: {
            "websocket": {
                "title": "原生 WebSocket 与生成中补充消息",
                "hint": "默认关闭。开启后，独立桌面与 Web 平台在任务内复用 Responses 连接，并将生成中发送的补充消息交给模型。需要模型与上游网关支持 Responses WebSocket 和 steering。"
            },
            "asyncTools": {
                "title": "原生异步工具",
                "hint": "默认关闭。读取、命令和浏览器工具可在模型继续工作时执行，最多同时执行 4 个。模型可按需等待任务，结果返回原始调用；后台命令保留任务管理，浏览器按标签页顺序执行。权限与确认规则继续生效，需要上游支持 async 工具。"
            }
        },
        "discardQuit": "放弃修改并退出",
        "saveAllProgress": "正在保存文件与设置…",
        "saveAllDetail": "可以先保存全部文件和设置再退出。选择“放弃修改并退出”会丢弃未保存的内容。退出时后台任务和连接将停止。",
            "saveAllQuit": "保存全部并退出",
            "saveAllUnavailable": "编辑界面不可用，应用保持打开。",
            "saveAllIncomplete": "仍有未保存的修改，请处理后重试。",
            "shell": {
                "documentRecoveryConflict": "文件已发生变化，当前草稿已保留。请先复制内容，再重新打开文件并合并修改。",
                "connectionTimeout": "连接超时，请检查网络后重试。",
                "initializationFailed": "工作台初始化失败",
                "retryInitialization": "重试连接",
                "chatInitializationFailed": "对话界面尚未就绪，请检查连接后重试加载。",
                "retryChat": "重新加载对话界面",
                "reviewRecords": "{count} 条修改记录",
                "reviewPendingGroup": "待处理",
                "reviewProcessedGroup": "已处理",
                "reviewPendingStatus": "等待处理",
                "reviewAcceptedStatus": "已接受",
                "reviewRejectedStatus": "已拒绝",
                "reviewCancelledStatus": "已取消",
                "reviewHideList": "收起修改列表",
                "reviewToggleList": "切换修改列表",
                "reviewTitle": "审查",
                "reviewLoading": "正在加载修改…",
                "reviewRefresh": "刷新修改",
                "reviewEmptyTitle": "当前没有需要审查的修改",
                "reviewEmptyDetail": "AI 提出的文件修改会显示在这里。",
                "reviewTargetMissing": "目标修改未出现在当前列表中",
                "reviewTargetMissingDetail": "刷新列表或选择其他修改记录。",
                "reviewReject": "拒绝",
                "reviewAccept": "接受",
                "reviewProcessing": "正在处理…",
                "awaitingInput": "等待回答",
                "awaitingApproval": "等待确认",
                "chat": "对话",
                "chatDetail": "自由交流与日常任务",
                "code": "代码",
                "codeDetail": "编辑项目与执行开发任务",
                "character": "角色",
                "characterDetail": "角色资料与故事对话",
                "workspace": "工作区",
                "workbench": "工作台",
                "backToChat": "返回对话",
                "openPanel": "打开侧边面板",
                "closePanel": "隐藏侧边面板",
                "library": "资料库",
                "characterSetup": "角色配置",
                "addWorkspace": "添加工作区",
                "chooseFolder": "选择电脑文件夹",
                "connecting": "正在连接本地核心…",
                "close": "关闭",
                "copyError": "复制脱敏诊断",
                "copied": "已复制",
                "copyFailed": "复制失败",
                "previewImageTools": "图片工具",
                "previewImageMenu": "图片操作",
                "previewZoomOut": "缩小",
                "previewZoomIn": "放大",
                "previewZoomPercent": "当前缩放比例",
                "previewFit": "适应",
                "previewFitToWindow": "适应窗口",
                "previewActualSize": "原始尺寸（100%）",
                "previewRotateLeft": "向左旋转",
                "previewRotateRight": "向右旋转",
                "previewSaveImage": "保存原图",
                "previewSaveAttachment": "保存附件",
                "previewCopyImage": "复制图片",
                "previewCopyingImage": "正在复制…",
                "previewCopyUnavailable": "当前浏览器无法复制图片，请通过 HTTPS 打开并允许剪贴板访问，或选择保存原图。",
                "previewCopyFailed": "复制图片失败，请检查剪贴板权限后重试，也可以保存原图。",
                "previewImageLoadFailed": "图片无法显示，可以保存原图后使用本机应用打开。",
                "previewDoubleClick": "双击在原始尺寸（100%）与适应窗口之间切换",
                "previewPrevious": "上一张",
                "previewNext": "下一张",
                "previewPdf": "PDF 预览",
                "previewUnsupported": "此格式可以保存后使用本机应用打开。",
                "startupFailed": "GrayCode 启动失败",
                "startupDetail": "原数据目录会保留。可以重试启动，或选择其他数据目录启动后使用设置中的恢复入口。",
                "retry": "重试",
                "openLogs": "打开日志目录",
                "chooseData": "从其他数据目录启动"
            },
        installerArtwork: {
            tagline: "本地优先 AI 工作台",
            intro: "对话、创作，构建你的工作空间。",
            progress: "正在安装工作台"
        },
        "trayOpen": "打开 GrayCode",
        "trayWaiting": "GrayCode · 后台任务结束后退出",
        "trayResident": "GrayCode · 已选择后台常驻",
        settingsDraft: {
            cleanHint: "所有分类共用一份设置草稿。",
            dirtyHint: "有未保存的更改，切换分类会保留草稿。",
            discardAll: "撤销全部",
            saveAll: "保存全部",
            processing: "正在处理…",
            unsavedTitle: "设置尚未保存",
            unsavedDescription: "可以保存所有分类的更改，或放弃这份草稿后返回对话。",
            continueEditing: "继续编辑",
            discardAndReturn: "放弃并返回",
            saving: "正在保存…",
            saveAndReturn: "保存并返回",
        },
        settingsGroups: {
            models: "模型与提示",
            execution: "执行与权限",
            context: "对话与记忆",
            connections: "集成与连接",
            application: "应用",
        },
        buildDetails: "构建与程序信息",
        cancelFailed: "取消失败，请重试。",
        "quitTitle": "退出 GrayCode",
        "quitMessage": "结束这次工作？",
        "quitDetail": "退出会停止后台任务和连接，并放弃尚未保存的修改。已保存的对话和配置会保留。",
        "continueWorking": "继续工作",
        "background": "后台运行",
        "quit": "退出应用",
        "unsavedFiles": "{count} 个文件尚未保存",
        "unsavedSettings": "设置中有尚未保存的修改",
        "unsavedRemoteFiles": "远端客户端有 {count} 个文件草稿尚未保存",
        "unsavedRemoteSettings": "远端客户端有尚未保存的设置草稿",
        "remoteDraftQuitDetail": "请在原远端页面保存草稿后再退出。断开连接会保留草稿供重连；选择“放弃修改并退出”会一并丢弃这些未保存内容。",
        "activeTasks": "后台任务或连接仍在运行",
        "backgroundDetail": "后台运行会常驻托盘，保留当前窗口与未保存的修改，可从托盘重新打开。",
        "closingTitle": "正在退出 GrayCode",
        "closingMessage": "正在安全关闭",
        "closingDetail": "完成当前清理后，应用会自动退出。",
        "closingBackups": "正在结束备份任务",
        "closingWindows": "正在关闭桌宠与内置浏览器",
        "closingCore": "正在停止任务、连接并保存数据",
        "closingUpdate": "正在启动更新器",
        "installerTitle": "安装与恢复",
        "restart": "确认并重启",
        "retry": "重试",
        "terminalUnavailable": "终端输出未能接续，输入已暂停。",
        "loadingPanel": "正在打开面板…",
        "loadPanelFailed": "面板加载失败。",
        "close": "关闭",
        "updateTitle": "安装与更新",
        "currentVersion": "当前版本",
        "installedKind": "安装版",
        "portableKind": "便携版",
        "portableHint": "安装 Windows 安装版后，可在这里安装更新和恢复上一版本。现有数据目录可以继续使用。",
        "checkUpdate": "检查更新",
        "downloadUpdate": "下载更新",
        "offlineUpdate": "选择离线更新",
        "releasePage": "打开发行页面",
        "checking": "正在检查更新",
        "downloading": "正在下载并校验",
        "backup": "正在备份当前数据",
        "preparing": "正在准备更新",
        "readyTitle": "更新已就绪",
        "readyDescription": "版本 {version} 已下载并校验。安装前会保留当前程序包和数据备份。",
        "restartInstall": "重启并安装",
        "installLater": "稍后安装",
        "restorePoint": "恢复点",
        "recoveryHint": "恢复上一版本时会同时恢复更新前数据，并另存当前数据。恢复后的后台连接需要手动开启。",
        "recoveryRescue": "若安装中断导致无法启动，可在恢复文件夹运行 Restore-GrayCode.cmd 修复程序文件。",
        "rollback": "恢复上一版本与数据",
        "openRecovery": "打开恢复文件夹",
        "transitionFailed": "上次版本切换未完成，当前仍运行 {version}。可重新安装，或打开恢复文件夹。",
        "alreadyCurrent": "当前没有更高版本。",
        "downloaded": "版本 {version} 已准备，请保存编辑后重启安装。",
        "restarting": "正在退出后台服务，随后安装并重新打开。",
        "available": "发现版本 {version}。",
        "loadingUpdate": "正在读取安装状态…",
        "unknownDate": "时间未知",
        "updateReadyDescription": "更新包已下载并校验。保存编辑后，可重启安装；安装前会备份当前数据。",
        "applying": "正在准备重启安装…",
        "retryUpdate": "重试更新"
    },
    modules: {
        diff: {
            previewNotFound: "修改预览不存在，请刷新当前任务。",
            previewAmbiguous: "修改预览标识有歧义，请刷新当前任务。",
        },
        chatgpt: {
            storageUnavailable: "当前运行方式未提供加密凭据存储，请使用桌面版或通过 --key-env 配置服务器加密密钥。",
            invalidResponse: "ChatGPT 授权响应格式无效。",
            missingScopes: "ChatGPT 授权响应缺少权限范围。",
            invalidTokens: "ChatGPT 授权响应缺少有效令牌或到期时间。",
            unsupportedTokenType: "ChatGPT 返回了不支持的令牌类型。",
            invalidIdentityToken: "ChatGPT 身份令牌无效。",
            identityMismatch: "ChatGPT 身份或本次登录校验无效。",
            accountMismatch: "登录返回的 ChatGPT 账户与所选账户不一致。",
            missingIdentityToken: "ChatGPT 授权响应缺少身份令牌。",
            missingIdentity: "ChatGPT 授权响应缺少身份信息。",
            missingRefreshToken: "ChatGPT 授权响应缺少续期令牌。",
            invalidCredentials: "已保存的 ChatGPT 授权记录无效，请重新登录。",
            callbackNotFound: "找不到这个登录回调。",
            callbackSuccess: "ChatGPT 授权已完成，请返回 GrayCode。",
            callbackFailed: "这次登录未能完成，请返回 GrayCode 查看状态或重新登录。",
            loginTimeout: "ChatGPT 登录已超时，请重试。",
            callbackMismatch: "登录回调与本次授权不匹配。",
            loginEnded: "这次登录回调已处理或已结束。",
            consentDeclined: "ChatGPT 授权未完成，请重新登录并允许使用订阅。",
            invalidCallback: "ChatGPT 回调缺少有效授权码或应用注册信息。",
            accountMissing: "所选 ChatGPT 账户不存在。",
            loginMissing: "没有待完成的 ChatGPT 登录。",
            signInRequired: "请在渠道设置中登录 ChatGPT，并允许 GrayCode 使用订阅额度。",
            accountChanged: "ChatGPT 账户已切换或已退出，请重新发送请求。",
            refreshPermissionMissing: "ChatGPT 续期后的授权未包含订阅权限，请重新登录。",
            refreshNotReady: "ChatGPT 会话尚未到达允许续期的时间，请稍后重试。",
            signInExpired: "ChatGPT 登录已失效，请在渠道设置中重新登录。",
            unsupportedHost: "当前宿主未提供 ChatGPT 订阅登录。",
            channelRequired: "请选择 OpenAI Responses 渠道。",
            unknownOperation: "未知 ChatGPT 授权操作。",
            modelsSignInRequired: "请先登录 ChatGPT 并授权使用订阅。",
            invalidModels: "ChatGPT 模型列表格式无效。",
            authLabel: "认证方式",
            apiKey: "API Key",
            subscription: "ChatGPT 订阅",
            hint: "登录 ChatGPT 后使用订阅额度。此渠道直接连接 OpenAI，始终使用流式输出；温度、Top P 和输出 Token 上限由订阅接口处理。",
            account: "ChatGPT 账户",
            usingPlan: "正在使用 ChatGPT 订阅",
            notConnected: "登录并允许 GrayCode 使用你的 ChatGPT 订阅后，即可获取模型并发送请求。",
            needsPermission: "此账户尚未授权使用订阅，或已退出。请重新登录并启用订阅权限。",
            connect: "Continue with ChatGPT",
            reconnect: "重新登录",
            addAccount: "添加账户或工作区",
            disconnect: "退出此账户",
            usage: "管理订阅用量",
            waiting: "请在浏览器中完成登录和授权。",
            exchanging: "正在验证身份并保存授权…",
            openBrowser: "打开授权页面",
            pasteLabel: "浏览器回调未完成时，粘贴完整回调地址",
            pastePlaceholder: "http://127.0.0.1:…/auth/callback?…",
            complete: "完成登录",
            cancel: "取消登录",
            revocationUnconfirmed: "本机已退出，远程撤销暂未确认。可在 ChatGPT 设置中断开 GrayCode。",
            failed: "ChatGPT 登录失败，请重试。",
            firstUseTitle: "正在使用你的 ChatGPT 订阅",
            firstUseMessage: "GrayCode 中符合条件的请求会使用你的 ChatGPT 订阅或积分额度。你可以在 ChatGPT 设置中查看用量，并管理此应用的权限与额度。",
            understood: "知道了",
            close: "关闭",
        },
        config: {
            errors: {
                configNotFound: '配置不存在: {configId}',
                configExists: '配置已存在: {configId}，使用 overwrite 选项覆盖',
                invalidConfig: '无效的配置',
                validationFailed: '配置验证失败: {errors}',
                saveFailed: '保存配置失败',
                loadFailed: '加载配置失败'
            },
            validation: {
                nameRequired: '名称不能为空',
                typeRequired: '类型不能为空',
                invalidUrl: 'API URL 无效',
                apiKeyEmpty: 'API Key 为空，需要配置后才能使用',
                modelNotSelected: '有可用模型但未选择当前使用的模型',
                temperatureRange: 'temperature 必须在 0.0 - 2.0 之间',
                maxOutputTokensMin: 'maxOutputTokens 必须大于 0',
                maxOutputTokensHigh: 'maxOutputTokens 过大，可能导致高延迟',
                temperatureRangeAnthropic: 'temperature 必须在 0.0 - 1.0 之间（Anthropic）',
                maxTokensMin: 'max_tokens 必须大于 0',
                topPRange: 'top_p 必须在 0.0 - 1.0 之间',
                topKMin: 'top_k 必须大于等于 0',
                thinkingBudgetMin: 'thinking.budget_tokens 不能小于 1024',
                unsupportedType: '不支持的渠道类型: {type}',
                retryCountInvalid: 'retryCount 必须是非负整数',
                retryIntervalInvalid: 'retryInterval 必须是正数',
                timeoutInvalid: 'timeout 必须是正数'
            }
        },

        conversation: {
            defaultTitle: '对话 {conversationId}',
            errors: {
                conversationNotFound: '对话未找到: {conversationId}',
                conversationExists: '对话已存在: {conversationId}',
                messageNotFound: '消息未找到: {messageId}',
                messageIndexOutOfBounds: '消息索引越界: {index}',
                snapshotNotFound: '快照不存在: {snapshotId}',
                snapshotNotBelongToConversation: '快照不属于此对话',
                saveFailed: '保存对话失败',
                loadFailed: '加载对话失败'
            }
        },

        mcp: {
            errors: {
                connectionFailed: '连接失败: {serverName}',
                serverNotFound: '服务器不存在: {serverId}',
                serverNotFoundWithAvailable: '服务器不存在: {serverId}。可用的服务器: {available}',
                serverDisabled: '服务器未启用: {serverId}',
                serverNotConnected: '服务器未连接: {serverName}',
                clientNotConnected: '客户端未连接',
                toolCallFailed: '工具调用失败',
                requestTimeout: '请求超时 ({timeout}ms)',
                invalidServerId: 'ID 只能包含字母、数字、下划线和中划线',
                serverIdExists: '服务器 ID "{serverId}" 已存在'
            },
            status: {
                connecting: '正在连接...',
                connected: '已连接',
                disconnected: '已断开',
                error: '错误'
            }
        },

        checkpoint: {
            description: {
                before: '执行前',
                after: '执行后'
            },
            restore: {
                success: '已恢复到 "{toolName}" {phase}的状态',
                filesUpdated: '{count} 个文件已更新',
                filesDeleted: '{count} 个文件已删除',
                filesUnchanged: '{count} 个文件未变化',
                chainBroken: '增量链断裂：引用的基准检查点缺失',
                partialFailure: '已恢复到 "{toolName}" {phase}的状态，但有 {count} 个文件失败',
                workspaceMismatch: '当前工作区与存档记录的工作区不一致，拒绝恢复',
                multiRootLegacyNotSupported: '旧版存档（相对路径格式）不支持在多根工作区中恢复',
                checkpointNotFound: '存档未找到',
                manifestMissing: '存档备份数据缺失（未找到 manifest）',
                cannotBuildChain: '无法构建存档增量链',
                backupDirNotFound: '备份目录未找到: {dirs}',
                moreFailures: '另有 {count} 个失败',
                excludedNote: '该存档创建时按当时的排除规则排除了 {count} 个文件',
                excludedNoteChanged: '该存档创建时按当时的排除规则排除了 {count} 个文件；当前排除规则已变化，恢复将按当前规则执行'
            },
            defaultConversationTitle: '对话 {conversationId}',
            errors: {
                createFailed: '创建检查点失败',
                restoreFailed: '恢复检查点失败',
                deleteFailed: '删除检查点失败'
            }
        },

        settings: {
            contextMethod: {
                defaultTitle: '默认上下文处理方式',
                description: '自动和手动操作都优先使用当前渠道的上下文处理方式，渠道未单独设置时沿用这里的默认值。原始消息和附件始终保留，可恢复、搜索和查看。',
                defaultHint: '渠道设置优先于此默认值。Bot 保留自己的方式选择，并可使用原有时间总结。',
                channelTitle: '上下文处理方式',
                channelHint: '用于该渠道的自动处理和手动总结。阈值只影响自动触发；保存后对新回合和下一次手动操作生效。',
            },
            contextRetention: {
                title: '普通会话的用户消息保留',
                first: '首条用户消息＋最近一次输入',
                all: '全部用户消息',
                hint: '用于普通会话的自动总结、手动总结和笔记管理，始终保留最近一次用户输入；Bot 沿用独立配置。修改从后续回合或手动操作开始生效。',
                summaryHint: '沿用当前模型、系统提示词和工具定义，在完整上下文末尾追加总结指令。成功后保留所选用户原文与新摘要，后续消息继续追加。',
                notesHint: '手动操作切换到新的上下文，保留所选用户消息和恢复提示，随后按需读取工作笔记与历史。',
            },
            clawdSettings: {
                title: 'Clawd 独立桌宠联动',
                description: '让已启动的 Clawd 跟随 GrayCode 的任务显示思考、工具执行、等待确认、完成和失败状态。',
                enabled: '启用任务状态联动',
                agentId: 'Clawd Agent ID',
                setup: '在 Clawd 的 Settings → Agents 中添加 GrayCode 的可执行文件或安装目录，扫描后注册，再把生成的 Agent ID 复制到这里。',
                hint: '保存全部后生效。只连接 GrayCode 服务端所在电脑的 Clawd，端口自动发现；审批继续在 GrayCode 中完成。',
                check: '检查连接',
                checking: '正在检查…',
                saveFirst: '请先点击“保存全部”，再检查连接。',
                status_disabled: '尚未启用',
                status_waiting: '已启用，等待任务事件',
                status_connected: 'Clawd 已接收状态；勿扰模式可能隐藏动画',
                status_offline: 'Clawd 未运行或暂时无法连接，任务继续正常执行',
                status_unregistered: '请在 Clawd 中注册并启用此 Agent ID',
                status_error: 'Clawd 未接受状态，请检查版本和注册设置',
                invalidAgentId: '请填写 Clawd 设置中注册 GrayCode 后生成的完整 Agent ID。',
            },
            backgroundGalleryPolicy: 'JPG、PNG、WebP，每张不超过 10 MB。导入的图片随设置一起保存或撤销；上传和管理已保存的图库图片会立即生效。',
            errors: {
                loadFailed: '加载设置失败',
                saveFailed: '保存设置失败',
                invalidValue: '无效的设置值',
                invalidCheckpointExclusionPatterns: '存档排除规则无效: {detail}',
                invalidCheckpointExclusionProfiles: '存档排除类别无效: {detail}',
                invalidCheckpointMaxFileSize: '单文件大小上限必须是有限数值',
                invalidCheckpointConfigField: '存档点配置字段无效: {field}',
                exclusionPatternReason: {
                    empty: '空模式',
                    absolute: '绝对路径模式',
                    negationOnly: '纯 ! 否定（缺少规则体）',
                    traversal: '包含 .. 越界',
                    newline: '包含换行',
                    blanket: '全量忽略（排除整个工作区）'
                }
            },
            storage: {
                pathNotAbsolute: '路径必须是绝对路径: {path}',
                pathNotDirectory: '路径必须是目录: {path}',
                createDirectoryFailed: '创建目录失败: {error}',
                migrationFailed: '迁移失败: {error}',
                migrationSuccess: '存储迁移完成',
                migratingFiles: '正在迁移文件...',
                migratingConversations: '正在迁移对话...',
                migratingCheckpoints: '正在迁移存档点...',
                migratingConfigs: '正在迁移配置...'
            },
            exporter: {
                parseFailed: '解析导出文件失败：{error}',
                invalidRoot: '导出文件格式无效：根元素必须是对象',
                missingVersion: '导出文件缺少 version 字段',
                unsupportedVersion: '不支持的导出文件版本：{version}（当前仅支持 {supported}）',
                missingChannelConfigs: '导出文件缺少 channelConfigs 数组',
                missingMcpServers: '导出文件缺少 mcpServers 数组',
                missingSkills: '导出文件缺少 skills 数组',
                missingVscodeSettings: '导出文件缺少 vscodeSettings 对象',
                importVscodeSettingsFailed: '导入 VSCode 设置失败：{error}',
                importChannelConfigsFailed: '导入渠道配置失败：{error}',
                importMcpServersFailed: '导入 MCP 服务器配置失败：{error}',
                importSkillsFailed: '导入 Skills 失败：{error}',
                reloadSettingsFailed: '重载设置失败：{error}',
                partialVscodeSettingsImportFailed: '部分 VSCode 设置导入失败：{detail}',
                channelConfigItemError: '渠道配置 "{name}": {error}',
                partialChannelConfigsImportFailed: '部分渠道配置导入失败：{detail}',
                mcpServerItemError: 'MCP 服务器 "{name}": {error}',
                partialMcpServersImportFailed: '部分 MCP 服务器配置导入失败：{detail}',
                skillItemError: 'Skill "{name}": {error}',
                skillRestoreError: 'Skill "{name}" 启用状态恢复：{error}',
                skillRestoreFailuresSummary: '{count} 个 Skill 启用状态恢复失败（文件已导入）：{detail}',
                partialSkillsImportFailed: '部分 Skill 导入失败：{detail}'
            }
        },

        update: {
            errors: {
                cannotReadVersion: '无法读取当前扩展版本',
                invalidDownloadUrl: '非法下载地址：仅接受本仓库 GitHub Releases 的 vsix 安装包。',
                invalidVersion: '非法版本号：{version}',
                downloadFailed: '下载失败：HTTP {status} {statusText}',
                emptyDownload: '下载内容为空，vsix 可能已损坏。',
                downloadTimeout: '下载超时（超过 {seconds} 秒）',
                apiError: 'GitHub Releases API 返回 {status} {statusText}',
                apiResponseInvalid: 'GitHub Releases API 响应格式异常',
                checkTimeout: '检查超时（超过 {seconds} 秒）'
            }
        },

        dependencies: {
            descriptions: {
                sharp: '高性能图像处理库，用于抠图功能的遮罩应用',
                pdfjsDist: 'PDF 页面渲染库，用于 DeepSeek Vision 的逐页图像输入',
                napiCanvas: 'Node.js 原生画布实现，用于将 PDF 页面栅格化为图像'
            },
            errors: {
                requiresContext: 'DependencyManager 需要首次调用时传入 ExtensionContext',
                unknownDependency: '未知依赖: {name}',
                nodeModulesNotFound: '安装后未找到 node_modules 目录',
                moduleNotFound: '安装后未找到 {name} 模块',
                installFailed: '安装失败: {error}',
                uninstallFailed: '卸载 {name} 失败',
                loadFailed: '加载 {name} 失败'
            },
            progress: {
                installing: '正在安装 {name}...',
                downloading: '正在下载 {name}...',
                installSuccess: '{name} 安装成功！'
            }
        },

        channel: {
            formatters: {
                streamError: '{provider} 在流式响应中返回错误: {message}',
                gemini: {
                    errors: {
                        invalidResponse: '无效的 Gemini API 响应: 没有候选结果',
                        apiError: 'API 返回错误状态: {code}',
                        emptyCandidate: 'Gemini 返回了无内容的候选（终止原因: {finishReason}，可能是内容安全拦截）'
                    }
                },
                anthropic: {
                    errors: {
                        invalidResponse: '无效的 Anthropic API 响应: 没有内容'
                    }
                },
                openai: {
                    errors: {
                        invalidResponse: '无效的 OpenAI API 响应: 没有选项'
                    }
                }
            },
            errors: {
                configNotFound: '配置不存在: {configId}',
                configDisabled: '配置已禁用: {configId}',
                unsupportedChannelType: '不支持的渠道类型: {type}',
                configValidationFailed: '配置验证失败: {configId}',
                buildRequestFailed: '构建请求失败: {error}',
                apiError: 'API 返回错误状态: {status}',
                parseResponseFailed: '解析响应失败: {error}',
                httpRequestFailed: 'HTTP 请求失败: {error}',
                parseStreamChunkFailed: '解析流式响应块失败: {error}',
                streamRequestFailed: '流式请求失败: {error}',
                requestTimeout: '请求超时 ({timeout}ms)',
                requestTimeoutNoResponse: '请求超时 ({timeout}ms 内无响应)',
                requestCancelled: '请求已取消',
                requestAborted: '请求已中止',
                noResponseBody: '没有响应体',
                emptyResponse: '模型返回了空内容',
                streamTruncated: '流式输出被截断（未收到完整结束标记），可能由网络或代理中断导致',
                streamBufferOverflow: '流式响应缓冲区超过大小上限：上游数据无法解析（缓冲持续累积未被消费）',
                invalidRetryConfig: '无效的重试配置: {configId}（retryCount 必须为非负整数）'
            },
            modelList: {
                errors: {
                    apiKeyRequired: 'API Key 是必需的',
                    fetchModelsFailed: '获取模型列表失败: {error}',
                    unsupportedConfigType: '不支持的配置类型: {type}'
                }
            }
        },

        api: {
            channel: {
                errors: {
                    listChannelsFailed: '获取渠道配置列表失败',
                    channelNotFound: '渠道配置不存在: {channelId}',
                    getChannelFailed: '获取渠道配置失败',
                    channelAlreadyExists: '渠道配置已存在: {channelId}',
                    createChannelFailed: '创建渠道配置失败',
                    updateChannelFailed: '更新渠道配置失败',
                    deleteChannelFailed: '删除渠道配置失败',
                    setChannelStatusFailed: '设置渠道状态失败'
                }
            },
            settings: {
                errors: {
                    getSettingsFailed: '获取设置失败',
                    updateSettingsFailed: '更新设置失败',
                    setActiveChannelFailed: '设置活动渠道失败',
                    setToolStatusFailed: '设置工具状态失败',
                    batchSetToolStatusFailed: '批量设置工具状态失败',
                    setDefaultToolModeFailed: '设置默认工具模式失败',
                    updateUISettingsFailed: '更新 UI 设置失败',
                    updateProxySettingsFailed: '更新代理设置失败',
                    resetSettingsFailed: '重置设置失败',
                    toolRegistryNotAvailable: '工具注册器不可用',
                    getToolsListFailed: '获取工具列表失败',
                    getToolConfigFailed: '获取工具配置失败',
                    updateToolConfigFailed: '更新工具配置失败',
                    updateListFilesConfigFailed: '更新 list_files 配置失败',
                    updateApplyDiffConfigFailed: '更新 apply_diff 配置失败',
                    getCheckpointConfigFailed: '获取存档点配置失败',
                    updateCheckpointConfigFailed: '更新存档点配置失败',
                    getSummarizeConfigFailed: '获取总结配置失败',
                    updateSummarizeConfigFailed: '更新总结配置失败',
                    getGenerateImageConfigFailed: '获取图像生成配置失败',
                    updateGenerateImageConfigFailed: '更新图像生成配置失败',
                    tokenCountFailed: 'Token 计数失败',
                    toolNotFound: '未找到工具: {toolName}',
                    memoryConfigFailed: '获取记忆配置失败',
                    updateMemoryConfigFailed: '更新记忆配置失败'
                }
            },
            models: {
                errors: {
                    configNotFound: '配置不存在',
                    getModelsFailed: '获取模型列表失败',
                    addModelsFailed: '添加模型失败',
                    removeModelFailed: '移除模型失败',
                    modelNotInList: '模型不在列表中',
                    setActiveModelFailed: '设置激活模型失败'
                }
            },
            mcp: {
                errors: {
                    listServersFailed: '获取 MCP 服务器列表失败',
                    serverNotFound: 'MCP 服务器不存在: {serverId}',
                    getServerFailed: '获取 MCP 服务器失败',
                    createServerFailed: '创建 MCP 服务器失败',
                    updateServerFailed: '更新 MCP 服务器失败',
                    deleteServerFailed: '删除 MCP 服务器失败',
                    setServerStatusFailed: '设置 MCP 服务器状态失败',
                    connectServerFailed: '连接 MCP 服务器失败',
                    disconnectServerFailed: '断开 MCP 服务器失败'
                }
            },
            chat: {
                errors: {
                    configNotFound: '配置不存在: {configId}',
                    configDisabled: '配置已禁用: {configId}',
                    maxToolIterations: '达到最大工具调用次数限制 ({maxIterations})',
                    unknownError: '未知错误',
                    toolExecutionSuccess: '工具执行成功',
                    mcpToolCallFailed: 'MCP 工具调用失败',
                    invalidMcpToolName: '无效的 MCP 工具名称: {toolName}',
                    toolNotFound: '工具不存在: {toolName}',
                    toolExecutionFailed: '工具执行失败',
                    noHistory: '对话历史为空',
                    lastMessageNotModel: '最后一条消息不是模型消息',
                    noFunctionCalls: '没有待确认的工具调用',
                    userRejectedTool: '用户拒绝执行此工具',
                    toolCallCancelled: '用户取消了本次请求，该工具调用未执行',
                    notEnoughRounds: '对话回合数不足，当前 {currentRounds} 轮，保留 {keepRounds} 轮，无需总结',
                    notEnoughContent: '对话回合数不足，当前 {currentRounds} 轮，保留 {keepRounds} 轮，没有可总结的内容',
                    noMessagesToSummarize: '没有需要总结的消息',
                    summarizeAborted: '总结请求已取消',
                    emptySummary: 'AI 生成的总结为空',
                    lowQualitySummary: 'AI 生成的总结过短，可能丢失重要信息，已放弃替换对话历史',
                    summarizeRangeStale: '对话历史在总结期间发生变化，本次总结的范围已失效，已放弃写入',
                    messageNotFound: '消息不存在: 索引 {messageIndex}',
                    canOnlyEditUserMessage: '只能编辑用户消息，当前消息角色为: {role}',
                    messageChanged: '消息已变化，请刷新后重试',
                    invalidTargetIndex: '无效的删除目标索引: {targetIndex}',
                    editTargetNotInHistory: '所选消息不在当前对话历史中，可能已被上下文压缩移除',
                    contextOverflow: '无法在模型上下文窗口内构造合法请求：最小候选约需 {estimatedInputTokens} 个输入 token，超出 {inputTokenLimit} token 的窗口。请增大模型上下文窗口，或清理历史/调整保留预算',
                    summarizeContextOverflow: '待总结内容和总结提示词超出总结模型上下文上限，请增大总结模型的上下文窗口或调整保留预算'
                },
                prompts: {
                    defaultSummarizePrompt: '请总结以上对话，让后续工作只凭这份总结就能继续。',
                    summaryPrefix: '[对话总结]',
                    autoSummarizePrompt: '对话即将达到上下文上限。请总结以上内容，让未完成的任务只凭这份总结就能继续。'
                }
            }
        }
    },

    tools: {
        contextStatus: {
            title: '输入 token 用量', remaining: '剩余额度', reservedOutput: '预留输出', capacity: '上下文容量',
            threshold: '总结阈值', method: '管理方式', retention: '保留用户消息',
            summary: '普通总结', notes: '笔记管理', retainFirst: '首条与最近一次', retainAll: '全部', retainBot: '按 Bot 配置',
            summaryOption: '普通总结 · 压缩历史内容', notesOption: '笔记管理 · 按需恢复历史',
            notesHint: '达到阈值后保存工作笔记，切换到新的上下文，再读取笔记和所需历史继续任务。',
            switched: '已切换上下文', disabled: '自动管理已关闭', pending: '等待切换上下文',
            normal: '余量充足', overThreshold: '已达总结阈值', overBudget: '超出输入上限', unknown: '未提供',
            localEstimate: '本地估算', usageSource: '当前用量', details: '用量明细', empty: '暂无用量数据',
            fixedPrompt: '固定提示', history: '历史消息', messages: '消息数量', measuredAt: '查询时间',
            thresholdTokens: '阈值 token 数', contextId: '上下文编号', initial: '初始上下文',
        },
        runtimeControl: {
            contextStatusName: '上下文状态',
            contextStatusDescription: '查询当前token用量与总结策略',
            terminalTaskName: '后台终端任务',
            terminalTaskDescription: '查询 execute_command 的任务状态、增量读取输出或停止对应受管进程树。',
        },
        automation: {
            "actions": {
                "list": "列出",
                "create": "新建",
                "show": "显示",
                "close": "关闭",
                "snapshot": "读取页面",
                "screenshot": "截图",
                "logs": "读取日志",
                "navigate": "导航",
                "back": "后退",
                "forward": "前进",
                "reload": "重新加载",
                "click": "点击",
                "hover": "悬停",
                "check": "设置选中状态",
                "wait": "等待页面条件",
                "type": "输入",
                "fill": "填入",
                "press": "按键",
                "scroll": "滚动",
                "drag": "拖动",
                "upload": "上传",
                "download": "下载",
                "acquire": "取得控制",
                "status": "查询状态",
                "release": "释放控制",
                "focusWindow": "聚焦窗口",
                "focusElement": "聚焦控件",
                "invoke": "调用控件",
                "setValue": "设置值",
                "select": "选择",
                "toggle": "切换",
                "expand": "展开",
                "collapse": "收起",
                "key": "按键",
                "query": "查询桌宠",
                "play": "播放动作",
                "expression": "设置表情",
                "look": "调整视线",
                "parameters": "设置参数",
                "cancel": "取消动作",
                "resume": "恢复",
                "stat": "附件信息",
                "read": "读取附件"
            },
            "currentPage": "当前页面",
            "openedTabs": "本次打开的新标签",
            "openedTabsHint": "下方截图与快照仍属于原标签。查看新页面时，请使用对应的新标签 ID。",
            "closedTab": "已关闭",
            "requestedUrl": "打开地址",
            "profiles": "登录配置",
            "activeTab": "当前标签",
            "untitled": "无标题",
            "noTabs": "没有打开的标签页",
            "loading": "加载中",
            "userControlled": "用户已接管",
            "controlledBy": "控制任务",
            "windowVisible": "工作台窗口可见",
            "logs": "页面日志",
            "noLogs": "没有新日志",
            "nextCursor": "续读游标",
            "snapshotCount": "本次返回 {count} 项，共匹配 {total} 项",
            "conditionMet": "页面已满足等待条件",
            "conditionTimedOut": "等待结束，页面尚未满足条件",
            "truncated": "结果已截断，仅显示本次返回的部分",
            "uploaded": "已放入文件选择控件",
            "downloaded": "已保存下载文件",
            "observation": "观察记录",
            "capturedAt": "采集时间",
            "dimensions": "图片尺寸",
            "imageCoordinates": "坐标基于返回图片的实际像素",
            "observationUnavailable": "后续观察失败（不改变动作结果）",
            "operationStatus": "动作结果",
            "operationUnknown": "结果未确认",
            "dispatching": "已派发，等待确认",
            "repeated": "返回已有动作回执，未重复执行",
            "displays": "显示器",
            "primaryDisplay": "主显示器",
            "foreground": "前台窗口",
            "minimized": "已最小化",
            "noWindows": "没有可用窗口",
            "control": "电脑控制状态",
            "controlActive": "控制中",
            "controlInactive": "未控制",
            "reason": "状态原因",
            "controller": "控制者",
            "stopShortcut": "停止快捷键",
            "available": "可用",
            "unavailable": "不可用",
            "focusedElement": "当前焦点",
            "accessibilityUnavailable": "控件读取失败",
            "noElements": "本次观察未返回控件",
            "petModel": "当前桌宠",
            "noPet": "没有选中的桌宠",
            "renderer": "播放器",
            "phases": {
                "unloaded": "未加载",
                "loading": "加载中",
                "ready": "就绪",
                "failed": "加载失败"
            },
            "visible": "已显示",
            "stopped": "用户已停止",
            "accepted": "请求已接受",
            "notAccepted": "请求未接受",
            "applied": "播放器已确认应用",
            "notApplied": "播放器未确认应用",
            "currentCommand": "当前动作",
            "confirmedCommand": "最近确认的动作",
            "petActions": "可用动作",
            "expressions": "可用表情",
            "parameterRanges": "实际参数范围",
            "range": "范围",
            "defaultValue": "默认值",
            "duration": "持续时间",
            "lookAngle": "视线角度",
            "front": "恢复正面",
            "requestId": "请求标识",
            "attachments": "会话附件",
            "noAttachments": "此会话没有可读取的附件",
            "size": "文件大小",
            "encoding": "编码",
            "characterRange": "字符范围 {start}–{end}",
            "nextOffset": "续读偏移",
            "endOfDocument": "已到文档末尾",
            "emptyText": "此范围没有正文"
        },
        platform: {
            "noData": "未返回结果详情。",
            "partial": "结果不完整",
            "nextOffset": "续查位置：{offset}",
            "nextCursor": "还有下一页，续查游标见详情。",
            "version": "版本 {version}",
            "file": {
                "actions": {
                    "list": "列出文件",
                    "read": "读取文件",
                    "write": "写入文件",
                    "edit": "编辑文件",
                    "delete": "删除文件"
                },
                "range": "第 {start}–{end} 行，共 {total} 行",
                "nextLine": "下一段从第 {line} 行读取",
                "matches": "{count} 处匹配",
                "scanned": "已扫描 {count} 个文件",
                "scanIncomplete": "搜索尚未完成，当前结果只来自已经扫描的文件。",
                "scanIncompleteEmpty": "搜索尚未完成，当前0条结果不代表整个范围没有匹配。",
                "scanLimit": "已达到文件扫描上限；请缩小目录。偏移量无法访问尚未扫描的文件。",
                "matchLimit": "还有匹配结果；保持查询、目录和大小写选项不变后续查。",
                "saved": "文件已写入",
                "deleted": "文件已删除",
                "requested": "请求写入的内容",
                "before": "替换前",
                "after": "替换后",
                "empty": "没有文件条目",
                "noMatches": "没有匹配的行"
            },
            "process": {
                "actions": {
                    "read": "读取进程输出",
                    "input": "发送进程输入",
                    "stop": "停止进程"
                },
                "running": "进程仍在运行",
                "exited": "进程已退出",
                "unknown": "未返回进程状态",
                "output": "进程输出",
                "noOutput": "暂无进程输出",
                "truncated": "仅保留末尾输出，更早内容已截断。",
                "input": "发送的输入",
                "taskActions": { "list": "后台命令列表", "status": "后台命令状态", "read": "读取后台命令输出", "stop": "停止后台命令" },
                "taskCount": "共 {count} 个命令任务",
                "noTasks": "当前对话没有后台命令任务",
                "interrupted": "已中断",
                "moreOutput": "还有已生成的输出，可继续读取。"
            },
            "team": {
                "actions": {
                    "list": "共享任务",
                    "get": "任务详情",
                    "create": "创建任务",
                    "claim_ready": "领取可执行任务",
                    "claim": "领取任务",
                    "complete": "完成任务",
                    "release": "释放任务",
                    "set_dependencies": "更新任务依赖"
                },
                "task": "任务",
                "dependencies": "{count} 个依赖",
                "blockedBy": "{count} 个未完成依赖",
                "ready": "{count} 个任务可领取",
                "unclaimed": "尚未领取",
                "assigned": "已领取",
                "empty": "没有返回任务",
                "noReady": "没有可领取的任务",
                "emptyEvents": "没有新的团队事件",
                "nextTasks": "还有任务；续查创建序号：{sequence}",
                "moreEvents": "还有事件；续查序号：{sequence}",
                "reasons": {
                    "events": "收到团队事件",
                    "ready_work": "有任务可领取",
                    "no_progress": "当前无法继续推进",
                    "timeout": "等待超时，未收到新事件"
                },
                "noProgress": "没有可执行任务或其他活跃成员能够推进；需处理阻塞、报告问题或结束等待。",
                "events": {
                    "task_created": "任务已创建",
                    "task_claimed": "任务已领取",
                    "task_completed": "任务已完成",
                    "task_released": "任务已释放",
                    "task_dependencies_changed": "任务依赖已更新",
                    "message_queued": "消息已排队",
                    "member_changed": "成员状态已变化"
                }
            },
            "memory": {
                "topics": "记忆主题",
                "scopes": "授权范围",
                "records": "{count} 条记忆",
                "sources": "来源摘录",
                "source": "来源",
                "root": "主题根目录",
                "empty": "没有返回记忆",
                "kinds": {
                    "fact": "事实",
                    "preference": "偏好",
                    "experience": "经历",
                    "project": "项目",
                    "procedure": "流程",
                    "event": "事件",
                    "summary": "摘要"
                },
                "confidence": {
                    "confirmed": "已确认",
                    "inferred": "推断",
                    "disputed": "有争议"
                },
                "origins": {
                    "user": "用户消息",
                    "model": "模型消息",
                    "tool": "工具结果",
                    "fiction": "角色剧情",
                    "import": "导入资料"
                },
                "scopeKinds": {
                    "personal": "个人",
                    "workspace": "项目",
                    "group": "群组",
                    "library": "资料库"
                },
                "preview": "移除影响预览 · 尚未删除",
                "apply": "移除回执",
                "retract": "撤回回执",
                "affected": "影响 {total} 项，其中 {records} 条记忆",
                "removed": "已移除 {count} 项",
                "requested": "提交的记忆内容",
                "append": "请求追加的内容",
                "saved": "已返回 {count} 条保存记录",
                "omitted": "{count} 项因预算或数量限制未返回",
                "unavailable": "{count} 项不可用",
                "requiredBudget": "所需 token 预算：{count}",
                "truncated": "仅返回部分记忆；可缩小范围或调整预算。",
                "pageRange": "字符 {start}–{end} / {total}",
                "sourcePage": "来源正文分段",
                "recordPage": "记忆正文分段",
                "conflicts": "{count} 条冲突记录",
                "dependencies": "{count} 项来源或记忆依赖",
                "previewIds": "受影响的记忆与来源编号"
            }
        },
        contextNotes: {
            recorded: '已记录 {count} 条笔记', submitted: '本次提交 {count} 条笔记',
            recalled: '本次返回 {count} 条笔记正文', budget: '本地估算 {used} / {budget} tokens',
            alreadyProvided: '{count} 条笔记已在当前上下文中提供',
            providedExplanation: '这些笔记的正文仍对模型可见，本次返回历史引用；需要重读时可按笔记编号使用 inspect。',
            historyReference: '历史位置：', missingDependencies: '{count} 条必需依据未完整返回',
            unavailable: '{count} 条笔记当前不可用', omitted: '{count} 条笔记因预算或数量限制未返回',
            truncated: '本次召回未取得完整依据，可缩小范围或增加 token 预算后继续读取。',
            empty: '未找到当前有效的笔记。', replacements: '笔记的替代关系', about: '相关主题：',
            sourceRange: '来源 offset={offset}，length={length}', nextOffset: '续读 offset={offset}。',
            kinds: { constraint: '约束', decision: '决定', observation: '观察', hypothesis: '推测', task: '任务', lesson: '经验' },
            states: { current: '当前有效', superseded: '已被替代', outside_time: '不在查询时间范围内', source_unavailable: '来源已失效' },
            relations: { requires: '依赖', supports: '支持', contradicts: '与此冲突', applies_to: '适用于', supersedes: '替代' },
            providedReasons: { recorded: '已在记录调用中提供', recalled: '已在召回结果中提供', verbatim: '原文已在当前上下文中提供' },
            historyActions: { windows: '列出上下文窗口', list: '列出最近消息', search: '搜索历史', read: '读取消息' },
        },
        presentation: {
            gotoDefinition: {
                pageSummary: '本页显示 {returned} 个定义，共 {total} 个',
                nextPage: '继续查看下一页时，使用 offset={offset} 并保持查询条件不变。',
                contentTruncated: '这个定义的正文已截断，可按显示的路径和行号范围读取剩余代码。',
                emptyPage: '本页没有定义'
            },
            // Responses 由渠道开关决定 strict；说明不能再暗示未勾选时也默认启用。
            strictToolsOpenaiResponses: 'OpenAI Responses：默认关闭；启用后可选参数允许 null',
            messageBody: '发送内容', recipient: '收件方', mainAgent: '主模型',
            contentUnavailable: '这条历史记录未保存消息正文，可在详情中查看现有回执。',
            messageSaved: '消息已保存，等待接收方在运行边界读取。',
            noteContent: '笔记正文', appendedContent: '本次追加内容', noteDirectory: '笔记目录',
            historyMessages: '历史记录', characters: '{count} 字符',
            invalidatedNote: '这份笔记已失效，需要根据有效来源重新整理。',
            partialContent: '当前只显示部分正文，可按工具返回的范围继续读取。',
            partialSuccess: '部分成功', partialRange: '部分内容', diffUnavailable: '无法读取差异内容。',
            cancelFailed: '取消任务失败，请重试。',
            searchReplace: {
                accepted: '已应用', rejected: '已拒绝', pending: '待确认',
                filesRejected: '已拒绝 {count} 个文件', proposed: '候选替换 {count} 处', skipped: '跳过 {count} 个文件',
                keywordFallback: '已按以下关键词分别搜索：',
            },
            moreHistory: '还有更早记录，可使用返回的历史位置继续读取。',
            // 分页属于工具续查，不是卡片的本地展开；排除来源只反映本次回执，不推测当前设置。
            findFiles: {
                returnedFiles: '本次返回 {count} 个文件',
                pageFiles: '本页 {count} 个文件',
                pageOffset: '本页已跳过 {offset} 个文件',
                nextPage: '下一页需重新调用：offset={offset}，保持此模式及排除条件不变',
                expandPage: '展开本页剩余 {count} 个文件',
                restartAfterFailure: '搜索未完整完成；修复错误后从 offset=0 重查，不能依赖本页继续翻页。',
                continuationDetails: '续查说明',
                workspaceErrors: '工作区搜索失败',
                exclusions: '实际排除规则',
                excludeSources: {
                    argument: '本次参数（替换设置）',
                    settings: '工具设置',
                    fallback: '默认回退',
                    includeIgnored: '显式纳入忽略文件',
                    unknown: '来源未记录'
                }
            }
        },
        errors: {
            toolNotFound: '工具未找到: {toolName}',
            executionFailed: '工具执行失败: {error}',
            invalidParams: '无效的参数',
            timeout: '执行超时'
        },

        file: {
            errors: {
                fileNotFound: '文件未找到: {path}',
                readFailed: '读取文件失败: {error}',
                writeFailed: '写入文件失败: {error}',
                deleteFailed: '删除文件失败: {error}',
                permissionDenied: '权限被拒绝: {path}'
            },
            diffManager: {
                saved: '已保存修改: {filePath}',
                saveFailed: '保存失败: {error}',
                savedShort: '已保存: {filePath}',
                rejected: '已拒绝修改: {filePath}',
                diffTitle: '{filePath} (AI 修改 - Ctrl+S 保存)',
                diffGuardWarning: '此次修改删除了 {deletePercent}% 的文件内容（{deletedLines}/{totalLines} 行），超过 {threshold}% 的警戒阈值，请仔细检查'
            },
            diffCodeLens: {
                accept: '接受',
                reject: '拒绝',
                acceptAll: '全部接受',
                rejectAll: '全部拒绝'
            },
            diffEditorActions: {
                noActiveDiff: '当前没有待处理的 diff 修改',
                allBlocksProcessed: '所有 diff 块都已处理',
                diffBlock: 'Diff 块 #{index}',
                lineRange: '第 {start}-{end} 行',
                acceptAllBlocks: '接受所有块',
                rejectAllBlocks: '拒绝所有块',
                blocksCount: '{count} 个待处理块',
                selectBlockToAccept: '选择要接受的 Diff 块',
                selectBlockToReject: '选择要拒绝的 Diff 块',
                selectBlockPlaceholder: '可以多选'
            },
            diffInline: {
                hoverOrLightbulb: '悬停或点击 💡 应用修改',
                acceptBlock: '接受 Diff 块 #{index}',
                rejectBlock: '拒绝 Diff 块 #{index}',
                acceptAll: '接受所有修改',
                rejectAll: '拒绝所有修改'
            },
            readFile: {
                cannotReadFile: '无法读取此文件'
            },
            selectionContext: {
                hoverAddToInput: '添加选中内容到输入框',
                codeActionAddToInput: 'LimCode: 添加选中代码到输入框',
                noActiveEditor: '没有活动编辑器',
                noSelection: '没有选中内容',
                failedToAddSelection: '添加选中内容失败: {error}'
            }
        },

        terminal: {
            nextActions: {
                processMoreOutput: '继续读取尚未返回的保留输出。',
                processIntermediateOutput: '需要中间输出时再读取，期间继续处理独立工作。',
                processInspect: '查看当前会话状态和保留输出，此操作不会重启命令。',
                nativePending: '原生异步调用仍在运行。继续处理独立工作，需要最终结果时将 task_handle 传给 wait_for_tasks；中间输出使用 terminal_task 读取。',
                nativeWait: '仅在后续工作需要这条原生异步命令的结果时等待。',
                terminalStatus: '需要状态或诊断时再查询，完成结果会自动交付。',
                terminalMoreOutput: '继续读取剩余的输出页。',
                terminalIntermediateOutput: '需要中间输出或判断进展时再读取。',
                terminalExitedMoreOutput: '命令已退出，继续读取剩余输出，无需等待。',
                terminalExitedInspect: '命令已退出，仅在需要进一步诊断时读取保留输出。',
                terminalNextPage: '继续读取下一页任务。',
                terminalResetCursor: '省略无效游标读取保留输出，并使用返回的 nextCursor 继续读取。'
            },
            errors: {
                executionFailed: '命令执行失败',
                timeout: '命令执行超时',
                killed: '命令被终止'
            },
            shellCheck: {
                wslNotInstalled: 'WSL 未安装或未启用',
                shellNotFound: '找不到: {shellPath}',
                shellNotInPath: '{shellPath} 不在 PATH 中'
            }
        },

        search: {
            errors: {
                searchFailed: '搜索失败: {error}',
                invalidPattern: '无效的搜索模式: {pattern}'
            }
        },

        media: {
            errors: {
                processingFailed: '处理失败: {error}',
                invalidFormat: '无效的格式: {format}',
                dependencyMissing: '缺少依赖: {dependency}'
            }
        },
        
        common: {
            taskNotFound: '任务 {id} 未找到或已完成',
            cancelTaskFailed: '取消任务失败: {error}',
            toolAlreadyExists: '工具已存在: {name}',
            show: '显示',
            hide: '隐藏'
        },
        
        skills: {
            exampleSkill: {
                description: '创建 Skill 前必读！了解 Skill 的正确格式、命名规则和常见错误。',
                content: `# 创建 Skill 前必读

## ⚠️ 注意事项（常见错误）

1. **name 必须与文件夹名完全一致**
   - 文件夹名为 \`my-tool\`，则 frontmatter 中必须写 \`name: my-tool\`
   - 不一致时 Skill 会被静默跳过，不会出现在面板中

2. **name 只允许小写字母、数字、连字符**
   - ✅ \`my-skill-name\`、\`tool2\`
   - ❌ \`My_Skill\`、\`工具\`、\`my--skill\`（不允许连续连字符）
   - 长度 1-64 个字符

3. **frontmatter 是必需的**
   - 文件必须以 \`---\` 开头，包含 \`name\` 和 \`description\` 两个字段
   - 缺少 frontmatter 的 SKILL.md 会被忽略

## Skill 文件格式

\`\`\`markdown
---
name: your-skill-name
description: "简要描述该技能的功能及使用场景"
---

# 你的技能名称

## 指令
[为 AI 提供清晰、逐步的指导]

## 示例
[使用此技能的具体例子]
\`\`\`

## 创建步骤

1. 在 skills 目录中创建文件夹（名称即为 skill name）
2. 在该文件夹中创建 \`SKILL.md\` 文件
3. 在文件开头写 frontmatter（\`name\` + \`description\`）
4. 在 frontmatter 之后写技能内容

## Skills 目录位置

- 项目级：\`.graycode/skills/\` 或 \`.agents/skills/\`
- 用户级：\`~/.graycode/skills/\` 或 \`~/.agents/skills/\`

项目级优先级高于用户级。同名 Skill 只加载优先级最高的那个。

## 工作原理

1. AI 在工具描述中可以看到所有已启用 Skill 的名称和描述
2. 当 AI 判断需要时，会调用 \`read_skill\` 工具读取 Skill 全文
3. 这种按需加载机制可以节省 token，让 AI 根据任务动态选择知识模块`
            },
            errors: {
                managerNotInitialized: 'Skills 管理器未初始化'
            }
        },
        
        history: {
            noSummarizedHistory: '没有找到已总结的历史记录。当前对话尚未触发上下文总结。',
            noHistory: '未找到对话历史记录。',
            searchResultHeader: '在历史记录中找到 {count} 个匹配项，关键词："{query}"（共 {totalLines} 行）',
            noMatchesFound: '在历史记录中未找到 "{query}" 的匹配项（共 {totalLines} 行）。请尝试其他关键词。',
            keywordFallbackNotice: '[未找到完整短语，已改用空格分隔关键词搜索：{terms}]',
            resultsLimited: '[结果限制为 {max} 个匹配项。请使用更具体的关键词。]',
            readResultHeader: '历史记录的第 {start}-{end} 行（共 {totalLines} 行）',
            readTruncated: '[输出限制为 {max} 行。使用 start_line={nextStart} 继续读取。]',
            invalidRegex: '无效的正则表达式：{error}',
            invalidRange: '无效的行范围：{start}-{end}（文档共 {totalLines} 行）',
            errors: {
                contextRequired: '需要工具上下文',
                conversationIdRequired: '工具上下文中需要 conversationId',
                conversationStoreRequired: '工具上下文中需要 conversationStore',
                getHistoryNotAvailable: 'conversationStore.getHistory 不可用',
                invalidMode: '无效的模式："{mode}"。必须是 "search" 或 "read"',
                queryRequired: 'search 模式需要 query 参数',
                searchFailed: '历史搜索失败：{error}'
            }
        },
        reviewDocument: {
            sections: {
                scope: '评审范围',
                summary: '评审摘要',
                findings: '评审发现',
                milestones: '评审里程碑',
                finalConclusion: '最终结论',
                snapshot: '评审快照'
            },
            header: {
                date: '日期',
                overview: '概述',
                status: '状态',
                overallDecision: '总体结论'
            },
            summary: {
                currentStatus: '当前状态',
                reviewedModules: '已审模块',
                currentProgress: '当前进度',
                totalMilestones: '里程碑总数',
                completedMilestones: '已完成里程碑',
                totalFindings: '问题总数',
                findingsBySeverity: '问题严重级别分布',
                latestConclusion: '最新结论',
                recommendedNextAction: '下一步建议',
                overallDecision: '总体结论'
            },
            finding: {
                severity: '严重级别',
                category: '分类',
                trackingStatus: '跟踪状态',
                description: '说明',
                recommendation: '建议',
                relatedMilestones: '相关里程碑',
                evidenceFiles: '证据'
            },
            milestone: {
                status: '状态',
                recordedAt: '记录时间',
                reviewedModules: '已审模块',
                summary: '摘要',
                conclusion: '结论',
                evidenceFiles: '证据',
                recommendedNextAction: '下一步建议',
                findings: '问题'
            },
            values: {
                pending: '待定',
                milestoneStatus: {
                    inProgress: '进行中',
                    completed: '已完成'
                },
                overallDecision: {
                    pending: '待定',
                    accepted: '通过',
                    conditionallyAccepted: '有条件通过',
                    rejected: '不通过',
                    needsFollowUp: '需要后续跟进'
                },
                severity: {
                    high: '高',
                    medium: '中',
                    low: '低'
                },
                category: {
                    html: 'HTML',
                    css: 'CSS',
                    javascript: 'JavaScript',
                    accessibility: '可访问性',
                    performance: '性能',
                    maintainability: '可维护性',
                    docs: '文档',
                    test: '测试',
                    other: '其他'
                },
                trackingStatus: {
                    open: '开放',
                    acceptedRisk: '接受风险',
                    fixed: '已修复',
                    wontFix: '不修复',
                    duplicate: '重复'
                }
            },
            placeholders: {
                noMilestones: '<!-- no milestones -->',
                noFindings: '<!-- no findings -->',
                defaultReviewScope: '_未提供评审范围。_',
                defaultFinalConclusion: '_最终结论待补充。_'
            },
            templates: {
                currentProgressWithLatest: '已记录 {count} 个里程碑；最新：{latestId}',
                currentProgressEmpty: '已记录 0 个里程碑',
                findingsBySeverity: '高 {high} / 中 {medium} / 低 {low}'
            }
        }
    },
    
    notifications: {
        windowsAgentStop: {
            currentWindow: '当前窗口',
            reasonLabels: {
                error: '失败',
                awaitingUserAction: '等待用户操作',
                continueRequired: '等待继续'
            },
            actionLabels: {
                generatePlan: '生成计划',
                executePlan: '执行计划',
                continue: '继续',
                genericConfirmation: '确认'
            }
        }
    },
    
    workspace: {
        noWorkspaceOpen: '无工作区打开',
        singleWorkspace: '工作区: {path}',
        multiRootMode: '多工作区模式:',
        useWorkspaceFormat: '使用 "工作区名称/路径" 格式访问特定工作区的文件'
    },
    
    multimodal: {
        cannotReadFile: '无法读取 {ext} 文件：多模态工具未启用。请在渠道设置中启用"多模态工具"选项。',
        cannotReadBinaryFile: '无法读取二进制文件 {ext}：不支持此文件格式。',
        cannotReadImage: '无法读取 {ext} 图片：当前渠道类型不支持图片读取。',
        cannotReadDocument: '无法读取 {ext} 文档：当前渠道类型不支持文档读取。OpenAI 格式仅支持图片，不支持文档。'
    },
    
    webview: {
        errors: {
            noWorkspaceOpen: '没有打开的工作区',
            workspaceNotFound: '工作区不存在',
            invalidFileUri: '无效的文件 URI',
            pathNotFile: '路径不是文件',
            fileNotExists: '文件不存在',
            fileNotInWorkspace: '文件不在当前工作区内',
            fileNotInAnyWorkspace: '文件不在任何打开的工作区内',
            fileInOtherWorkspace: '文件属于其他工作区: {workspaceName}',
            readFileFailed: '读取文件失败',
            attachmentTooLarge: '文件过大（超过 {maxSizeMB}MB），请改用文件选择或预览方式查看',
            conversationFileNotExists: '对话文件不存在',
            cannotRevealInExplorer: '无法在文件管理器中显示',
            
            deleteMessageFailed: '删除消息失败',
            
            interruptMessageInvalidConversation: '无效的会话 ID',
            interruptMessageEmptyText: '消息内容不能为空',
            interruptMessageConversationNotFound: '会话不存在',
            interruptMessageRateLimited: '消息插入过于频繁，请稍后再试',
            interruptMessageFailed: '插入消息失败',
            
            getModelsFailed: '获取模型列表失败',
            addModelsFailed: '添加模型失败',
            removeModelFailed: '移除模型失败',
            setActiveModelFailed: '设置激活模型失败',
            
            updateUISettingsFailed: '更新 UI 设置失败',
            getSettingsFailed: '获取设置失败',
            updateSettingsFailed: '更新设置失败',
            setActiveChannelFailed: '设置激活渠道失败',
            
            getToolsFailed: '获取工具列表失败',
            setToolEnabledFailed: '设置工具状态失败',
            getToolConfigFailed: '获取工具配置失败',
            updateToolConfigFailed: '更新工具配置失败',
            getAutoExecConfigFailed: '获取自动执行配置失败',
            getMcpToolsFailed: '获取 MCP 工具列表失败',
            setToolAutoExecFailed: '设置工具自动执行失败',
            updateListFilesConfigFailed: '更新 list_files 配置失败',
            updateApplyDiffConfigFailed: '更新 apply_diff 配置失败',
            updateExecuteCommandConfigFailed: '更新终端配置失败',
            checkShellFailed: '检测 Shell 失败',
            
            killTerminalFailed: '终止终端失败',
            getTerminalOutputFailed: '获取终端输出失败',
            
            cancelImageGenFailed: '取消图像生成失败',
            
            cancelTaskFailed: '取消任务失败',
            getTasksFailed: '获取任务列表失败',
            
            getCheckpointConfigFailed: '获取存档点配置失败',
            updateCheckpointConfigFailed: '更新存档点配置失败',
            getCheckpointsFailed: '获取检查点列表失败',
            createCheckpointFailed: '创建存档点失败',
            restoreCheckpointFailed: '恢复检查点失败',
            previewRestoreFailed: '预览恢复失败',
            deleteCheckpointFailed: '删除检查点失败',
            deleteAllCheckpointsFailed: '删除所有检查点失败',
            deleteCheckpointsBatchFailed: '批量删除检查点失败',
            getConversationsWithCheckpointsFailed: '获取对话检查点信息失败',
            previewExclusionsFailed: '预览排除结果失败',
            previewExclusionsNoWorkspace: '当前没有可用的工作区根目录',
            getCheckpointManifestFailed: '获取存档 manifest 失败',
            getCheckpointOperationProgressFailed: '获取存档操作进度失败',
            cancelCheckpointOperationFailed: '取消存档操作失败',
            
            openDiffPreviewFailed: '打开 diff 预览失败',
            diffContentNotFound: 'Diff 内容不存在或已过期',
            loadDiffContentFailed: '加载 diff 内容失败',
            invalidDiffData: '无效的 diff 数据',
            noFileContent: '无文件内容',
            unsupportedToolType: '不支持的工具类型: {toolName}',
            
            getRelativePathFailed: '获取相对路径失败',
            previewAttachmentFailed: '预览附件失败',
            readImageFailed: '读取图片失败',
            openFileFailed: '打开文件失败',
            saveImageFailed: '保存图片失败',
            
            openMcpConfigFailed: '打开 MCP 配置文件失败',
            getMcpServersFailed: '获取 MCP 服务器列表失败',
            validateMcpServerIdFailed: '验证 MCP 服务器 ID 失败',
            createMcpServerFailed: '创建 MCP 服务器失败',
            updateMcpServerFailed: '更新 MCP 服务器失败',
            deleteMcpServerFailed: '删除 MCP 服务器失败',
            connectMcpServerFailed: '连接 MCP 服务器失败',
            disconnectMcpServerFailed: '断开 MCP 服务器失败',
            setMcpServerEnabledFailed: '设置 MCP 服务器状态失败',
            
            getSummarizeConfigFailed: '获取总结配置失败',
            updateSummarizeConfigFailed: '更新总结配置失败',
            summarizeFailed: '上下文总结失败',
            
            getGenerateImageConfigFailed: '获取图像生成配置失败',
            updateGenerateImageConfigFailed: '更新图像生成配置失败',
            
            getContextAwarenessConfigFailed: '获取上下文感知配置失败',
            updateContextAwarenessConfigFailed: '更新上下文感知配置失败',
            getOpenTabsFailed: '获取打开的标签页失败',
            getActiveEditorFailed: '获取当前编辑器失败',
            
            getSystemPromptConfigFailed: '获取系统提示词配置失败',
            updateSystemPromptConfigFailed: '更新系统提示词配置失败',
            
            getPinnedFilesConfigFailed: '获取固定文件配置失败',
            checkPinnedFilesExistenceFailed: '检查文件存在性失败',
            updatePinnedFilesConfigFailed: '更新固定文件配置失败',
            addPinnedFileFailed: '添加固定文件失败',
            removePinnedFileFailed: '移除固定文件失败',
            setPinnedFileEnabledFailed: '设置固定文件状态失败',
            
            listDependenciesFailed: '获取依赖列表失败',
            installDependencyFailed: '安装依赖失败',
            uninstallDependencyFailed: '卸载依赖失败',
            getInstallPathFailed: '获取安装路径失败',
            
            showNotificationFailed: '显示通知失败',
            rejectToolCallsFailed: '标记工具拒绝状态失败',
            
            getStorageConfigFailed: '获取存储配置失败',
            updateStorageConfigFailed: '更新存储配置失败',
            validateStoragePathFailed: '验证存储路径失败',
            migrateStorageFailed: '迁移存储失败'
        },
        
        messages: {
            historyDiffPreview: '{filePath} (历史修改预览)',
            newFileContentPreview: '{filePath} (新写入内容预览)',
            fullFileDiffPreview: '{filePath} (完整文件差异预览)',
            searchReplaceDiffPreview: '{filePath} (搜索替换差异预览)'
        },
        dialogs: {
            selectStorageFolder: '选择存储文件夹',
            selectFolder: '选择文件夹'
        },

        promptSettings: {
            dynamicSection: {
                strategyTitle: '动态上下文策略',
                strategySingle: '单份动态上下文',
                strategyPreserve: '保留旧动态上下文原位',
                strategyDescription: '单份模式保持现有行为；保留模式会把已缓存的旧动态上下文固定插回原回合位置，新回合上下文插入到新消息前。',
                strategyPreserveWarning: '保留模式会增加请求 token；旧动态上下文越多，越容易触发上下文裁剪或总结。',
                strategyVarsPrefix: '当预设条目或传统模板中包含',
                strategyVarsSeparator: '、',
                strategyVarsSuffix: '等会变化变量时，此设置决定旧回合快照是否保留。',
                strategyVarsWarning: '保留旧动态上下文原位 会把旧回合的动态快照固定插回原位，并在当前回合插入当前上下文，适合长上下文和多历史回合。'
            },
            assemblyMode: {
                title: '提示词组装方式',
                description: '每个模式只能选择一种组装方式：传统模板或预设条目。',
                legacyLabel: '传统模板',
                legacyDescription: '使用系统提示词模板和动态上下文模板。',
                entriesLabel: '预设条目',
                entriesDescription: '使用可排序条目，并通过 Chat History 控制真实历史位置。'
            }
        }
    },

    errors: {
        unknown: '未知错误',
        timeout: '操作超时',
        cancelled: '操作已取消',
        networkError: '网络错误',
        invalidRequest: '无效的请求',
        internalError: '内部错误'
    }
};

export default zhCN;
