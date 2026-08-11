/**
 * GrayCode - 简体中文语言包
 * 按组件目录结构组织翻译
 *
 * 注意：本文件是基准语言包，LanguageMessages 类型由此文件自动推导，
 * 因此这里不做类型标注（避免循环定义）。修改结构后 en/ja 会自动受到类型约束。
 */

const zhCN = {
    common: {
        save: '保存',
        cancel: '取消',
        confirm: '确认',
        delete: '删除',
        edit: '编辑',
        add: '添加',
        remove: '移除',
        enable: '启用',
        disable: '禁用',
        enabled: '已启用',
        disabled: '已禁用',
        loading: '加载中...',
        error: '错误',
        success: '成功',
        warning: '警告',
        info: '信息',
        close: '关闭',
        back: '返回',
        next: '下一步',
        done: '完成',
        yes: '是',
        no: '否',
        ok: '确定',
        copy: '复制',
        paste: '粘贴',
        reset: '重置',
        default: '默认',
        custom: '自定义',
        auto: '自动',
        manual: '手动',
        none: '无',
        all: '全部',
        select: '选择',
        search: '搜索',
        filter: '筛选',
        sort: '排序',
        refresh: '刷新',
        retry: '重试',
        settings: '设置',
        help: '帮助',
        about: '关于',
        version: '版本',
        name: '名称',
        description: '描述',
        status: '状态',
        type: '类型',
        size: '大小',
        path: '路径',
        time: '时间',
        date: '日期',
        actions: '操作',
        more: '更多',
        less: '收起',
        expand: '展开',
        collapse: '折叠',
        preview: '预览',
        download: '下载',
        upload: '上传',
        import: '导入',
        export: '导出',
        create: '创建',
        update: '更新',
        apply: '应用',
        install: '安装',
        uninstall: '卸载',
        start: '启动',
        stop: '停止',
        pause: '暂停',
        resume: '继续',
        running: '运行中',
        stopped: '已停止',
        pending: '等待中',
        completed: '已完成',
        failed: '失败',
        unknown: '未知'
    },

    components: {
        announcement: {
            title: '版本更新',
            gotIt: '知道了'
        },
        update: {
            title: '发现新版本',
            intro: 'Gray Code v{version} 已发布，是否下载并安装？',
            releaseNotes: '更新内容',
            install: '下载并安装',
            later: '稍后再说',
            viewPage: '前往 GitHub 查看',
            downloading: '正在下载并安装，请稍候…',
            installed: '安装完成，重新加载窗口后生效。',
            failed: '下载或安装失败'
        },
        attachment: {
            preview: '预览',
            download: '下载',
            close: '关闭',
            downloadFile: '下载文件',
            unsupportedPreview: '此文件类型不支持预览',
            imageFile: '图片文件',
            videoFile: '视频文件',
            audioFile: '音频文件',
            documentFile: '文档文件',
            otherFile: '其他文件'
        },

        common: {
            confirmDialog: {
                title: '确认',
                message: '确定要执行此操作吗？',
                confirm: '确定',
                cancel: '取消'
            },
            inputDialog: {
                title: '请输入',
                confirm: '确定',
                cancel: '取消'
            },
            deleteDialog: {
                title: '删除消息',
                message: '确定要删除这条消息吗？',
                messageWithCount: '确定要删除这条消息吗？这将同时删除后续 {count} 条消息，共 {total} 条消息将被删除。',
                checkpointHint: '检测到此消息前有备份，您可以选择回档到该备份点后再删除，以恢复文件变更。',
                cancel: '取消',
                delete: '删除',
                restoreToUserMessage: '回档到用户消息前',
                restoreToAssistantMessage: '回档到助手消息前',
                restoreToToolBatch: '回档到批量工具执行前',
                restoreToTool: '回档到 {toolName} 执行前',
                restoreToAfterUserMessage: '回档到用户消息后',
                restoreToAfterAssistantMessage: '回档到助手消息后',
                restoreToAfterToolBatch: '回档到批量工具执行后',
                restoreToAfterTool: '回档到 {toolName} 执行后'
            },
            editDialog: {
                title: '编辑消息',
                placeholder: '输入新的消息内容...（可粘贴附件，拖拽文件添加徽章，Ctrl+Shift+拖拽插入 @path 文本，输入 @ 搜索文件）',
                addAttachment: '添加附件',
                checkpointHint: '检测到此消息前有工具执行的备份，您可以选择回档到工具执行前再编辑，以恢复文件变更。',
                cancel: '取消',
                save: '保存',
                saveInPlace: '原地保存（保持当前分支）',
                rootMessageHint: '该消息是会话首条消息：「保存」将更新文本并重新生成后续回复（原回答保留为可切换版本）；「原地保存」仅更新文本，不重新生成。',
                rootSaveHint: '保存并重新生成后续回复',
                restoreToUserMessage: '回档到用户消息前',
                restoreToAssistantMessage: '回档到助手消息前',
                restoreToToolBatch: '回档到批量工具执行前',
                restoreToTool: '回档到 {toolName} 执行前',
                restoreToAfterUserMessage: '回档到用户消息后',
                restoreToAfterAssistantMessage: '回档到助手消息后',
                restoreToAfterToolBatch: '回档到批量工具执行后',
                restoreToAfterTool: '回档到 {toolName} 执行后'
            },
            retryDialog: {
                title: '重试消息',
                message: '重新生成此消息的新版本？当前回答将保留，生成后可在多个版本间切换。',
                checkpointHint: '检测到此消息前有工具执行的备份，您可以选择回档到工具执行前再重试。',
                cancel: '取消',
                retry: '重试',
                restoreToUserMessage: '回档到用户消息前',
                restoreToAssistantMessage: '回档到助手消息前',
                restoreToToolBatch: '回档到批量工具执行前',
                restoreToTool: '回档到 {toolName} 执行前',
                restoreToAfterUserMessage: '回档到用户消息后',
                restoreToAfterAssistantMessage: '回档到助手消息后',
                restoreToAfterToolBatch: '回档到批量工具执行后',
                restoreToAfterTool: '回档到 {toolName} 执行后'
            },
            dependencyWarning: {
                title: '需要安装依赖',
                defaultMessage: '此功能需要安装以下依赖：',
                hint: '请前往',
                linkText: '扩展依赖'
            },
            emptyState: {
                noData: '暂无数据',
                noResults: '无搜索结果'
            },
            tooltip: {
                copied: '已复制',
                copyFailed: '复制失败'
            },
            modal: {
                close: '关闭'
            },
            markdown: {
                copyCode: '复制代码',
                wrapEnable: '自动换行',
                wrapDisable: '不换行',
                copied: '已复制',
                imageLoadFailed: '图片加载失败'
            },
            markdownRenderer: {
                mermaid: {
                    title: 'Mermaid 图表',
                    copyCode: '复制 Mermaid 代码',
                    zoomIn: '放大',
                    zoomOut: '缩小',
                    resetZoom: '重置缩放',
                    tip: '滚轮缩放，左键拖拽',
                    closePreview: '关闭预览'
                }
            },
            scrollToTop: '回到顶部',
            scrollToBottom: '回到底部'
        },

        header: {
            newChat: '新对话',
            history: '历史记录',
            settings: '设置',
            model: '模型',
            channel: '渠道'
        },

        tabs: {
            newChat: '新对话',
            newTab: '新建标签页',
            closeTab: '关闭标签页',
            appTitle: 'GrayCode',
            toggleLanguage: '切换语言',
            settings: '设置',
            monitor: 'SubAgent 监视',
            monitorOpen: '打开 SubAgent 监视面板',
            monitorClose: '关闭 SubAgent 监视面板',
            workspaceSelector: {
                auto: '跟随活动编辑器',
                noWorkspace: '未打开工作区',
                openWorkspaces: '已打开的工作区',
                savedWorkspaces: '已保存的工作区',
                openWorkspaceFolder: '打开工作区文件夹…',
                removeWorkspace: '从收藏中移除',
                openTag: '已打开',
                notOpen: '未打开',
                noSavedWorkspaces: '暂无已保存的工作区'
            }
        },

        usage: {
            title: '用量统计',
            backToChat: '返回聊天',
            refresh: '刷新',
            loading: '正在统计…',
            loadFailed: '统计加载失败',
            retry: '重试',
            empty: '暂无用量数据',
            totalTokens: '总 Token',
            promptTokens: '输入',
            candidatesTokens: '输出',
            thoughtsTokens: '思考',
            cacheCreationTokens: '缓存写入',
            cacheReadTokens: '缓存命中',
            conversations: '对话数',
            modelMessages: '回复数',
            byConversation: '按对话',
            byModel: '按模型',
            byDay: '按日期',
            unknownModel: '未知模型',
            skippedHint: '{count} 个对话读取失败已跳过',
            generatedAt: '统计时间',
            rangeAll: '全部',
            rangeToday: '今天',
            range7d: '近 7 天',
            range30d: '近 30 天',
            estimatedCost: '估算成本',
            editPricing: '设置单价（美元 / 每百万 Token）',
            inputPrice: '输入单价',
            outputPrice: '输出单价',
            save: '保存',
            cancel: '取消',
            openConversation: '点击打开此对话'
        },

        usageTime: {
            title: '使用时间',
            refresh: '刷新',
            loading: '正在统计…',
            loadFailed: '加载失败',
            empty: '暂无使用时间数据（在编辑器中活动即可开始记录）',
            today: '今日已用',
            currentSession: '当前连续工作',
            totalInRange: '范围内合计',
            range7d: '近 7 天',
            range30d: '近 30 天',
            range90d: '近 90 天',
            range1y: '近 1 年',
            rangeAll: '全部',
            hours: '小时',
            minutes: '分钟',
            durationHM: '{hours}小时{minutes}分钟',
            shortHour: 'h',
            shortMinute: 'm',
            dailyTitle: '每日使用时长',
            monthlyTitle: '每月使用时长（点击月份查看每日明细）',
            monthlyTitleShort: '每月使用时长',
            monthActiveDays: '{days} 天活跃',
            onlyShowLatest: '仅显示最近 {days} 天',
            expandMonth: '展开该月每日明细',
            heatmapTitle: '最近 7 天作息热力（悬停查看详情）'
        },

        history: {
            title: '对话历史',
            empty: '暂无对话记录',
            deleteConfirm: '确定要删除这条对话吗？',
            searchPlaceholder: '搜索对话...',
            clearSearch: '清除搜索',
            noSearchResults: '没有匹配的对话',
            today: '今天',
            yesterday: '昨天',
            thisWeek: '本周',
            earlier: '更早',
            noTitle: '无标题',
            currentWorkspace: '当前工作区',
            allWorkspaces: '全部工作区',
            backToChat: '返回对话',
            showHistory: '显示对话历史：',
            revealInExplorer: '在文件管理器中显示',
            deleteConversation: '删除对话',
            renameConversation: '重命名对话',
            renameDialogTitle: '修改对话标题',
            renamePlaceholder: '输入新的对话标题',
            renameConfirm: '保存',
            renameCancel: '取消',
            deleteConversationConfirm: '确定要删除这个对话及其全部消息吗？',
            messages: '条消息'
        },

        home: {
            welcome: '欢迎使用 GrayCode',
            welcomeMessage: 'AI 编程助手，帮助您更高效地编写代码',
            welcomeHint: '在下方输入框中输入消息开始对话',
            quickStart: '快速开始',
            recentChats: '最近对话',
            noRecentChats: '暂无对话历史',
            viewAll: '查看全部'
        },

        input: {
            placeholder: '输入消息...',
            placeholderHint: '输入消息... (Enter 发送，可粘贴附件，Shift+拖拽或@添加路径，Ctrl+Shift+拖拽插入 @path 文本)',
            resizeInput: '调整输入框高度；方向键调整，Home 或双击恢复自动高度',
            send: '发送消息',
            sendPreserveDynamicContext: '发送并保留旧动态上下文原位',
            stopGenerating: '停止生成',
            sendWhileBusy: '发送新消息（正在运行的命令将转入后台，AI 优先响应）',
            interruptDelivered: '已插入到当前回合，AI 将尽快处理',
            attachFile: '添加附件',
            pinnedFiles: '固定文件',
            skills: 'Skills',
            summarizeContext: '总结上下文',
            createCheckpoint: '创建存档点（保存当前工作区状态，回档后可恢复）',
            tpsTooltip: 'TPS（tokens per second）',
            tpsTokenizerReal: '模型 tokenizer 精确计数',
            tpsTokenizerEstimate: 'tokenizer 未就绪，按字符估算',
            selectChannel: '选择渠道',
            selectModel: '选择模型',
            clickToPreview: '点击预览',
            remove: '移除',
            tokenUsage: '使用量',
            context: '上下文',
            fileNotExists: '文件不存在',
            queue: {
                title: '排队消息',
                sendNow: '立即发送',
                remove: '移除',
                queued: '已加入队列',
                drag: '拖拽排序',
                edit: '编辑'
            },
            mode: {
                selectMode: '选择模式',
                manageMode: '管理模式',
                search: '搜索模式...',
                noResults: '没有匹配的模式'
            },
            channelSelector: {
                placeholder: '选择配置',
                searchPlaceholder: '搜索渠道...',
                noMatch: '没有匹配的渠道'
            },
            modelSelector: {
                placeholder: '选择模型',
                searchPlaceholder: '搜索模型...',
                noMatch: '没有匹配的模型',
                addInSettings: '请在设置中添加模型'
            },
            pinnedFilesPanel: {
                title: '固定文件',
                description: '固定的文件内容会在每次对话时发送给 AI',
                loading: '加载中...',
                empty: '暂无固定文件',
                notExists: '不存在',
                dragHint: '按住 Shift 拖拽工作区内的文本文件到此处添加',
                dropHint: '释放鼠标添加文件'
            },
            skillsPanel: {
                title: 'Skills',
                description: 'Skills 是用户自定义的知识模块。勾选后 AI 可在工具描述中看到该 Skill，需要时通过 read_skill 工具按需加载内容。',
                loading: '加载中...',
                empty: '暂无可用的 Skills。点击右上角文件夹图标打开目录，创建一个文件夹并包含 SKILL.md 文件即可添加。',
                notExists: '不存在',
                enableTooltip: '在当前对话中启用此 Skill',
                hint: 'AI 在判断任务匹配可用 Skill 时，会通过 read_skill 工具按需加载内容',
                openDirectory: '打开 Skills 存储目录',
                refresh: '刷新 Skills 列表'
            },
            promptContext: {
                title: '提示词上下文',
                description: '这些内容会以 XML 格式附加到您的消息前面，为 AI 提供额外上下文',
                empty: '暂无上下文内容',
                emptyHint: '拖拽文件到此处，或点击 + 添加自定义文本',
                addText: '添加自定义文本',
                addFile: '添加文件内容',
                titlePlaceholder: '输入标题...',
                contentPlaceholder: '输入内容...',
                typeFile: '文件',
                typeText: '文本',
                typeSnippet: '代码片段',
                hint: '内容将以 <context> 标签包裹发送给 AI',
                dropHint: '释放鼠标添加文件内容',
                fileAdded: '已添加文件内容: {path}',
                readFailed: '读取文件失败',
                addFailed: '添加失败: {error}'
            },
            filePicker: {
                title: '选择文件',
                subtitle: '在 @ 后输入文字筛选路径',
                loading: '搜索中...',
                empty: '未找到匹配的文件',
                navigate: '导航',
                select: '选择',
                close: '关闭',
                ctrlClickHint: '插入为 @path 文本'
            },
            notifications: {
                summarizeFailed: '总结失败: {error}',
                summarizeSuccess: '已成功总结 {count} 条消息',
                summarizeError: '总结失败: {error}',
                checkpointCreated: '已创建存档点，可随时回档恢复当前状态',
                checkpointCreateFailed: '创建存档点失败，请稍后重试',
                checkpointCreateError: '创建存档点失败: {error}',
                holdShiftToDrag: '请按住 Shift 键拖拽文件',
                fileNotInWorkspace: '文件不在工作区内',
                fileNotInAnyWorkspace: '文件不在任何打开的工作区内',
                fileInOtherWorkspace: '文件属于其他工作区: {workspaceName}',
                fileAdded: '已添加固定文件: {path}',
                addFailed: '添加失败: {error}',
                cannotGetFilePath: '无法获取文件路径，请从 VSCode 资源管理器或标签页拖拽',
                fileNotMatchOrNotInWorkspace: '文件不在工作区内或文件名不匹配',
                removeFailed: '移除失败: {error}'
            }
        },

        message: {
            roles: {
                user: '用户',
                tool: '工具',
                assistant: '助手'
            },
            actions: {
                edit: '编辑消息',
                copy: '复制',
                retry: '重新生成',
                viewResponse: '查看回复',
                branchFromHere: '从这里创建分支',
                delete: '删除消息'
            },
            branch: {
                previous: '上一个候选',
                next: '下一个候选',
                candidateList: '候选列表',
                switchTo: '切换到该候选',
                delete: '删除候选',
                deleteConfirm: '再次点击确认删除',
                active: '当前',
                noPreview: '（无预览）',
                workspaceConfirmTitle: '切换候选分支',
                workspaceConfirmMessage: '该分支执行过写工具或绑定了工作区存档。是否连工作区一起恢复？',
                workspaceConfirmChatOnly: '仅切换聊天',
                workspaceConfirmChatAndWorkspace: '切换并恢复工作区',
                workspaceConfirmCancel: '取消'
            },
            branchTree: {
                open: '查看分支历史',
                close: '关闭',
                title: '分支历史',
                empty: '暂无分支',
                nodeCount: '{count} 个节点',
                navigationMode: '分支导航',
                fullMode: '完整消息图',
                navigationHint: '折叠连续消息，只显示分支点与候选',
                fullHint: '轨道式完整消息图：轨道数随同时存在的候选分支变化',
                collapsedMessages: '已折叠 {count} 条连续消息',
                candidateCount: '{count} 个候选',
                deleted: '已删除',
                system: '系统',
                restore: '恢复',
                rename: '重命名',
                renamePlaceholder: '输入分支标签…',
                save: '保存',
                cancel: '取消',
                expandAllMessages: '展开完整消息',
                collapseLinearMessages: '收起线性段'
            },
            responseViewer: {
                commonMode: '常用模式',
                advancedMode: '高级模式',
                body: '回复正文',
                thought: '思考内容',
                toolCalls: '工具调用',
                responseInfo: '回复信息',
                basicInfo: '基本信息',
                parts: '内容片段',
                metadata: '元信息',
                attachments: '附件摘要',
                rawJson: '原始 JSON',
                openRawJson: '查看原始 JSON',
                rawJsonHint: '此处只保留与回复相关的结构化数据。',
                empty: '无可显示内容',
                noThought: '无思考内容',
                noTools: '无工具调用',
                noParts: '无内容片段',
                noMetadata: '无元信息',
                noAttachments: '无附件',
                id: 'ID',
                role: '角色',
                timestamp: '时间',
                backendIndex: '后端索引',
                modelVersion: '模型版本',
                totalTokens: '总 Token',
                promptTokens: '输入 Token',
                outputTokens: '输出 Token',
                thoughtTokens: '思考 Token',
                thinkingDuration: '思考耗时',
                responseDuration: '响应耗时',
                streamDuration: '流式耗时',
                chunkCount: '块数',
                tokenRate: 'Token 速率',
                flags: '标记',
                functionResponseMessage: '函数响应消息',
                summaryMessage: '总结消息',
                model: '模型',
                legacyTotalTokens: '旧版总 Token',
                latency: '延迟',
                firstChunkTime: '首块时间',
                promptTokenDetails: '输入 Token 详情',
                outputTokenDetails: '输出 Token 详情',
                yes: '是',
                no: '否',
                name: '名称',
                mimeType: 'MIME 类型',
                size: '大小',
                fileUri: '文件 URI',
                status: '状态',
                duration: '耗时',
                moreMetadata: '更多元信息',
                attachmentType: '附件类型',
                hasData: '含原始数据',
                copyBody: '复制正文',
                copySuccess: '正文已复制',
                copyFailed: '复制正文失败',
                pairedFunctionResponse: '配对的函数响应',
                responseSource: '结果来源',
                sourceMessage: '来源消息',
                responseSources: {
                    tool: '工具结果字段',
                    partFunctionResponse: '当前消息中的函数响应',
                    hiddenFunctionResponse: '隐藏的函数响应消息'
                },

                hasThumbnail: '含缩略图',
                partTypes: {
                    text: '文本',
                    thought: '思考',
                    functionCall: '函数调用',
                    functionResponse: '函数响应',
                    inlineData: '内联数据',
                    fileData: '文件数据',
                    unknown: '未知'
                },
                toolStatuses: {
                    streaming: '生成中',
                    queued: '排队中',
                    awaitingApproval: '等待确认',
                    executing: '执行中',
                    awaitingApply: '等待应用',
                    success: '成功',
                    error: '失败',
                    warning: '警告',
                    unknown: '未知'
                }
            },
            emptyResponse: '（模型返回空内容）',
            historyFolded: '更早消息已折叠（已丢弃 {count} 条），继续上拉可加载',
            stats: {
                ttft: '首字延迟 (TTFT)',
                responseDuration: '响应时间',
                tokenRate: 'Token 速率'
            },
            thought: {
                thinking: '正在思考...',
                thoughtProcess: '思考过程',
                viewCollapsed: '折叠',
                viewMedium: '中展开（滚动查看）',
                viewExpanded: '完全展开',
                trimmedHint: '内容过长，仅显示最近部分，请使用完全展开查看'
            },
            contextBlocks: {
                clickToView: '点击查看完整内容'
            },
            summary: {
                title: '上下文总结',
                compressed: '已压缩 {count} 条消息',
                deleteTitle: '删除总结',
                restoreTitle: '恢复原文（撤销总结，重新发送被压缩的消息）',
                autoTriggered: '自动触发',
                compressionTokens: '被替换历史 → 新摘要（估算节省 {saved} Token；下一次回复后以真实上下文为准）',
                legacyRequestTokens: '旧记录：总结模型请求输入 → 输出，不代表主上下文前后大小',
                historyTokenLabel: '历史',
                requestTokenLabel: '请求',
                dividerMarker: '上下文总结截断点：此线以上为已总结的历史（原文仍可查看），以下为发送给 AI 的活跃内容',
                dividerMarkerPrefix: '总结截断',
                marker: '上下文总结 · 已压缩 {count} 条消息',
                markerPrefix: '上下文总结'
            },
            checkpoint: {
                userMessageBefore: '用户消息前存档',
                userMessageAfter: '用户消息后存档',
                assistantMessageBefore: '助手消息前存档',
                assistantMessageAfter: '助手消息后存档',
                toolBatchBefore: '批量工具执行前存档',
                toolBatchAfter: '批量工具执行后存档',
                userMessageUnchanged: '用户消息存档 · 内容未变化',
                assistantMessageUnchanged: '助手消息存档 · 内容未变化',
                toolBatchUnchanged: '批量工具执行完成 · 内容未变化',
                toolExecutionUnchanged: '工具执行完成 · 内容未变化',
                restoreTooltip: '恢复工作区到此存档点',
                fileCount: '{count} 个文件',
                yesterday: '昨天',
                daysAgo: '{days}天前',
                restoreConfirmTitle: '恢复存档',
                restoreConfirmMessage: '确定要将工作区恢复到此存档点吗？这将覆盖当前工作区中的相应文件，此操作不可恢复。',
                restoreConfirmBtn: '恢复',
                restoreConfirmRetryTitle: '回档并重试',
                restoreConfirmDeleteTitle: '回档并删除',
                restoreConfirmEditTitle: '回档并编辑',
                restorePreviewFailed: '无法预览恢复，请稍后重试',
                restorePreviewFilesUpdated: '将更新 {count} 个文件',
                restorePreviewFilesDeleted: '将删除 {count} 个文件',
                restorePreviewFilesUnchanged: '{count} 个文件保持不变',
                restorePreviewNoChanges: '工作区与存档状态一致，没有文件变更',
                restorePreviewLegacy: '旧版存档（无文件清单），恢复将以备份内容为准，可能覆盖工作区文件；不会删除任何文件',
                restoreDeleteListTitle: '将删除以下 {count} 个文件：',
                restoreDeleteListMore: '……等 {count} 个文件',
                restoreDeleteListEmpty: '本次恢复不会删除任何文件',
                restoreDeleteUntrackedNote: '包含存档创建后新建的文件（确认后一并删除）',
                restoreUnbackedTip: '以下文件在创建存档时未备份（大小超限或不可读），本次恢复不会处理：{paths}',
                restoreResultErrorTitle: '恢复失败',
                restoreResultPartialTitle: '恢复部分完成',
                restoreResultWarningTitle: '未备份文件提示',
                restoreResultSuccessTitle: '恢复完成',
                restoreResultFailed: '恢复检查点失败',
                restoreResultPartial: '恢复部分完成，以下文件失败：{files}',
                restoreResultPartialMore: '恢复部分完成，以下文件失败：{files} 等 {count} 个文件',
                restoreResultUnbacked: '以下文件在创建存档时未被备份（大小超限或不可读），本次恢复未处理它们：{paths}',
                restoreResultUnbackedMore: '以下文件在创建存档时未被备份（大小超限或不可读），本次恢复未处理它们：{paths} 等 {count} 个文件',
                restoreResultSuccess: '工作区已恢复到存档点（{count} 个文件）',
                restoreResultSuccessWithPrune: '工作区已恢复到存档点（{count} 个文件），并自动清理了 {pruned} 个旧存档',
                restoreConversationChanged: '对话已切换，恢复操作已取消',
                dirtyConfirmTitle: '存在未保存的更改',
                dirtyConfirmMessage: '恢复将丢弃 {count} 个未保存文件的更改，确定继续吗？',
                dirtyConfirmDiscard: '丢弃更改并继续',
                dirtyConfirmCancel: '取消',
                dirtyConfirmMore: '……等 {count} 个文件'
            },
            continue: {
                title: '对话等待中',
                description: '工具执行完成。您可以发送新消息，或点击"继续"让 AI 继续响应',
                button: '继续'
            },
            error: {
                title: '请求失败',
                retry: '重试',
                dismiss: '关闭'
            },
            interrupt: {
                delivered: '已投递「{text}」，将在当前回合结束后处理',
                deliverFailed: '消息未能投递：{detail}'
            },
            tool: {
                parameters: '参数',
                result: '结果',
                error: '错误',
                paramCount: '{count} 个参数',
                streamingArgs: '正在生成参数...',
                confirmExecution: '点击确认执行',
                confirm: '确认执行',
                saveAll: '全部保存',
                rejectAll: '全部拒绝',
                reject: '拒绝',
                confirmed: '已确认',
                rejected: '已拒绝',
                viewDiff: '查看差异',
                viewDiffInVSCode: '在 VSCode 中查看差异',
                openDiffFailed: '打开 diff 预览失败',
                pendingDiffNotFound: '未找到待处理的差异，请等待状态同步后重试。',
                acceptDiffFailed: '接受差异失败，请重试。',
                rejectDiffFailed: '拒绝差异失败，请重试。',
                openDetails: '打开详情',
                openSubAgentMonitorDetails: '打开 SubAgent Monitor 详情',
                todoWrite: {
                    label: 'TODO',
                    labelWithCount: 'TODO · {count}',
                    mergePrefix: '合并 · ',
                    description: '待做 {pending} · 进行中 {inProgress} · 完成 {completed}'
                },
                todoUpdate: {
                    label: 'TODO 更新',
                    labelWithCount: 'TODO 更新 · {count}',
                    description: '新增 {add} · 状态 {setStatus} · 描述 {setContent} · 取消 {cancel} · 移除 {remove}'
                },
                createPlan: {
                    label: '创建计划',
                    fallbackTitle: '计划'
                },
                updatePlan: {
                    label: '更新计划',
                    fallbackTitle: '计划'
                },
                createDesign: {
                    label: '创建设计',
                    fallbackTitle: '设计'
                },
                updateDesign: {
                    label: '更新设计',
                    fallbackTitle: '设计'
                },
                createProgress: {
                    label: '创建进度',
                    fallbackTitle: '项目进度'
                },
                updateProgress: {
                    label: '更新进度',
                    fallbackTitle: '项目进度'
                },
                validateProgressDocument: {
                    label: '校验进度文档',
                    fallbackTitle: '进度校验'
                },
                recordProgressMilestone: {
                    label: '记录进度里程碑',
                    fallbackTitle: '进度里程碑'
                },
                createReview: {
                    label: '创建审查文档',
                    fallbackTitle: '审查'
                },
                validateReviewDocument: {
                    label: '校验审查文档',
                    fallbackTitle: '审查校验'
                },
                finalizeReview: {
                    label: '完成审查',
                    fallbackTitle: '审查结论'
                },
                recordReviewMilestone: {
                    label: '记录审查里程碑',
                    fallbackTitle: '审查里程碑'
                },
                reopenReview: {
                    label: '重新打开审查',
                    fallbackTitle: '重新打开审查'
                },
                compareReviewDocuments: {
                    label: '比较审查文档',
                    fallbackTitle: '审查对比',
                    base: '基线文档',
                    target: '目标文档',
                    addedFindings: '新增问题',
                    removedFindings: '移除问题',
                    persistedFindings: '持续问题',
                    severityChanged: '严重级别变化',
                    trackingChanged: '跟踪状态变化'
                },
                todoPanel: {
                    title: 'TODO 列表',
                    modePlan: '计划',
                    modeUpdate: '更新',
                    modeMerge: '合并',
                    sourceCurrentInput: '本次工具输入',
                    sourceSnapshot: '当时快照',
                    statusPending: '待做',
                    statusInProgress: '进行中',
                    statusCompleted: '完成',
                    statusCancelled: '取消',
                    totalItems: '共 {count} 项',
                    copyAsMarkdown: '复制为 Markdown',
                    copyMarkdown: '复制 Markdown',
                    copied: '已复制',
                    empty: '暂无 TODO',
                    markdownCancelledSuffix: '（已取消）',
                    markdownInProgressSuffix: '（进行中）',
                    copyFailed: '复制失败'
                },
                planCard: {
                    title: '计划',
                    executeLabel: '执行：',
                    executed: '已执行',
                    executing: '执行中...',
                    executePlan: '执行计划',
                    openFile: '打开文件',
                    loadChannelsFailed: '加载渠道失败',
                    loadModelsFailed: '加载模型失败',
                    executePlanFailed: '执行计划失败',
                    openFileFailed: '打开文件失败',
                    promptPrefix: '请按照以下计划执行：\n\n{plan}',
                    sourceUpToDate: '来源：最新',
                    sourceUntracked: '来源：未追踪',
                    sourceMismatched: '来源：已变化',
                    sourceMissing: '来源：文件缺失',
                    sourceBlockedMismatched: '来源文档已变化，请先重新生成或修订计划',
                    sourceBlockedMissing: '来源文档不存在或无法读取，请先修订计划'
                },
                designCard: {
                    title: '设计',
                    generateLabel: '生成计划：',
                    generated: '已生成计划',
                    generating: '生成计划中...',
                    generatePlan: '生成计划',
                    openFile: '打开文件',
                    loadChannelsFailed: '加载渠道失败',
                    loadModelsFailed: '加载模型失败',
                    generatePlanFailed: '生成计划失败',
                    openFileFailed: '打开文件失败'
                },
                reviewCard: {
                    sourceCreate: '创建',
                    sourceMilestone: '里程碑',
                    sourceFinalize: '完成',
                    sourceReopen: '重新打开',
                    sourceValidate: '校验',
                    sourceCompare: '比较',
                    statusCompleted: '已完成',
                    statusInProgress: '进行中',
                    decisionAccepted: '通过',
                    decisionConditionallyAccepted: '有条件通过',
                    decisionRejected: '不通过',
                    decisionNeedsFollowUp: '需继续跟进',
                    validationAutoUpgrade: '可升级旧文档',
                    validationInvalid: '无效',
                    validationWarning: '有警告',
                    validationValid: '正常',
                    issueError: '错误',
                    issueWarning: '警告',
                    severityHigh: '高',
                    severityMedium: '中',
                    severityLow: '低',
                    milestonesChip: '{completed}/{total} 里程碑',
                    findingsChip: '问题 {total} · 高{high} 中{medium} 低{low}',
                    modulesChip: '模块 {count}',
                    formatChip: '格式 {format}',
                    status: '状态',
                    decision: '结论',
                    milestones: '里程碑',
                    findings: '问题',
                    format: '格式',
                    latestConclusion: '最新结论',
                    recommendedNextAction: '下一步建议',
                    tracking: '跟踪状态',
                    trackingOpen: '开放',
                    trackingAcceptedRisk: '接受风险',
                    trackingFixed: '已修复',
                    trackingWontFix: '不修复',
                    trackingDuplicate: '重复',
                    categoryHtml: 'HTML',
                    categoryCss: 'CSS',
                    categoryJavascript: 'JavaScript',
                    categoryAccessibility: '可访问性',
                    categoryPerformance: '性能',
                    categoryMaintainability: '可维护性',
                    categoryDocs: '文档',
                    categoryTest: '测试',
                    categoryOther: '其他',
                    evidence: '证据',
                    findingDetails: '问题详情',
                    compareBase: '基线文档',
                    compareTarget: '目标文档',
                    compareAdded: '新增问题',
                    compareRemoved: '移除问题',
                    comparePersisted: '持续问题',
                    compareSeverityChanged: '严重级别变化',
                    compareTrackingChanged: '跟踪状态变化',
                    compareEvidenceChanged: '证据变化',
                    compareRelatedMilestonesChanged: '相关里程碑变化',
                    compareChanges: '变化项',
                    changeSeverity: '严重级别',
                    changeTrackingStatus: '跟踪状态',
                    changeTitle: '标题',
                    changeDescription: '说明',
                    changeRecommendation: '建议',
                    changeEvidence: '证据',
                    changeRelatedMilestoneIds: '相关里程碑',
                    validation: '校验信息',
                    progress: '进度',
                    modules: '已审模块',
                    noIssues: '没有问题',
                    issueSummary: '{count} 个问题 · 错误 {errors} · 警告 {warnings}',
                    openFile: '打开文档',
                    openFileFailed: '打开审查文档失败',
                    copyFailed: '复制路径失败',
                    copyPath: '复制路径',
                    copied: '已复制',
                    rawResult: '完整结果',
                    generatePlan: '生成计划',
                    generatingPlan: '生成计划中...',
                    planGenerated: '已生成计划',
                    generatePlanFailed: '生成计划失败'
                },
                progressCard: {
                    sourceCreate: '创建',
                    sourceUpdate: '更新',
                    sourceMilestone: '里程碑',
                    sourceValidate: '校验',
                    defaultTitle: '项目进度',
                    validation: '校验信息',
                    validationInvalid: '无效',
                    validationWarning: '有警告',
                    validationValid: '正常',
                    issueError: '错误',
                    issueWarning: '警告',
                    issueSummary: '{count} 个问题 · 错误 {errors} · 警告 {warnings}',
                    status: '状态',
                    phase: '阶段',
                    statusActive: '进行中',
                    statusBlocked: '阻塞',
                    statusCompleted: '已完成',
                    statusArchived: '已归档',
                    phaseDesign: '设计',
                    phasePlan: '计划',
                    phaseImplementation: '实现',
                    phaseReview: '审查',
                    phaseMaintenance: '维护',
                    milestoneStatusCompleted: '已完成',
                    milestoneStatusInProgress: '进行中',
                    currentFocus: '当前焦点',
                    currentProgress: '当前进度',
                    latestConclusion: '最新结论',
                    currentBlocker: '当前阻塞',
                    nextAction: '下一步',
                    updatedAt: '更新时间',
                    milestones: '里程碑',
                    todos: 'TODO',
                    activeRisks: '活跃风险',
                    activeArtifacts: '关联文档',
                    activeDesign: '设计',
                    activePlan: '计划',
                    activeReview: '审查',
                    latestMilestone: '最新里程碑',
                    openFile: '打开文档',
                    openFileFailed: '打开进度文档失败',
                    copyFailed: '复制路径失败',
                    copyPath: '复制路径',
                    copied: '已复制',
                    rawResult: '完整结果'
                }
            },
            attachment: {
                clickToPreview: '点击预览',
                removeAttachment: '移除附件'
            }
        },

        settings: {
            title: '设置',
            tabs: {
                channel: '渠道',
                tools: '工具',
                autoExec: '自动执行',
                mcp: 'MCP',
                subagents: '子代理',
                checkpoint: '存档点',
                summarize: '总结',
                imageGen: '图像生成',
                dependencies: '扩展依赖',
                context: '上下文',
                prompt: '提示词',
                tokenCount: 'Token 计数',
                sound: '通知系统',
                appearance: '外观',
                memory: '记忆',
                sandbox: '沙箱',
                remoteControl: '远程控制',
                general: '通用',
                usage: '用量统计'
            },
            channelSettings: {
                selector: {
                    placeholder: '选择配置',
                    rename: '重命名',
                    add: '新建配置',
                    delete: '删除配置',
                    inputPlaceholder: '输入配置名称',
                    confirm: '确认',
                    cancel: '取消'
                },
                empty: {
                    title: '尚未配置任何渠道',
                    hint: '首次使用需要先新建一个渠道并填写 API Key，之后即可开始对话。',
                    create: '新建渠道'
                },
                dialog: {
                    new: {
                        title: '新建配置',
                        nameLabel: '配置名称',
                        namePlaceholder: '例如：我的 Gemini',
                        nameRequired: '请输入配置名称',
                        typeLabel: '接口类型',
                        typePlaceholder: '选择接口类型',
                        cancel: '取消',
                        create: '创建'
                    },
                    delete: {
                        title: '删除配置',
                        message: '确定要删除配置 "{name}" 吗？此操作不可恢复。',
                        cancel: '取消',
                        confirm: '确定'
                    },
                    changeType: {
                        title: '更改渠道类型',
                        message: '确定要将渠道类型更改为「{name}」吗？该类型特有的参数（模型列表、高级选项等）将重置为该类型默认值；API Key 与自定义 API URL 保留，通用设置保持不变。'
                    }
                },
                form: {
                    apiUrl: {
                        label: 'API URL',
                        placeholder: '输入 API URL',
                        placeholderResponses: '输入 API 基础地址，如 https://api.openai.com/v1'
                    },
                    apiKey: {
                        label: 'API Key',
                        placeholder: '输入 API Key',
                        show: '显示',
                        hide: '隐藏',
                        useAuthorization: '使用 Authorization 格式发送',
                        useAuthorizationHintGemini: '将 x-goog-api-key 转为 Authorization: Bearer 格式发送',
                        useAuthorizationHintAnthropic: '将 x-api-key 转为 Authorization: Bearer 格式发送'
                    },
                    stream: {
                        label: '流式输出'
                    },
                    channelType: {
                        label: '渠道类型',
                        gemini: 'Gemini API',
                        openai: 'OpenAI API',
                        'openai-responses': 'OpenAI Responses API',
                        anthropic: 'Anthropic API',
                        changeHint: '更改渠道类型会将该类型特有的参数（模型列表、高级选项等）重置为默认值；API Key 与自定义 API URL 保留，通用设置保持不变。'
                    },
                    toolMode: {
                        label: '工具调用格式',
                        placeholder: '选择工具调用格式',
                        functionCall: {
                            label: 'Function Calling',
                            description: '使用原生函数调用'
                        },
                        xml: {
                            label: 'XML 提示词',
                            description: '使用 XML 格式提示词'
                        },
                        json: {
                            label: 'JSON 边界标记',
                            description: '使用 JSON 格式 + 边界标记'
                        },
                        hint: {
                            functionCall: 'Function Calling: 使用 API 原生函数调用功能',
                            xml: 'XML 提示词: 将工具转换为 XML 格式插入系统提示词',
                            json: 'JSON 边界标记: 使用 JSON 格式 + <<<TOOL_CALL>>> 边界标记'
                        },
                        openaiWarning: 'OpenAI Function Call 模式不支持多模态工具（如 read_file 读取图片、generate_image 生成图片、remove_background 抠图、crop_image 裁切图片、resize_image 缩放图片、rotate_image 旋转图片）。如需使用多模态功能，请切换到 XML 或 JSON 模式。'
                    },
                    multimodal: {
                        label: '启用多模态工具',
                        supportedTypes: '支持的文件类型：',
                        image: '图片',
                        imageFormats: 'PNG、JPEG、WebP',
                        document: '文档',
                        documentFormats: 'PDF',
                        capabilities: '多模态工具能力：',
                        table: {
                            channel: '渠道 / 模式',
                            readImage: '读取图片',
                            readDocument: '读取文档',
                            generateImage: '生成图片',
                            historyMultimodal: '历史多模态'
                        },
                        channels: {
                            geminiAll: 'Gemini（全部）',
                            anthropicAll: 'Anthropic（全部）',
                            openaiXmlJson: 'OpenAI（XML/JSON）',
                            openaiResponses: 'OpenAI（Responses）',
                            openaiFunction: 'OpenAI（Function Call）'
                        },
                        legend: {
                            supported: '支持',
                            notSupported: '不支持'
                        },
                        notes: {
                            requireEnable: '需要启用此选项才能使用 read_file 读取图片/文档、generate_image 生成图片、remove_background 抠图、crop_image 裁切图片、resize_image 缩放图片、rotate_image 旋转图片等多模态工具',
                            userAttachment: '用户主动发送的附件不受此配置影响，始终按渠道原生能力处理',
                            geminiAnthropic: 'Gemini / Anthropic：工具可直接返回图片和文档，支持生成图片功能',
                            openaiResponses: 'OpenAI Responses：原生支持图片、PDF 读取，支持推理过程实时显示',
                            openaiXmlJson: 'OpenAI XML/JSON：支持读取图片和生成图片，不支持文档'
                        }
                    },
                    strictTools: {
                        label: '启用 Strict Tool Use',
                        hint: '启用后，API 端将强制模型输出严格符合参数 schema，消除类型错误和缺失字段。需要 Anthropic 或 OpenAI 渠道支持，反代/代理网关可能不兼容。Gemini 不支持此功能。',
                        support: {
                            anthropic: 'Anthropic：自动注入 beta header，最多 20 个 strict 工具',
                            openai: 'OpenAI：要求参数全部 required + additionalProperties: false',
                            openaiResponses: 'OpenAI Responses：默认已启用 strict',
                            gemini: 'Gemini：不支持'
                        }
                    },
                    timeout: {
                        label: '超时时间 (ms)',
                        placeholder: '30000'
                    },
                    maxContextTokens: {
                        label: '最大上下文 Tokens',
                        placeholder: '128000',
                        hint: '用于显示上下文使用量的上限值'
                    },
                    contextManagement: {
                        title: '上下文管理',
                        enableTitle: '启用上下文管理',
                        threshold: {
                            label: '上下文阈值',
                            placeholder: '80% 或 100000',
                            hint: '当总 token 数超过阈值时，优先由模型总结旧内容，并原文保留历史用户输入；总结失败时仅对本次请求执行工具调用配对安全的细粒度裁剪'
                        },
                        extraCut: {
                            label: '额外裁剪量',
                            placeholder: '0 或 10%',
                            hint: '裁剪时额外裁剪的 token 数量。实际保留 = 阈值 - 额外裁剪量。支持百分比或绝对数值，默认为 0'
                        },
                        autoSummarize: {
                            label: '自动总结',
                            enableTitle: '启用自动总结',
                            hint: '启用后，当上下文超过阈值时自动总结旧回合（与上下文裁剪互斥）'
                        },
                        mode: {
                            label: '管理方式',
                            hint: '模型总结优先；长工具回合可在安全消息边界内切分。总结失败时使用不持久化的细粒度裁剪，不直接丢弃整轮用户对话',
                            trim: '旧版上下文裁剪',
                            summarize: '智能总结与安全裁剪'
                        }
                    },
                    toolOptions: {
                        title: '工具配置'
                    },
                    advancedOptions: {
                        title: '高级选项'
                    },
                    customBody: {
                        title: '自定义 Body',
                        enableTitle: '启用自定义 Body'
                    },
                    customHeaders: {
                        title: '自定义标头',
                        enableTitle: '启用自定义标头'
                    },
                    autoRetry: {
                        title: '自动重试',
                        enableTitle: '启用自动重试',
                        retryCount: {
                            label: '重试次数',
                            hint: 'API 返回错误时的最大重试次数（1-10）'
                        },
                        retryInterval: {
                            label: '重试间隔 (ms)',
                            hint: '每次重试之间的等待时间（1000-60000 毫秒）'
                        }
                    },
                    enabled: {
                        label: '启用此配置'
                    }
                }
            },
            tools: {
                title: '工具设置',
                description: '管理和配置可用工具',
                enableAll: '全部启用',
                disableAll: '全部禁用',
                toolName: '工具名称',
                toolDescription: '工具描述',
                toolEnabled: '启用状态'
            },
            autoExec: {
                title: '自动执行',
                intro: {
                    title: '工具执行确认',
                    description: '配置 AI 调用工具时是否需要用户确认。勾选表示自动执行（无需确认），不勾选表示执行前需要用户确认。'
                },
                actions: {
                    refresh: '刷新',
                    enableAll: '全部自动执行',
                    disableAll: '全部需确认'
                },
                status: {
                    loading: '加载工具列表...',
                    empty: '暂无可用工具',
                    autoExecute: '自动执行',
                    needConfirm: '需确认'
                },
                categories: {
                    file: '文件操作',
                    search: '搜索',
                    terminal: '终端',
                    lsp: '代码智能',
                    media: '媒体处理',
                    plan: '计划',
                    mcp: 'MCP 工具',
                    todo: 'TODO',
                    history: '历史',
                    memory: '记忆',
                    review: '审查',
                    progress: '进度',
                    skills: '技能',
                    design: '设计',
                    notification: '通知',
                    agents: '代理',
                    activity: '使用时间',
                    sandbox: '沙箱',
                    other: '其他'
                },
                badges: {
                    dangerous: '危险'
                },
                diffReview: {
                    label: '差异审阅管理',
                    tooltip: '此工具的修改经由差异审阅机制确认，不使用聊天内确认框。是否自动应用请在「工具设置 → 应用diff → 自动应用修改」中配置。',
                    autoApprove: '自动批准',
                    autoApproveTooltip: '开启后，该工具的差异修改将按「应用diff 设置」中的延迟自动批准应用（write_file / apply_diff / insert_code / delete_code 共用同一开关）。',
                    statusAutoApprove: '自动批准',
                    statusNeedConfirm: '需确认'
                },
                tips: {
                    diffReviewNote: '• 写入类工具（write_file / apply_diff / insert_code / delete_code）由差异审阅机制确认：在上方开启「自动批准」或到「工具设置 → 应用diff → 自动应用修改」配置后即完全自动',
                    dangerousDefault: '• 标记为"危险"的工具默认需要用户确认后才能执行',
                    deleteFileWarning: '• delete_file: 删除文件操作不可恢复，建议保持需确认',
                    executeCommandWarning: '• execute_command: 执行终端命令可能对系统造成影响',
                    mcpToolsDefault: '• MCP 工具：来自已连接的 MCP 服务器，默认自动执行',
                    useWithCheckpoint: '• 建议配合存档点功能使用，以便在误操作时恢复'
                }
            },
            mcp: {
                title: 'MCP 设置',
                description: '配置 Model Context Protocol 服务器',
                addServer: '添加服务器',
                serverName: '服务器名称',
                serverCommand: '启动命令',
                serverArgs: '命令参数',
                serverEnv: '环境变量',
                serverStatus: '服务器状态',
                connecting: '连接中',
                connected: '已连接',
                disconnected: '已断开',
                error: '错误'
            },
            checkpoint: {
                title: '存档点设置',
                loading: '加载配置...',
                loadError: '加载存档点配置失败，设置已禁用，避免覆盖已有配置。',
                loadRetry: '重试',
                sections: {
                    enable: {
                        label: '启用存档点功能',
                        description: '在工具执行前后自动创建代码库快照，支持一键回退'
                    },
                    messages: {
                        title: '消息类型存档点',
                        description: '选择是否为用户消息和模型消息创建存档点（独立于工具调用）',
                        beforeLabel: '消息前',
                        afterLabel: '消息后',
                        types: {
                            user: {
                                name: '用户消息',
                                description: '用户发送的消息'
                            },
                            model: {
                                name: '模型消息',
                                description: '模型回复的消息（不包含工具调用）'
                            }
                        },
                        options: {
                            modelOuterLayerOnly: {
                                label: '连续调用工具时，只在最外层创建模型消息存档点',
                                hint: '启用后，模型消息的"消息前"存档点只在第一次迭代创建，"消息后"存档点只在最后一次（无工具调用）创建。禁用后每次迭代都会创建。'
                            },
                            mergeUnchanged: {
                                label: '合并显示消息前后无变更的存档点',
                                hint: '启用后，如果消息前后存档点的内容相同，将合并显示为一个"内容未变化"的存档点。禁用后将始终分别显示前后存档点。'
                            }
                        }
                    },
                    tools: {
                        title: '工具备份配置',
                        description: '选择需要在执行前后创建备份的工具',
                        beforeLabel: '执行前',
                        afterLabel: '执行后',
                        empty: '暂无可用的工具'
                    },
                    other: {
                        title: '其他配置',
                        maxCheckpoints: {
                            label: '最大存档点数量',
                            placeholder: '-1',
                            hint: '超过此数量时自动清理旧的存档点，填写 -1 表示无上限'
                        }
                    },
                    exclusion: {
                        title: '排除配置',
                        description: '控制哪些文件不会进入存档。默认排除类别可分别开关；被排除的文件不会被备份，但会记录原因，可点击“预览排除结果”查看。',
                        patterns: '条规则',
                        patternsAdd: '添加',
                        profiles: {
                            logs: '日志文件',
                            aiModels: 'AI/ML 模型权重',
                            datasets: '数据集',
                            caches: '缓存',
                            pythonVenvs: 'Python 虚拟环境',
                            buildArtifacts: '构建产物',
                            largeMedia: '大型媒体文件',
                            archives: '压缩包与二进制产物'
                        },
                        maxFileSize: {
                            label: '单文件大小上限 (MiB)',
                            hint: '超过此大小的文件不会进入存档（0 = 不限制，默认 50）',
                            invalid: '请输入有效的数字（MiB，0 表示不限制）'
                        },
                        customPatterns: {
                            label: '自定义排除模式',
                            hint: '每行一个 gitignore 模式；以 ! 开头可重新纳入默认类别，但不能覆盖强制排除（.git / node_modules / 扩展存储）',
                            reincludeHint: '提示：默认类别按目录排除时（如 data/、dist/），重新纳入其下文件需同时否定目录本身，例如 !data/ + !data/keep.txt',
                            placeholder: '*.log\ngenerated/\n!important/model.gguf',
                            empty: '暂无自定义模式，输入后按回车添加'
                        },
                        profilePatterns: {
                            edit: '编辑模式',
                            save: '保存',
                            cancel: '取消',
                            hint: '覆盖该类别的默认排除模式；清空并保存则恢复默认清单',
                            placeholder: '每行一个 gitignore 模式',
                            empty: '使用该类别的默认排除模式，保存空清单可恢复默认',
                            clear: '清空（恢复默认）'
                        },
                        preview: {
                            button: '预览排除结果',
                            loading: '扫描中...',
                            failed: '预览失败，请重试',
                            total: '共排除 {count} 个文件/目录，约 {size}',
                            partial: '（部分目录过大，大小统计可能不完整）',
                            empty: '当前配置不会排除任何文件',
                            count: '{count} 项',
                            rule: '规则',
                            source: '来源',
                            other: '其他（.gitignore / 自定义 / 大小限制等）',
                            noSamples: '无示例',
                            reasons: {
                                forced: '强制排除',
                                default: '默认类别',
                                gitignore: '.gitignore',
                                custom: '自定义',
                                size: '大小上限',
                                unreadable: '不可读'
                            }
                        }
                    },
                    cleanup: {
                        title: '清理存档点',
                        description: '按对话批量管理存档点，释放存储空间',
                        searchPlaceholder: '搜索对话标题...',
                        loading: '加载中...',
                        noMatch: '未找到匹配的对话',
                        noCheckpoints: '暂无存档点',
                        refresh: '刷新列表',
                        checkpointCount: '{count} 个存档点',
                        selectAll: '全选',
                        selectedCount: '已选 {count} 项',
                        selectedSize: '共 {size}',
                        totalSize: '总占用 {size}',
                        deleteSelected: '删除所选',
                        noCheckpointsInConversation: '该对话暂无存档点',
                        checkpointFiles: '{count} 个文件',
                        phaseBefore: '执行前',
                        phaseAfter: '执行后',
                        typeFull: '完整',
                        typeIncremental: '增量',
                        toolUserMessage: '用户消息',
                        toolModelMessage: '模型消息',
                        toolBatch: '批量工具调用',
                        confirmDelete: {
                            title: '确认删除',
                            conversationsMessage: '确定要删除选中的 {count} 个对话的全部存档点吗？',
                            checkpointsMessage: '确定要删除选中的 {count} 个存档点吗？',
                            stats: '将删除 {count} 个存档点，释放 {size} 存储空间',
                            warning: '此操作不可恢复',
                            cancel: '取消',
                            delete: '删除'
                        },
                        rejectedByDependency: '{count} 个存档点因被后续存档依赖而保留',
                        deleteFailedCount: '{count} 个存档点删除失败',
                        deleteRequestFailed: '删除请求失败，请重试',
                        unbackedFiles: '{count} 个文件未备份',
                        sizeIncomplete: '部分未统计',
                        sizeIncompleteHint: '部分旧存档缺少大小记录，总大小为已统计部分',
                        manifestDetail: '排除详情',
                        manifestLoadFailed: '排除清单加载失败',
                        manifestUnavailable: '该存档为旧格式，无排除清单可查看',
                        manifestExcludedCount: '排除文件数',
                        manifestNote: '该存档创建时按当时的排除规则排除了 {count} 个文件',
                        manifestRulesChanged: '当前排除规则已变化，恢复将按当前规则执行',
                        manifestIgnoreSnapshot: '排除规则快照',
                        manifestRuleVersion: '规则版本',
                        manifestForcedRulesVersion: '强制规则版本',
                        manifestDefaultProfileVersion: '默认类别版本',
                        manifestMaxFileSize: '单文件大小上限',
                        manifestEnabledProfiles: '启用的排除类别',
                        manifestCustomPatterns: '自定义排除模式',
                        manifestNone: '无',
                        manifestClose: '关闭',
                        progress: {
                            pending: '等待中',
                            scanning: '扫描中',
                            copying: '备份中',
                            cleaning: '清理中',
                            preparing: '准备中',
                            restoring: '恢复中',
                            deleting: '删除中',
                            done: '完成',
                            failed: '失败',
                            cancelled: '已取消',
                            cancel: '取消',
                            cancelFailed: '取消失败，请重试',
                            stale: '操作长时间无进展，可能已挂起；可尝试取消或刷新设置页'
                        },
                        timeFormat: {
                            justNow: '刚刚',
                            minutesAgo: '{count} 分钟前',
                            hoursAgo: '{count} 小时前',
                            daysAgo: '{count} 天前'
                        }
                    },
                    branchCleanup: {
                        title: '分支清理',
                        description: '管理已删除（软删）的分支候选，释放存储空间。删除的分支可先保留一段时间再自动清理，也可手动一键清理。',
                        deletedCountLabel: '已删除分支',
                        deletedCountValue: '{count} 个（分布在 {conversations} 个对话）',
                        deletedCountEmpty: '暂无已删除分支',
                        countLoadFailed: '加载已删除分支数量失败',
                        pruneButton: '一键清理过期软删',
                        pruneLoading: '清理中...',
                        pruneSuccess: '已清理 {count} 个过期分支节点',
                        pruneFailed: '清理失败：{message}',
                        pruneSkipped: '{count} 个对话的分支数据未清理（会话已不存在）',
                        retention: {
                            label: '软删保留期（天）',
                            hint: '删除的分支保留此天数后自动清理；填写 0 表示不自动清理（仅手动清理）',
                            invalid: '请输入非负整数（0 = 不自动清理）',
                            save: '保存'
                        }
                    }
                }
            },
            summarize: {
                title: '上下文总结',
                description: '压缩对话历史，减少 Token 使用量',
                enableSummarize: '启用总结',
                tokenThreshold: 'Token 阈值',
                summaryModel: '总结模型',
                summaryPrompt: '总结提示词'
            },
            imageGen: {
                title: '图像生成',
                description: '配置 AI 图像生成工具',
                enableImageGen: '启用图像生成',
                provider: '提供者',
                model: '模型',
                outputPath: '输出路径',
                maxImages: '最大图片数'
            },
            dependencies: {
                title: '扩展依赖',
                description: '管理可选功能所需的依赖',
                installed: '已安装',
                notInstalled: '未安装',
                installing: '安装中',
                installFailed: '安装失败',
                install: '安装',
                uninstall: '卸载',
                required: '必需',
                optional: '可选'
            },
            context: {
                title: '上下文感知',
                description: '配置发送给 AI 的工作区上下文信息',
                includeFileTree: '包含文件树',
                includeOpenFiles: '包含打开的文件',
                includeSelection: '包含选中内容',
                maxDepth: '最大深度',
                excludePatterns: '排除规则',
                pinnedFiles: '固定文件',
                addPinnedFile: '添加固定文件'
            },
            prompt: {
                title: '系统提示词',
                description: '自定义系统提示词的结构和内容',
                systemPrompt: '系统提示词',
                customPrompt: '自定义提示词',
                templateVariables: '模板变量',
                preview: '预览',
                sections: {
                    environment: '环境信息',
                    tools: '工具描述',
                    context: '上下文信息',
                    instructions: '指令'
                }
            },
            general: {
                title: '通用设置',
                description: '基本配置选项',
                proxy: {
                    title: '网络代理',
                    description: '配置 HTTP 代理用于 API 请求',
                    enable: '启用代理',
                    url: '代理地址',
                    urlPlaceholder: 'http://127.0.0.1:7890',
                    urlError: '请输入有效的代理地址（http:// 或 https://）'
                },
                language: {
                    title: '界面语言',
                    description: '选择界面显示语言',
                    auto: '跟随系统',
                    autoDescription: '自动跟随 VS Code 语言设置',
                    followSystem: '跟随系统'
                },
            },
            contextSettings: {
                loading: '加载中...',
                workspaceFiles: {
                    title: '工作区文件树',
                    description: '将工作区文件目录结构发送给 AI',
                    sendFileTree: '发送工作区文件树',
                    maxDepth: '最大深度',
                    unlimitedHint: '-1 表示无限制'
                },
                openTabs: {
                    title: '打开的标签页',
                    description: '将当前打开的文件列表发送给 AI',
                    sendOpenTabs: '发送打开的标签页',
                    maxCount: '最大数量'
                },
                activeEditor: {
                    title: '当前活动编辑器',
                    description: '将当前正在编辑的文件路径发送给 AI',
                    sendActiveEditor: '发送当前活动编辑器路径'
                },
                diagnostics: {
                    title: '诊断信息',
                    description: '将工作区的错误、警告等诊断信息发送给 AI，帮助 AI 修复代码问题',
                    enableDiagnostics: '启用诊断信息',
                    severityTypes: '问题类型',
                    severity: {
                        error: '错误',
                        warning: '警告',
                        information: '信息',
                        hint: '提示'
                    },
                    workspaceOnly: '仅工作区内文件',
                    openFilesOnly: '仅打开的文件',
                    maxPerFile: '每文件最大数量',
                    maxFiles: '最大文件数'
                },
                ignorePatterns: {
                    title: '忽略模式',
                    description: '匹配的文件/文件夹不会出现在上下文中（支持通配符）',
                    removeTooltip: '移除',
                    emptyHint: '暂无自定义忽略模式',
                    inputPlaceholder: '输入模式，如：**/node_modules, *.log',
                    addButton: '添加',
                    helpTitle: '通配符说明:',
                    helpItems: {
                        wildcard: '* - 匹配任意字符（不包含路径分隔符）',
                        recursive: '** - 匹配任意层级目录',
                        examples: '例如: **/node_modules、*.log、.git'
                    }
                },
                preview: {
                    title: '当前状态预览',
                    autoRefreshBadge: '实时更新',
                    description: '预览当前会发送给 AI 的上下文信息（每 2 秒自动刷新）',
                    activeEditorLabel: '当前活动编辑器：',
                    openTabsLabel: '打开的标签页（{count} 个）：',
                    noValue: '无',
                    moreItems: '... 还有 {count} 个'
                },
                saveSuccess: '保存成功',
                saveFailed: '保存失败'
            },
            dependencySettings: {
                title: '扩展依赖管理',
                description: '管理可选的扩展功能所需的依赖。这些依赖将安装到本地文件系统，不会打包进插件。',
                installPath: '安装路径：',
                installed: '已安装',
                installing: '安装中...',
                uninstalling: '卸载中...',
                install: '安装',
                uninstall: '卸载',
                estimatedSize: '约 {size}MB',
                empty: '暂无需要依赖的工具',
                progress: {
                    processing: '正在处理 {dependency}...',
                    complete: '{dependency} 处理完成',
                    failed: '{dependency} 处理失败',
                    installSuccess: '{name} 安装成功！',
                    installFailed: '{name} 安装失败',
                    uninstallSuccess: '{name} 已卸载',
                    uninstallFailed: '{name} 卸载失败',
                    unknownError: '未知错误'
                },
                panel: {
                    installedCount: '{installed}/{total}'
                }
            },
            generateImageSettings: {
                description: '图像生成工具允许 AI 调用图像生成模型来创建图片。生成的图片会保存到工作区并以多模态形式返回给 AI 查看。',
                api: {
                    title: 'API 配置',
                    url: 'API URL',
                    urlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
                    urlHint: '图像生成 API 的基础 URL',
                    apiKey: 'API Key',
                    apiKeyPlaceholder: '输入 API Key',
                    apiKeyHint: '用于图像生成 API 的密钥',
                    model: '模型名称',
                    modelPlaceholder: 'gemini-3-pro-Image-preview',
                    modelHint: '例如：gemini-3-pro-Image-preview',
                    show: '显示',
                    hide: '隐藏'
                },
                aspectRatio: {
                    title: '宽高比参数',
                    enable: '启用宽高比参数',
                    fixedRatio: '固定宽高比',
                    placeholder: '不固定（AI 可选择）',
                    options: {
                        auto: '自动',
                        square: '正方形',
                        landscape: '横向',
                        portrait: '纵向',
                        mobilePortrait: '手机屏幕竖屏',
                        widescreen: '宽屏',
                        ultrawide: '超宽屏'
                    },
                    hints: {
                        disabled: '禁用时：AI 不能配置此参数，API 调用不传入此参数',
                        fixed: '已固定：AI 将被告知固定为 {ratio}，不能更改',
                        flexible: '未固定：AI 可使用 aspect_ratio 参数自行选择'
                    }
                },
                imageSize: {
                    title: '图片尺寸参数',
                    enable: '启用图片尺寸参数',
                    fixedSize: '固定图片尺寸',
                    placeholder: '不固定（AI 可选择）',
                    options: {
                        auto: '自动'
                    },
                    hints: {
                        disabled: '禁用时：AI 不能配置此参数，API 调用不传入此参数',
                        fixed: '已固定：AI 将被告知固定为 {size}，不能更改',
                        flexible: '未固定：AI 可使用 image_size 参数自行选择'
                    }
                },
                batch: {
                    title: '批量生成限制',
                    maxTasks: '最大批量任务数',
                    maxTasksHint: 'AI 单次调用允许的最大任务数（不同提示词的图片）。范围 1-20。',
                    maxImagesPerTask: '单任务最大图片数',
                    maxImagesPerTaskHint: '每个任务（单个提示词）最多保存的图片数量。范围 1-10。',
                    summary: '当前配置：AI 单次最多发起 {maxTasks} 个任务，每个任务最多保存 {maxImages} 张图片'
                },
                usage: {
                    title: '使用说明',
                    step1: '配置上方的 API URL、API Key 和模型名称',
                    step2: '确保工具在"工具设置"中已启用',
                    step3: '在对话中让 AI 调用 generate_image 工具生成图片',
                    step4: '生成的图片会保存到工作区的 generated_images 目录',
                    warning: '请配置 API Key 后才能使用图像生成功能'
                }
            },
            mcpSettings: {
                toolbar: {
                    addServer: '添加服务器',
                    editJson: '编辑 JSON',
                    refresh: '刷新'
                },
                loading: '加载中...',
                empty: {
                    title: '暂无 MCP 服务器',
                    description: '点击"添加服务器"按钮来配置您的第一个 MCP 服务器'
                },
                serverCard: {
                    connect: '连接',
                    disconnect: '断开',
                    connecting: '连接中...',
                    edit: '编辑',
                    delete: '删除',
                    tools: '工具',
                    resources: '资源',
                    prompts: '提示'
                },
                status: {
                    connected: '已连接',
                    connecting: '连接中...',
                    error: '连接错误',
                    disconnected: '未连接'
                },
                form: {
                    addTitle: '添加 MCP 服务器',
                    editTitle: '编辑 MCP 服务器',
                    serverId: '服务器 ID',
                    serverIdPlaceholder: '可选，留空则自动生成',
                    serverIdHint: '只能包含字母、数字、下划线和中划线，用于在 JSON 配置中标识服务器',
                    serverIdError: 'ID 只能包含字母、数字、下划线和中划线',
                    serverName: '服务器名称',
                    serverNamePlaceholder: '例如：My MCP Server',
                    description: '描述',
                    descriptionPlaceholder: '可选的描述信息',
                    required: '*',
                    transportType: '传输类型',
                    command: '命令',
                    commandPlaceholder: '例如：npx, python, node',
                    args: '参数',
                    argsPlaceholder: 'JSON 字符串数组（仍兼容空格分隔），例如：["-m","mcp server"]',
                    env: '环境变量 (JSON)',
                    envPlaceholder: '{"KEY": "value"}',
                    url: 'URL',
                    urlPlaceholderSse: 'https://example.com/sse',
                    urlPlaceholderHttp: 'https://example.com/mcp',
                    headers: '请求头 (JSON)',
                    headersPlaceholder: '{"Authorization": "Bearer token"}',
                    options: '选项',
                    enabled: '启用',
                    autoConnect: '自动连接',
                    cleanSchema: '清理 Schema',
                    cleanSchemaHint: '移除 JSON Schema 中不兼容的字段（如 $schema, additionalProperties），某些 API（如 Gemini）需要启用此选项',
                    timeout: '连接超时 (毫秒)',
                    cancel: '取消',
                    create: '创建',
                    save: '保存'
                },
                validation: {
                    nameRequired: '请输入服务器名称',
                    idInvalid: 'ID 无效',
                    idChecking: '正在验证 ID，请稍候',
                    commandRequired: '请输入命令',
                    urlRequired: '请输入 URL',
                    invalidJson: '请输入有效的 JSON 对象',
                    invalidArgsJsonArray: '请输入仅包含字符串的有效 JSON 数组',
                    createFailed: '创建失败',
                    updateFailed: '更新失败'
                },
                delete: {
                    title: '删除 MCP 服务器',
                    message: '确定要删除服务器 "{name}" 吗？此操作不可恢复。',
                    confirm: '删除',
                    cancel: '取消'
                }
            },
            subagents: {
                selectAgent: '选择子代理',
                noAgents: '暂无子代理',
                create: '新建',
                rename: '重命名',
                delete: '删除',
                disabled: '已禁用',
                enabled: '启用此子代理',
                saveFailed: '保存失败：{error}',
                globalConfig: '全局配置',
                maxConcurrentAgents: '最大并发数',
                maxConcurrentAgentsHint: '同时运行的子代理数量上限，超出的自动排队等待（-1 表示无限制）',
                defaultMaxIterations: '默认迭代次数',
                defaultMaxIterationsHint: '未单独配置迭代次数的子代理与 General Worker 的默认值（1~200，-1 表示无限制）',
                generalWorker: '启用通用 Worker（傻瓜模式）',
                generalWorkerHint: '主模型可直接派发零配置的 "General Worker"：继承当前渠道与全部工具权限，数量由主模型自行决定，无需手动配置任何 agent',
                basicInfo: '基本信息',
                description: '描述',
                descriptionPlaceholder: '向主 AI 说明何时使用此子代理',
                maxIterations: '最大迭代次数',
                maxIterationsHint: '子代理内部最大工具调用轮数（-1 表示无限制）',
                maxRuntime: '最大运行时间',
                maxRuntimeHint: '子代理最大运行时间（秒，-1 表示无限制）',
                systemPrompt: '系统提示词',
                systemPromptPlaceholder: '输入子代理的系统提示词...',
                channelModel: '渠道与模型',
                channel: '渠道',
                selectChannel: '选择渠道',
                model: '模型',
                selectModel: '选择模型',
                tools: '工具配置',
                toolsDescription: '配置子代理可使用的工具',
                toolMode: {
                    label: '工具模式',
                    all: '全部工具',
                    builtin: '仅内置工具',
                    mcp: '仅 MCP 工具',
                    whitelist: '白名单',
                    blacklist: '黑名单'
                },
                noTools: '暂无可用工具',
                whitelistHint: '勾选的工具将被允许使用',
                blacklistHint: '勾选的工具将被禁止使用',
                emptyState: '暂无子代理，点击下方按钮创建第一个',
                createFirst: '创建子代理',
                deleteConfirm: {
                    title: '删除子代理',
                    message: '确定要删除此子代理吗？此操作不可恢复。'
                },
                createDialog: {
                    title: '新建子代理',
                    nameLabel: '名称',
                    namePlaceholder: '例如：代码审查专家',
                    nameRequired: '请输入子代理名称',
                    nameDuplicate: '已存在同名的子代理',
                    templateLabel: '模板'
                },
                presets: {
                    blank: {
                        name: '空白',
                        description: '从零开始配置一个子代理'
                    },
                    codeReviewer: {
                        name: '代码审核者',
                        description: '只读审核指定范围的代码，输出结构化审查结论，不修改任何文件'
                    },
                    deepResearcher: {
                        name: '深度研究员',
                        description: '深入调研代码库与外部资料，返回带出处的研究报告'
                    },
                    parallelEditor: {
                        name: '并行修改者',
                        description: '在指定范围内执行代码修改并自行验证，适合多区域并行修改'
                    },
                    webSearcher: {
                        name: '联网搜索员',
                        description: '仅使用联网/MCP 工具搜索资料，返回带来源链接的摘要'
                    }
                }
            },
            modelManager: {
                title: '模型列表',
                fetchModels: '获取模型',
                clearAll: '清除全部',
                clearAllTooltip: '清除所有模型',
                empty: '暂无模型，请点击"获取模型"或手动添加',
                addPlaceholder: '手动输入模型 ID',
                addTooltip: '添加',
                removeTooltip: '移除',
                enabledTooltip: '当前启用的模型',
                filterPlaceholder: '筛选模型...',
                clearFilter: '清除筛选',
                noResults: '没有匹配的模型',
                clearDialog: {
                    title: '清除所有模型',
                    message: '确定要清除所有 {count} 个模型吗？此操作不可恢复。',
                    confirm: '清除',
                    cancel: '取消'
                },
                errors: {
                    addFailed: '添加模型失败',
                    removeFailed: '移除模型失败',
                    setActiveFailed: '设置激活模型失败'
                }
            },
            modelSelectionDialog: {
                title: '选择要添加的模型',
                selectAll: '全选',
                deselectAll: '全不选',
                close: '关闭',
                loading: '加载中...',
                error: '加载模型列表失败',
                retry: '重试',
                empty: '暂无可用模型',
                added: '已添加',
                selectionCount: '已选择 {count} 个模型',
                cancel: '取消',
                add: '添加 ({count})',
                filterPlaceholder: '筛选模型...',
                clearFilter: '清除筛选',
                noResults: '没有匹配的模型'
            },
            promptSettings: {
                loading: '加载中...',
                enable: '启用自定义系统提示词模板',
                enableDescription: '启用后可以自定义系统提示词的结构和内容，使用模块占位符组装提示词',
                modes: {
                    label: '提示词模式',
                    add: '添加模式',
                    rename: '重命名',
                    delete: '删除模式',
                    confirmDelete: '确定要删除这个模式吗？此操作不可撤销。',
                    cannotDeleteDefault: '无法删除默认模式',
                    unsavedChanges: '当前模式有未保存的更改，确定要放弃并切换吗？',
                    newModeName: '请输入新模式的名称',
                    newModeDefault: '新模式',
                    renameModePrompt: '请输入新的模式名称',
                    duplicate: '复制模式',
                    copySuffix: '副本',
                    exportCurrent: '导出当前模式',
                    exportAll: '导出全部模式',
                    exportSuccess: '已导出并复制到剪贴板',
                    exportDownloadOnly: '已导出文件，剪贴板复制失败',
                    import: '导入模式',
                    importDescription: '粘贴 GrayCode 提示词模式 JSON，或从文件读取。导入时会自动生成新 ID，并避免覆盖现有模式。',
                    importFromFile: '从文件读取',
                    importPlaceholder: '粘贴导出的提示词模式 JSON...',
                    importConfirm: '导入',
                    importInvalid: '导入内容不是有效的提示词模式',
                    importEmpty: '导入内容为空',
                    importFailed: '导入失败',
                    importSuccess: '已导入 {count} 个模式',
                    importedModeDefault: '导入模式',
                    duplicateSuccess: '已复制模式',
                    duplicateFailed: '复制模式失败'
                },
                templateSection: {
                    title: '系统提示词模板',
                    resetButton: '重置为默认',
                    description: '直接编写系统提示词，使用 {{$VARIABLE}} 格式引用变量，变量会在发送时被替换为实际内容',
                    placeholder: '输入系统提示词，可以使用 {{$ENVIRONMENT}} 等变量...'
                },
                staticSection: {
                    title: '静态系统提示词',
                    description: '放入系统提示词中，内容相对稳定，可被 API 提供商缓存以加速响应。使用 {{$VARIABLE}} 格式引用静态变量。',
                    placeholder: '输入静态系统提示词，可使用 {{$ENVIRONMENT}}、{{$TOOLS}} 等变量...'
                },
                dynamicSection: {
                    title: '动态上下文模板',
                    description: '每次请求时动态生成并追加到消息末尾，包含实时信息（时间、文件树、标签页等），不存储到历史记录中。',
                    placeholder: '输入动态上下文模板，可使用 {{$WORKSPACE_FILES}}、{{$OPEN_TABS}} 等变量...',
                    enableTooltip: '启用/禁用动态上下文模板',
                    disabledNotice: '动态上下文模板已禁用，不会向 AI 发送动态上下文消息。',
                    strategyTitle: '动态上下文策略',
                    strategySingle: '单份动态上下文（当前策略）',
                    strategyPreserve: '保留旧动态上下文原位',
                    strategyDescription: '单份模式保持现有行为；保留模式会把已缓存的旧动态上下文固定插回原回合位置，新回合上下文插入到新消息前。',
                    strategyPreserveWarning: '保留模式会增加请求 token；旧动态上下文越多，越容易触发上下文裁剪或总结。'
                },
                toolPolicy: {
                    title: '工具策略',
                    description: '限制当前模式可用的工具。未设置时继承 Code 模式的工具集（同时仍受全局工具开关影响）。',
                    inherit: '继承（默认）',
                    custom: '自定义（Allowlist）',
                    inheritHint: '当前模式将继承 Code 模式的工具集。',
                    searchPlaceholder: '搜索工具…',
                    selectAll: '全选',
                    clear: '清空',
                    loadingTools: '加载工具列表...',
                    noTools: '暂无可用工具',
                    disabledBadge: '已禁用',
                    emptyWarning: '当前为自定义工具列表，但未选择任何工具。',
                    emptyCannotSave: '自定义工具列表至少需要选择 1 个工具'
                },
                saveButton: '保存配置',
                saveSuccess: '保存成功',
                saveFailed: '保存失败',
                modulesReference: {
                    title: '可用变量参考',
                    insertTooltip: '插入到模板末尾'
                },
                staticModules: {
                    title: '静态变量',
                    badge: '可缓存',
                    description: '这些变量会放入系统提示词中，内容相对稳定，可被 API 提供商缓存以加速响应。'
                },
                dynamicModules: {
                    title: '动态变量',
                    badge: '实时更新',
                    description: '这些变量会作为上下文动态插入到最后一条消息中，包含当前时间、文件状态等实时信息，不存储到对话历史中。'
                },
                tokenCount: {
                    label: 'Token 数量',
                    staticLabel: '静态模板',
                    dynamicLabel: '动态上下文',
                    staticTooltip: '静态模板本身的 Token 数量（不包含 {{$TOOLS}} 等占位符的实际内容）',
                    dynamicTooltip: '动态上下文的实际 Token 数量（包含文件树、诊断等实际填充的内容）',
                    channelTooltip: '选择用于计算 token 的渠道',
                    refreshTooltip: '刷新 token 计数',
                    failed: '计数失败',
                    hint: '静态模板为模板本身，动态上下文为实际填充后的内容。实际请求还包括工具定义等内容。'
                },
                modules: {
                    ENVIRONMENT: {
                        name: '环境信息',
                        description: '包含工作区路径、操作系统、当前时间和时区信息'
                    },
                    CONTEXT_BADGE_FORMAT: {
                        name: '上下文徽章结构',
                        description: '解释 <lim-context ...>...</lim-context> 的字段语义，明确标题（title 属性）、正文（标签体）以及 binary 徽章不应按文本解析'
                    },
                    WORKSPACE_FILES: {
                        name: '工作区文件树',
                        description: '列出工作区中的文件和目录结构，受上下文感知设置中的深度和忽略模式影响',
                        requiresConfig: '上下文感知 > 发送工作区文件树'
                    },
                    OPEN_TABS: {
                        name: '打开的标签页',
                        description: '列出当前在编辑器中打开的文件标签页',
                        requiresConfig: '上下文感知 > 发送打开的标签页'
                    },
                    ACTIVE_EDITOR: {
                        name: '活动编辑器',
                        description: '显示当前正在编辑的文件路径',
                        requiresConfig: '上下文感知 > 发送当前活动编辑器'
                    },
                    DIAGNOSTICS: {
                        name: '诊断信息',
                        description: '显示工作区的错误、警告等诊断信息，帮助 AI 修复代码问题',
                        requiresConfig: '上下文感知 > 启用诊断信息'
                    },
                    PINNED_FILES: {
                        name: '固定文件内容',
                        description: '显示用户固定的文件的完整内容',
                        requiresConfig: '需要在输入框旁的固定文件按钮中添加文件'
                    },
                    SKILLS: {
                        name: 'Skills 内容',
                        description: 'Skills 是用户自定义的知识模块。AI 通过 read_skill 工具按需加载内容，Skill 名称和描述列在工具描述中。',
                        requiresConfig: '在 Skills 面板中启用 Skill，AI 通过 read_skill 工具加载内容'
                    },
                    TOOLS: {
                        name: '工具定义',
                        description: '根据渠道配置生成 XML 或 Function Call 格式的工具定义（此变量由系统自动填充）'
                    },
                    MCP_TOOLS: {
                        name: 'MCP 工具',
                        description: '来自 MCP 服务器的额外工具定义（此变量由系统自动填充）',
                        requiresConfig: 'MCP 设置中需要配置并连接服务器'
                    },
                    TODO_LIST: {
                        name: 'TODO 列表',
                        description: '显示当前会话的 TODO 列表（来自 todo_write / todo_update / create_plan 持久化的 todoList 元数据）'
                    },
                    MEMORY: {
                        name: '记忆系统',
                        description: '永久记忆系统（OptMem）的使用说明，告诉 AI 如何跨会话记录和回忆信息。可在 设置 → 记忆 中自定义内容。',
                        requiresConfig: '设置 → 记忆 中可自定义此提示词'
                    }
                },
                exampleOutput: '示例输出：',
                requiresConfigLabel: '依赖配置：'
            },
            summarizeSettings: {
                description: '上下文总结功能可以压缩对话历史，减少 Token 使用量。此页面用于配置手动总结与总结模型。自动总结请在「渠道设置 > 上下文管理」中配置。',
                manualSection: {
                    title: '手动总结',
                    description: '点击输入框右侧的压缩按钮，可以手动触发上下文总结。总结后的内容会替换原有的历史对话。'
                },
                optionsSection: {
                    title: '总结选项',
                    keepRounds: '最少保留轮数',
                    keepRoundsUnit: '轮',
                    keepRoundsHint: '作为保留预算的下限保护，至少保留最近 N 轮对话不参与总结',
                    keepRoundsMinNote: '下限为 1 轮（后端强制至少保留 1 轮）',
                    keepTokens: '保留内容预算',
                    keepTokensHint: '总结时保留最近约多少上下文不被压缩：填 token 数（如 30000）或相对模型最大上下文的百分比（如 25%），实际范围按此预算对齐到轮边界',
                    maxAttempts: '自动总结最大尝试次数',
                    maxAttemptsUnit: '次/回合',
                    maxAttemptsHint: '同一真实用户回合内自动总结最多尝试次数（1-5，默认 2）。次数耗尽后若仍超阈值，本次请求改用不持久化的安全裁剪',
                    maxInputRatio: '总结模型输入占比',
                    maxInputRatioHint: '自动总结单次请求输入占总结模型上下文窗口的比例（5%-95%，默认 50%）。超出时自动缩小总结范围，保留最近一轮工具交互',
                    manualPrompt: '手动总结提示词',
                    manualPromptPlaceholder: '输入手动总结时使用的提示词...',
                    manualPromptHint: '点击“总结上下文”按钮时使用此提示词',
                    autoPrompt: '自动总结提示词',
                    autoPromptPlaceholder: '输入自动触发总结时使用的提示词（留空则使用内置提示词）...',
                    autoPromptHint: '当达到自动总结阈值时使用此提示词',
                    restoreBuiltin: '恢复内置默认'
                },
                modelSection: {
                    title: '专用总结模型',
                    useSeparate: '使用专用总结模型',
                    useSeparateHint: '启用后，总结时将使用下方指定的模型，而不是对话时使用的模型。\n可以选择更便宜的模型来节省成本。',
                    currentModelHint: '当前使用对话时的模型进行总结',
                    selectChannel: '选择渠道',
                    selectChannelPlaceholder: '选择用于总结的渠道',
                    selectChannelHint: '只显示已启用的渠道',
                    selectModel: '选择模型',
                    selectModelPlaceholder: '选择用于总结的模型',
                    selectModelHint: '只显示该渠道已添加到设置中的模型。\n如需添加更多模型，请前往渠道设置进行配置。',
                    warningHint: '请选择渠道和模型，否则将使用对话时的模型进行总结'
                }
            },
            settingsPanel: {
                title: '设置',
                backToChat: '返回对话',
                sidebarCollapse: '收起边栏',
                sidebarExpand: '展开边栏',
                search: {
                    placeholder: '搜索设置项…',
                    clear: '清除搜索',
                    noResults: '未找到匹配的设置项',
                    hint: '输入关键词查找设置，回车打开第一个结果'
                },
                sections: {
                    channel: {
                        title: '渠道设置',
                        description: '配置 API 渠道和模型'
                    },
                    tools: {
                        title: '工具设置',
                        description: '管理和配置可用工具'
                    },
                    autoExec: {
                        title: '自动执行',
                        description: '配置工具执行时的确认行为'
                    },
                    mcp: {
                        title: 'MCP 设置',
                        description: '配置 Model Context Protocol 服务器'
                    },
                    checkpoint: {
                        title: '存档点设置',
                        description: '配置代码库快照备份和回退'
                    },
                    summarize: {
                        title: '上下文总结',
                        description: '压缩对话历史，减少 Token 使用量'
                    },
                    imageGen: {
                        title: '图像生成',
                        description: '配置 AI 图像生成工具'
                    },
                    context: {
                        title: '上下文感知',
                        description: '配置发送给 AI 的工作区上下文信息'
                    },
                    prompt: {
                        title: '系统提示词',
                        description: '自定义系统提示词的结构和内容'
                    },
                    tokenCount: {
                        title: 'Token 计数',
                        description: '配置用于计算 Token 数量的 API'
                    },
                    subagents: {
                        title: '子代理',
                        description: '配置可由 AI 调用的专业子代理'
                    },
                    dependencies: {
                        title: '扩展依赖',
                        description: '安装和管理 Python/Node 等扩展依赖工具'
                    },
                    sound: {
                        title: '通知系统',
                        description: '统一配置声音提示与 Windows Agent 停止系统通知'
                    },
                    appearance: {
                        title: '外观设置',
                        description: '配置界面外观相关选项'
                    },
                    memory: {
                        title: '永久记忆',
                        description: '配置 AI 跨会话永久记忆系统（OptMem）'
                    },
                    sandbox: {
                        title: '沙箱',
                        description: '在隔离的临时目录中安全运行代码片段'
                    },
                    remoteControl: {
                        title: '远程控制',
                        description: '在局域网内用手机访问桌面端，查看对话与发送消息'
                    },
                    general: {
                        title: '通用设置',
                        description: '基本配置选项'
                    },
                    usage: {
                        title: '使用时间与用量',
                        description: '查看你的使用时间与 Token 用量统计',
                        openFullPage: '查看完整统计'
                    }
                },
                proxy: {
                    title: '网络代理',
                    description: '配置 HTTP 代理用于 API 请求',
                    enable: '启用代理',
                    url: '代理地址',
                    urlPlaceholder: 'http://127.0.0.1:7890',
                    urlError: '请输入有效的代理地址（http:// 或 https://）',
                    save: '保存',
                    saveSuccess: '保存成功',
                    saveFailed: '保存失败'
                },
                language: {
                    title: '界面语言',
                    description: '选择界面显示语言',
                    placeholder: '选择语言',
                    autoDescription: '自动跟随 VS Code 语言设置',
                    followSystem: '跟随系统'
                },
                workspaceBehavior: {
                    title: '工作区行为',
                    description: '选择启动时如何处理上次打开的工作区',
                    optionRestore: '打开关闭界面时的工作区',
                    optionNone: '不打开任何工作区'
                },
                appInfo: {
                    title: '应用信息',
                    name: '{appName} - Vibe Coding 助手',
                    version: '版本：{version}',
                    repository: '项目仓库',
                    developer: '开发者'
                },
                update: {
                    title: '自动更新',
                    description: '启动时检查 GitHub Releases 是否有新版本（24 小时内不重复检查），发现新版可自动下载安装。',
                    enableLabel: '启用自动检查更新',
                    checkNow: '立即检查',
                    updateNow: '一键更新',
                    checking: '检查中…',
                    upToDate: '已是最新版本',
                    updateAvailable: '发现新版本 v{version}',
                    installedHint: 'v{version} 已安装，重启窗口后生效',
                    error: '检查失败',
                    disabledHint: '自动检查已关闭'
                },
                exportImport: {
                    title: '设置导入/导出',
                    description: '将所有插件设置（渠道配置、MCP 服务器、Skills 等）打包导出为 JSON 文件，或从文件导入恢复设置。不包含对话历史和检查点。',
                    exportBtn: '导出设置',
                    importBtn: '导入设置',
                    exporting: '正在导出...',
                    importing: '正在导入...',
                    exportSuccess: '设置已成功导出到：{path}',
                    exportFailed: '导出失败',
                    importSuccess: '导入完成。已导入：{items}',
                    importNoItems: '没有可导入的项目',
                    importFailed: '导入失败',
                    vscodeSettings: 'VSCode 设置',
                    channelConfigs: '个渠道配置',
                    mcpServers: '个 MCP 服务器',
                    skills: '个 Skills'
                },
                memory: {
                    loading: '正在加载记忆配置...',
                    globalOnlyHint: '全局设置，仅「全局记忆」tab 可修改。',
                    enabled: {
                        label: '启用长期记忆',
                        description: '允许 AI 跨会话回忆和记录长期信息。',
                        disabledNotice: '关闭后不会注入记忆提示词，也不会向 AI 提供记忆工具。已有记忆和配置将保留，仍可在下方查看和编辑。'
                    },
                    saved: '保存成功',
                    saving: '正在保存...',
                    save: '保存配置',
                    reset: '恢复默认',
                    systemPrompt: {
                        title: '自定义提示词',
                        description: '上方为当前生效的提示词，可直接编辑。点击「恢复默认」可还原为内置默认值。修改后在下一次会话生效。',
                        placeholder: ''
                    },
                    runtime: {
                        title: '运行时参数',
                        description: '精细调整记忆系统的输出格式和容量。修改仅影响展示效果，无需重新计算。',
                        wakeLines: {
                            label: '唤醒输出行数',
                            description: 'wake 最多输出多少行。越大 = 越多细节，但 token 消耗也越高。',
                            unit: '行'
                        },
                        entryChars: {
                            label: '单条记忆最大字节',
                            description: '每条记忆的最大字节数。超过此限制的文本将被截断。',
                            unit: '字节'
                        }
                    },
                    info: {
                        title: '关于永久记忆',
                        text: '记忆系统（OptMem）让 AI 在每次会话开始时自动回忆之前的约定、决策和知识。AI 会在工作过程中自动记录重要事项，旧记忆会被智能压缩为摘要以节省 token。'
                    },
                    rawEntries: {
                        title: '原始记忆条目',
                        description: '查看和编辑原始记忆条目。编辑会清除相关摘要（下次压缩时重新构建）。',
                        empty: '暂无记忆条目。',
                        addPlaceholder: '输入要记住的内容，点击「添加记忆」手动写入长期记忆（与 AI 的 memory_note 等效）。支持 Ctrl+Enter / ⌘+Enter 快捷提交。',
                        add: '添加记忆',
                        added: '已添加记忆 #{id}',
                        addEmpty: '内容为空，无法添加记忆。',
                        addTooLong: '内容超过单条记忆上限（{limit} 字节）。',
                        truncatedNotice: '记忆超过 {limit} 条，列表仅展示前 {limit} 条（其余可在对话中通过 memory_recall 检索）。',
                        deleteConfirmTitle: '删除记忆条目',
                        deleteConfirmMessage: '确定删除这条原始记忆（#{id}）？删除后其后的记忆编号将前移，相关摘要会清空并在下次压缩时重建。',
                        selectAll: '全选',
                        deleteSelected: '删除所选（{count}）',
                        deletedBatch: '已删除 {count} 条记忆。',
                        batchDeleteConfirmTitle: '批量删除记忆条目',
                        batchDeleteConfirmMessage: '确定删除选中的 {count} 条原始记忆？删除后剩余记忆编号将前移，相关摘要会清空并在下次压缩时重建。',
                        scopeGlobal: '全局记忆',
                        scopeGlobalHint: '所有工作区共享的默认记忆。AI 在无工作区上下文时使用全局记忆。',
                        scopeWorkspace: '工作区记忆',
                        scopeWorkspaceHint: '每个工作区独立保存的记忆，与其他工作区及全局记忆互不影响。',
                        selectScopeWorkspace: '选择工作区…',
                        workspaceNone: '当前没有可选的工作区。请打开或添加一个工作区后重试。',
                        workspaceMemoryEmpty: '该工作区还没有记忆。在此分区添加的记忆仅对该工作区可见。',
                        newlineNotAllowed: '记忆必须为单行文本。请删除换行后重试。'
                    }
                },
                sandbox: {
                    enabled: {
                        label: '启用沙箱',
                        description: '允许 AI 在隔离的临时目录中运行代码片段。关闭后不向模型提供 sandbox 工具。',
                        disabledNotice: '沙箱已关闭。AI 将无法使用 sandbox 工具运行代码。'
                    },
                    languages: {
                        title: '允许的语言',
                        description: '仅勾选的语言可在沙箱中执行。取消勾选可禁用不需要的语言。'
                    },
                    timeout: {
                        title: '默认超时时间',
                        description: '代码运行的最大时长（毫秒）。超时后进程树将被强制终止。'
                    },
                    output: {
                        title: '最大输出行数',
                        description: '返回给 AI 的最大输出行数，超出时仅保留最后 N 行。',
                        unit: '行',
                        hint: '设为 -1 表示无限制（不推荐，可能导致输出过大）。'
                    },
                    cleanup: {
                        title: '清理临时目录',
                        description: '运行结束后自动删除临时目录。关闭后可保留运行产物用于调试。',
                        label: '运行后清理临时目录'
                    },
                    info: {
                        title: '关于沙箱安全',
                        text: '沙箱提供文件系统隔离（临时目录）、超时与输出上限，但并非操作系统级强隔离。它不限制网络访问、CPU 或内存用量。请勿用于运行来源不明的恶意代码。'
                    },
                    save: '保存配置',
                    reset: '恢复默认',
                    saved: '保存成功',
                    saveFailed: '保存失败',
                    loadFailed: '加载沙箱配置失败',
                    noLanguage: '至少需要保留一种语言，否则沙箱将无法运行任何代码'
                },
                remoteControlSettings: {
                    desktopOnly: '远程控制仅在 GrayCode 桌面版中可用。',
                    enabled: {
                        label: '启用远程控制',
                        description: '在局域网内提供一个移动端友好的控制页面，用手机即可查看对话并发送消息。仅在开启时服务器才会运行。'
                    },
                    port: {
                        label: '端口号',
                        description: '监听端口（1-65535）。桌面端会监听所有局域网网卡，同一 Wi-Fi 下的手机可访问。',
                        required: '请输入端口号',
                        invalid: '端口必须为 1-65535 之间的整数'
                    },
                    save: '保存',
                    saveSuccess: '保存成功',
                    saveFailed: '保存失败',
                    status: {
                        running: '服务器运行中',
                        stopped: '服务器已停止',
                        retry: '重试'
                    },
                    urls: {
                        title: '访问地址',
                        description: '在手机浏览器中打开以下任一地址（需与电脑在同一 Wi-Fi）。',
                        copy: '复制',
                        empty: '启动服务器后即可看到访问地址。'
                    },
                    info: {
                        title: '安全说明',
                        text: '远程控制仅在局域网内监听，请勿将端口暴露到公网——任何能访问该端口的人都可以读取和发送消息。'
                    }
                },

            },
            toolSettings: {
                files: {
                    applyDiff: {
                        autoApply: '自动应用修改',
                        enableAutoApply: '启用自动应用',
                        enableAutoApplyDesc: '开启后，AI 修改将在指定延迟后自动保存，无需手动确认',
                        autoSaveDelay: '自动保存延迟',
                        delayTime: '延迟时间',
                        delayTimeDesc: '修改显示后等待此时间再自动保存',
                        delay005s: '0.05 秒',
                        delay1s: '1 秒',
                        delay2s: '2 秒',
                        delay3s: '3 秒',
                        delay5s: '5 秒',
                        delay10s: '10 秒',
                        infoEnabled: '当前设置：AI 修改文件后，将在 {delay} 后自动保存并继续执行。',
                        infoDisabled: '当前设置：AI 修改文件后，需要您手动在编辑器中按 Ctrl+S 保存确认修改。',

                        format: '差异格式',
                        formatDesc: '选择 AI 调用 apply_diff 时使用的参数格式（默认推荐结构化 hunks，兼容旧 unified diff patch）',
                        formatUnified: '结构化 hunks（推荐，兼容 unified diff patch）',
                        formatSearchReplace: '旧格式（search/replace）',

                        skipDiffView: '跳过差异视图',
                        enableSkipDiffView: '自动应用时不打开差异视图',
                        enableSkipDiffViewDesc: '开启后，自动应用修改时将直接保存文件而不打开差异对比视图',

                        diffGuard: '差异警戒值',
                        enableDiffGuard: '启用删除行数警戒值',
                        enableDiffGuardDesc: '当一次性删除的行数超过文件总行数的指定百分比时，在工具外侧显示警告提示',
                        diffGuardThreshold: '警戒阈值',
                        diffGuardThresholdDesc: '删除行数占文件总行数的百分比超过此值时触发警告',
                        diffGuardWarning: '此次修改删除了 {deletePercent}% 的文件内容（{deletedLines}/{totalLines} 行），超过 {threshold}% 的警戒阈值，请仔细检查',
                        outsideWorkspaceAccess: '工作区外写入',
                        outsideWorkspaceDesc: '控制 apply_diff 修改工作区外已有文件的行为。',
                        outsideWorkspaceDenyDesc: 'apply_diff 只能修改工作区内文件。',
                        outsideWorkspaceAskDesc: '修改工作区外文件前使用原本工具调用确认框请求同意。',
                        outsideWorkspaceTip: '工作区外 apply_diff 不提供“直接允许”选项；确认后仍会进入 Diff 预览/保存流程。'
                    },
                    outsideWorkspaceAccess: {
                        deny: '禁止',
                        ask: '需要用户同意',
                        allow: '直接允许'
                    },
                    readFile: {
                        outsideWorkspaceAccess: '工作区外读取',
                        outsideWorkspaceDenyDesc: 'read_file 只能读取工作区内文件。',
                        outsideWorkspaceAskDesc: '读取工作区外文件前使用原本工具调用确认框请求同意。',
                        outsideWorkspaceAllowDesc: '允许 read_file 直接读取工作区外文件。',
                        outsideWorkspaceTip: '相对路径仍按工作区解析；绝对路径、file:// URI 或越过工作区边界的路径会按此策略处理。'
                    },
                    writeFile: {
                        outsideWorkspaceAccess: '工作区外写入',
                        outsideWorkspaceDenyDesc: 'write_file 只能写入工作区内文件。',
                        outsideWorkspaceAskDesc: '写入工作区外文件前使用原本工具调用确认框请求同意，确认后仍会显示 Diff 预览。',
                        outsideWorkspaceTip: '工作区外写入不提供“直接允许”选项；确认后才会进入文件写入流程。'
                    },
                    listFiles: {
                        ignoreList: '忽略列表',
                        ignoreListHint: '（支持通配符，如 *.log, temp*）',
                        inputPlaceholder: '输入要忽略的文件或目录模式...',
                        deleteTooltip: '删除',
                        addButton: '添加'
                    }
                },
                search: {
                    findFiles: {
                        excludeList: '排除模式',
                        excludeListHint: '（glob 格式，如 **/node_modules/**）',
                        inputPlaceholder: '输入要排除的文件或目录模式...',
                        deleteTooltip: '删除',
                        addButton: '添加'
                    },
                    searchInFiles: {
                        excludeList: '排除模式',
                        excludeListHint: '（glob 格式，如 **/node_modules/**）',
                        inputPlaceholder: '输入要排除的文件或目录模式...',
                        deleteTooltip: '删除',
                        addButton: '添加'
                    }
                },
                history: {
                    searchSection: '搜索模式',
                    searchScope: '搜索范围',
                    searchScopeDesc: '选择工具能够检索的历史记录范围',
                    scopeAll: '全部对话历史（默认）',
                    scopeSummarized: '仅已总结的内容',
                    maxSearchMatches: '最大匹配数',
                    maxSearchMatchesDesc: '每次搜索返回的最大匹配行数',
                    searchContextLines: '上下文行数',
                    searchContextLinesDesc: '每个匹配前后显示的上下文行数',
                    readSection: '读取模式',
                    maxReadLines: '最大读取行数',
                    maxReadLinesDesc: '每次读取请求返回的最大行数',
                    outputSection: '输出限制',
                    maxResultChars: '结果最大字符数',
                    maxResultCharsDesc: '多行读取时结果的最大总字符数',
                    lineDisplayLimit: '单行显示字符限制',
                    lineDisplayLimitDesc: '每行最大显示字符数，超出部分省略（可通过单行 read 获取完整内容）'
                },
                terminal: {
                    executeCommand: {
                        shellEnv: 'Shell 环境',
                        defaultBadge: '默认',
                        available: '可用',
                        unavailable: '不可用',
                        setDefaultTooltip: '设为默认',
                        executablePath: '可执行文件路径（可选）：',
                        executablePathPlaceholder: '留空则使用系统 PATH 中的路径',
                        execTimeout: '执行超时',
                        timeoutHint: '命令执行超过此时间将自动终止',
                        timeout30s: '30 秒',
                        timeout1m: '1 分钟',
                        timeout2m: '2 分钟',
                        timeout5m: '5 分钟',
                        timeout10m: '10 分钟',
                        timeoutUnlimited: '无限制',
                        maxOutputLines: '最大输出行数',
                        maxOutputLinesHint: '发送给 AI 的终端输出的最后 N 行，避免输出过大',
                        unlimitedLines: '无限制',
                        tips: {
                            onlyEnabledUsed: '• 只有启用且可用的 Shell 才会被 AI 使用',
                            statusMeaning: '• ✓ 表示可用，✗ 表示不可用',
                            windowsRecommend: '• Windows 建议使用 PowerShell（支持 UTF-8）',
                            gitBashRequire: '• Git Bash 需要安装 Git for Windows',
                            wslRequire: '• WSL 需要启用 Windows Subsystem for Linux',
                            confirmSettings: '• 如需配置是否需要确认后执行，请前往"自动执行"设置页签'
                        }
                    }
                },
                media: {
                    common: {
                        returnImageToAI: '直接返回图片给 AI',
                        returnImageDesc: '启用后，处理结果的图片 base64 将直接作为工具响应返回给 AI，AI 可以直接查看和分析图片内容。',
                        returnImageDescDetail: '禁用后，只返回文字描述（如文件路径），AI 需要调用 read_file 工具才能查看图片。'
                    },
                    cropImage: {
                        title: '裁切图片',
                        description: '启用后，AI 可以直接查看裁切效果，判断区域是否正确。禁用可节省 token 消耗。'
                    },
                    generateImage: {
                        title: '图像生成',
                        description: '启用后，AI 可以直接看到生成的图片效果，便于判断是否需要重新生成或调整。禁用可节省 token 消耗。'
                    },
                    removeBackground: {
                        title: '抠图',
                        description: '启用后，AI 可以直接查看抠图效果，判断是否需要调整主体描述或重新处理。禁用可节省 token 消耗。'
                    },
                    resizeImage: {
                        title: '缩放图片',
                        description: '启用后，AI 可以直接查看缩放效果，判断尺寸是否合适。禁用可节省 token 消耗。'
                    },
                    rotateImage: {
                        title: '旋转图片',
                        description: '启用后，AI 可以直接查看旋转效果，判断角度是否正确。禁用可节省 token 消耗。'
                    }
                },
                common: {
                    loading: '加载中...',
                    loadingConfig: '加载配置...',
                    saving: '保存中...',
                    error: '错误',
                    retry: '重试'
                }
            },
            toolsSettings: {
                maxIterations: {
                    label: '单回合最大工具调用次数',
                    hint: '防止 AI 无限循环调用工具，-1 表示无限制',
                    unit: '次'
                },
                actions: {
                    refresh: '刷新',
                    enableAll: '全部启用',
                    disableAll: '全部禁用'
                },
                sandboxHint: '沙箱的详细参数请在「设置 → 沙箱」中配置',
                loading: '加载工具列表...',
                empty: '暂无可用工具',
                categories: {
                    file: '文件操作',
                    search: '搜索',
                    terminal: '终端',
                    lsp: '代码智能',
                    media: '媒体处理',
                    plan: '计划',
                    todo: 'TODO',
                    history: '历史',
                    memory: '记忆',
                    review: '审查',
                    progress: '进度',
                    skills: '技能',
                    design: '设计',
                    notification: '通知',
                    agents: '代理',
                    mcp: 'MCP 工具',
                    activity: '使用时间',
                    sandbox: '沙箱',
                    other: '其他'
                },
                dependency: {
                    required: '需要依赖',
                    requiredTooltip: '此工具需要安装依赖才能使用',
                    disabledTooltip: '工具已禁用或缺少依赖'
                },
                config: {
                    tooltip: '配置工具'
                },
                toolDisplayNames: {
                    read_file: '读取文件',
                    write_file: '写入文件',
                    delete_file: '删除文件',
                    create_directory: '创建目录',
                    list_files: '列出文件',
                    apply_diff: '应用diff',
                    execute_command: '执行命令',
                    sandbox: '沙箱',
                    find_files: '查找文件',
                    search_in_files: '在文件中搜索',
                    history_search: '历史搜索',
                    get_symbols: '获取符号',
                    goto_definition: '跳转定义',
                    find_references: '查找引用',
                    generate_image: '生成图片',
                    resize_image: '缩放图片',
                    crop_image: '裁切图片',
                    rotate_image: '旋转图片',
                    remove_background: '去除背景',
                    todo_write: '创建 TODO',
                    todo_update: '更新 TODO',
                    create_design: '创建设计',
                    update_design: '更新设计',
                    create_plan: '创建计划',
                    update_plan: '更新计划',
                    create_progress: '创建进度',
                    update_progress: '更新进度',
                    record_progress_milestone: '记录进度里程碑',
                    validate_progress_document: '校验进度文档',
                    create_review: '创建审查',
                    record_review_milestone: '记录审查里程碑',
                    finalize_review: '完成审查',
                    validate_review_document: '校验审查文档',
                    reopen_review: '重新打开审查',
                    compare_review_documents: '比较审查文档',
                    show_windows_notification: '显示 Windows 通知',
                    memory_wake: '唤醒记忆',
                    memory_note: '记录记忆',
                    memory_recall: '搜索记忆',
                    memory_compress: '压缩记忆',
                    memory_zoom: '展开记忆',
                    memory_forget: '丢弃记忆',
                    memory_config: '记忆配置',
                    insert_code: '插入代码',
                    delete_code: '删除代码',
                    read_skill: '读取技能',
                    toggle_skills: '切换技能',
                    subagents: '子代理',
                    agent_send_message: '发送代理消息',
                    get_activity_stats: '获取活动统计',
                },
                toolDescriptions: {
                    read_file: '读取工作区文件，支持文本和二进制文件，可指定行范围。',
                    write_file: '将内容写入文件。文件不存在则创建，存在则覆盖。',
                    delete_file: '删除文件或目录，支持非空目录。',
                    create_directory: '在工作区创建目录（自动创建父目录）。',
                    list_files: '列出目录中的文件和子目录，支持递归和行数统计。',
                    apply_diff: '对文件应用结构化内容替换，使用 hunks 数组格式进行精确修改。',
                    sandbox: '在隔离的沙箱（临时目录，带超时与输出上限）中运行代码。比 execute_command 更适合运行不可信代码片段：代码在一次性临时目录中运行，结束后自动清理；硬超时会终止进程树；输出行数上限防止刷屏。支持的语言：python, javascript, bash, powershell, sh。通过 code 参数传入完整源码，工具会写入文件并调用对应解释器；可选 stdin 会通过标准输入管道传给程序。注意：这是轻量级文件系统隔离，并非操作系统级强隔离，不阻止网络访问，也不限制 CPU/内存。请勿用于真正恶意的代码。默认执行前需要用户确认（与 execute_command 一致），可在工具自动执行设置中改为自动执行。',
                    execute_command: '执行 Shell 命令并返回输出。支持 PowerShell、CMD、Bash、WSL 等多种 Shell。',
                    find_files: '根据一个或多个 glob 模式查找文件，返回匹配的文件列表及行数详情。',
                    search_in_files: '在工作区文件中搜索或搜索替换内容，支持正则表达式。',
                    history_search: '搜索和读取对话历史记录。支持搜索关键词和按行读取两种模式。',
                    get_symbols: '获取文件中的所有符号（类、函数、变量等），返回层级符号列表及行号。',
                    goto_definition: '跳转到符号定义位置并返回完整定义代码（含行号）。',
                    find_references: '查找符号在代码库中的所有引用位置及上下文。',
                    generate_image: '使用 AI 模型生成图片。支持单张和批量生成模式，生成图片为实色背景。',
                    resize_image: '将图片缩放到指定目标尺寸，使用拉伸填充模式（不保持宽高比）。',
                    crop_image: '使用归一化坐标 (0-1000) 裁切图片，自动转换为实际像素坐标。',
                    rotate_image: '旋转图片到任意角度，正角度顺时针，负角度逆时针。',
                    remove_background: '去除图片背景生成透明 PNG。使用 AI 生成遮罩后去除背景。',
                    todo_write: '创建或替换当前对话的 TODO 列表，用于初始化任务清单。',
                    todo_update: '增量更新 TODO 列表的状态和内容，无需重写整个列表。',
                    create_design: '创建 Markdown 设计文档。仅创建设计，不创建计划或实现代码。',
                    update_design: '更新已有的 Markdown 设计文档。',
                    create_plan: '创建 Markdown 计划文档（含 TODO 清单）。仅创建计划，不执行。',
                    update_plan: '更新计划文档，支持修订模式和进度同步模式。',
                    create_progress: '创建项目进度文档并初始化状态记录。',
                    update_progress: '更新项目进度文档的摘要、TODO、风险等信息。',
                    record_progress_milestone: '向项目进度文档记录一个里程碑节点。',
                    validate_progress_document: '校验项目进度文档的元数据、结构和基本约束。',
                    create_review: '创建 Markdown 审查文档，用于代码审查场景。',
                    record_review_milestone: '向审查文档追加一个里程碑并更新结构化摘要。',
                    finalize_review: '完成审查文档，规范化结构并更新最终审查摘要。',
                    validate_review_document: '校验审查文档的格式、元数据和结构完整性。',
                    reopen_review: '重新打开已完成的审查文档以继续记录里程碑。',
                    compare_review_documents: '比较两个审查文档，返回问题差异和统计变化。',
                    show_windows_notification: '显示 Windows 系统通知，用于长任务完成或需要用户操作时提醒。',
                    memory_wake: '唤醒永久记忆，在会话开始时获取记忆摘要。',
                    memory_note: '记录一条永久记忆，用于保存重要信息和约定。',
                    memory_recall: '搜索全部永久记忆，支持正则表达式匹配。',
                    memory_compress: '执行待处理的记忆压缩合并，优化记忆存储。',
                    memory_zoom: '展开记忆树节点查看详细内容。',
                    memory_forget: '丢弃错误的记忆树摘要；或删除单条/闭区间原始记忆（如 "5" 删单条、"1,3" 删 1 到 3）。',
                    memory_config: '查看或修改永久记忆系统的配置参数。',
                    insert_code: '在指定行前插入代码，可用「最后一行 + 1」追加到文件末尾。',
                    delete_code: '删除文件中指定行范围内的代码。',
                    read_skill: '读取技能的内容和说明。',
                    toggle_skills: '启用或禁用技能，控制后续请求使用的知识模块。',
                    subagents: '派生子代理执行任务，支持传入提示词和上下文。',
                    agent_send_message: '向当前对话中的另一个代理（子代理）或主会话（主模型）异步发送消息。寻址方式二选一：targetRunId（当前对话中活跃的子代理运行 ID）或 targetAgentName（"main" 表示主会话）。同一线程回复超过 5 跳后投递被拒绝（防循环）；发送方身份自动识别，无法冒充。',
                    get_activity_stats: '查询用户的 IDE 使用时间统计：每日使用时长、最近作息（24 小时热力）与连续工作时长。用于了解用户的工作休息节奏、检测长时间连续工作会话，或查看用户当前是否活跃。数据仅含时间戳，不含用户内容；返回时间为本地时间。',
                },
            },
            tokenCountSettings: {
                description: '配置用于精确计算 Token 数量的 API。启用后，将在发送请求前调用对应渠道的 Token 计数 API 来获取准确的 Token 数量，用于更精准的上下文管理。',
                hint: '如果未配置或 API 调用失败，将回退到估算方法。',
                enableChannel: '启用此渠道的 Token 计数',
                baseUrl: 'API URL',
                apiKey: 'API Key',
                apiKeyPlaceholder: '输入 API Key',
                model: '模型名称',
                geminiUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}',
                geminiUrlHint: '使用 {model} 和 {key} 作为占位符',
                geminiModelPlaceholder: 'gemini-2.5-pro',
                anthropicUrlPlaceholder: 'https://api.anthropic.com/v1/messages/count_tokens',
                anthropicModelPlaceholder: 'claude-sonnet-4-5',
                comingSoon: '即将推出',
                customApi: '自定义 API',
                openaiDocTitle: 'OpenAI 兼容 API 接口',
                openaiDocDesc: 'OpenAI 官方未提供独立的 Token 计数 API。如果您有自建或第三方兼容的 Token 计数服务，可以在此配置。',
                openaiUrlPlaceholder: 'https://your-api.example.com/count-tokens',
                openaiUrlHint: '您的自定义 Token 计数 API 端点',
                openaiModelPlaceholder: 'gpt-4o',
                apiDocumentation: 'API 接口规范',
                requestExample: '请求示例',
                requestBody: '// 请求体',
                responseFormat: '// 响应格式',
                openaiDocNote: '您的 API 需要返回包含 total_tokens 字段的 JSON 响应。请求体使用 OpenAI Messages 格式。',
                saveSuccess: '配置已保存',
                saveFailed: '保存失败'
            },
            soundSettings: {
                overview: {
                    title: '本页说明',
                    description: '本页同时管理 Webview 声音提示和 Windows Agent 停止系统通知。下方内容按功能分区，便于分别调整。'
                },
                sections: {
                    sound: { title: '声音提示', description: '配置 Webview 内的提示音，包括启用、音量、事件、音效文件与测试播放。' },
                    windowsNotification: { title: 'Windows Agent 停止系统通知', description: '配置 Agent 停止后的 Windows 系统通知、模板与预览。' }
                },
                enabled: {
                    title: '启用声音提醒',
                    description: '在特定事件发生时播放提示音。此开关只影响声音提示，不影响 Windows 系统通知。',
                    label: '启用'
                },
                volume: {
                    title: '音量',
                    description: '调整提示音音量（0-100）'
                },
                cooldown: {
                    title: '最小间隔',
                    description: '限制提示音的最小播放间隔，避免短时间内连续播放'
                },
                cues: {
                    title: '事件类型',
                    description: '选择需要播放提示音的事件。主代理（主对话）与子代理（SubAgent）的事件可分别控制。',
                    main: '主代理',
                    subagent: '子代理',
                    warning: '警告（Warning）',
                    error: '错误（Error）',
                    taskComplete: '任务完成',
                    taskError: '任务失败'
                },
                assets: {
                    title: '自定义音效',
                    description: '为各事件导入本地音频文件，用于覆盖默认音效（导入后需点击保存，建议使用短音效；单个文件最大 {size}）',
                    none: '未选择',
                    choose: '选择文件',
                    clear: '清除',
                    importSuccess: '已导入：{name}',
                    clearSuccess: '已清除',
                    fileTooLarge: '文件过大，最大 {size}',
                    invalidFile: '无效的音频文件'
                },
                test: {
                    title: '测试播放',
                    description: '用于解锁浏览器音频策略并试听提示音',
                    warning: '试听：警告',
                    error: '试听：错误',
                    taskComplete: '试听：任务完成',
                    taskError: '试听：任务失败'
                },
                windowsAgentStopNotification: {
                    title: 'Windows Agent 停止系统通知',
                    description: '仅在 Windows 生效。通知只用于 Agent 停止场景。当前阶段会显示当前窗口的可识别标题，并按模板生成通知文案。',
                    optionsTitle: '通知开关与规则',
                    enabled: '启用 Windows 系统通知',
                    onlyWhenWindowNotFocused: '仅在当前窗口不在前台时通知',
                    rawTextHint: '通知标题和正文由扩展按模板生成，不直接显示 Agent 原始文本。',
                    bestEffortClickHint: '点击通知仍为尽力而为，不作为当前阶段的精确窗口回跳保证。',
                    casesTitle: '通知场景',
                    cases: {
                        error: '失败时通知',
                        awaitingUserAction: '需要用户动作时通知',
                        continueRequired: '需要继续时通知'
                    },
                    templates: {
                        title: '通知模板',
                        description: '模板只支持扩展可控变量，用于生成通知标题和正文。',
                        titleTemplate: '标题模板',
                        errorBodyTemplate: '失败正文模板',
                        awaitingUserActionBodyTemplate: '等待用户动作正文模板',
                        continueRequiredBodyTemplate: '等待继续正文模板',
                        variables: '可用变量',
                        variablesHint: '可用变量：{appName}、{windowTitle}、{actionLabel}、{reasonLabel}'
                    },
                    preview: {
                        title: '通知预览',
                        description: '预览会使用当前编辑中的模板和当前窗口标题，由宿主渲染最终通知。',
                        error: '预览失败通知',
                        awaitingUserAction: '预览等待用户动作通知',
                        continueRequired: '预览等待继续通知'
                    }
                },
                testBlocked: '声音被浏览器策略阻止，请点击一次“试听”按钮解锁（或检查 VS Code 音频设置）',
                testPlayed: '已播放',
                testFailed: '播放失败（可能被浏览器策略阻止）',
                saveSuccess: '保存成功',
                saveFailed: '保存失败'
            },
            appearanceSettings: {
                loadingText: {
                    title: '流式 Loading 文本',
                    description: '在 AI 流式输出时，消息底部的逐字波动指示器显示的文本。',
                    placeholder: '例如：思考中…',
                    defaultHint: '留空使用默认值：{text}'
                },
                selectionContext: {
                    title: '选中内容入口',
                    description: '统一控制“添加选中内容到输入框”是否显示在选中文本悬浮和长按 Ctrl / 代码操作中。'
                },
                smoothStreaming: {
                    title: '流式平滑输出',
                    description: '把突发的流式输出抹成匀速打字效果（关闭 = 原始逐块输出；档位越靠后延迟越高、越丝滑）。',
                    off: '关闭',
                    smooth: '灵敏',
                    balanced: '标准',
                    silky: '丝滑'
                },
                tpsBar: {
                    title: 'TPS 实时可视化条',
                    description: '在输入区底部显示实时 tokens/秒 曲线。隐藏后停止采样，重新开启后从当前流重新统计。'
                },
                splash: {
                    title: '开屏动画',
                    description: '启动时播放 Gray logo 描线开场动画。关闭后直接进入主界面。'
                },
                wallpaper: {
                    title: '桌面背景图',
                    description: '选择一张本地图片作为应用窗口背景（支持 PNG/JPG/GIF/WebP/BMP，最大 10MB）。',
                    pick: '选择图片',
                    remove: '移除背景图',
                    none: '未设置背景图',
                    opacity: '图片不透明度',
                    opacityHint: '图片不透明度作用于图片本身，文字与界面保持清晰；0 等于不显示，100 为完全遮挡。',
                    pickFailed: '加载背景图失败，请换一张图片重试'
                },
                saveSuccess: '保存成功',
                saveFailed: '保存失败'
            },
            storageSettings: {
                title: '存储路径',
                description: '配置对话历史、存档点等数据的存储位置',
                currentPath: '当前生效路径',
                customPath: '存储路径',
                customPathPlaceholder: '输入自定义存储路径...',
                customPathHint: '留空则使用默认路径（扩展存储目录）',
                browse: '浏览',
                apply: '应用',
                reset: '重置为默认',
                openInExplorer: '打开目录',
                openInExplorerTitle: '在文件资源管理器中打开当前存储目录',
                migrate: '迁移数据',
                migrateHint: '将现有数据迁移到新路径',
                migrating: '迁移中...',
                validating: '验证中...',
                validation: {
                    valid: '路径有效',
                    invalid: '路径无效',
                    checking: '检查中...'
                },
                dialog: {
                    migrateTitle: '确认迁移数据',
                    migrateMessage: '是否将现有数据迁移到新路径？这将复制所有对话历史和存档点。',
                    migrateWarning: '迁移过程中请勿关闭窗口',
                    confirm: '确认迁移',
                    cancel: '取消'
                },
                notifications: {
                    pathUpdated: '存储路径已更新',
                    pathReset: '存储路径已重置为默认',
                    alreadyDefault: '当前已是默认路径，无需重置',
                    alreadyDefaultTitle: '当前已是默认路径',
                    applyEmptyHint: '请先选择或输入一个存储路径',
                    migrationSuccess: '数据迁移完成，请重新加载窗口以使更改生效',
                    migrationFailed: '数据迁移失败: {error}',
                    validationFailed: '路径验证失败: {error}',
                    openInExplorerFailed: '打开存储目录失败: {error}'
                },
                reloadWindow: '重新加载窗口'
            }
        },

        backgroundTasks: {
            running: '运行中',
            completed: '已完成',
            failed: '失败',
            cancelled: '已取消',
            cancel: '取消任务',
            dismiss: '清除',
            dismissAllCompleted: '清除已完成',
            dismissAllCompletedTitle: '一键清除所有已完成的后台任务（未汇报结果的任务会弹出确认）',
            dismissAllConfirmTitle: '清除已完成任务？',
            dismissAllConfirmMessage: '{count} 个任务的结果尚未汇报给模型，清除后模型将收不到这些结果。确定清除？',
            dismissAllConfirmAction: '仍要清除',
            pendingReport: '结果待汇报给模型',
            outputTitle: '命令输出',
            noOutput: '暂无输出',
            viewCollapsed: '折叠',
            viewMedium: '中展开（滚动查看）',
            viewExpanded: '完全展开'
        },
        subagents: {
            monitor: {
                title: 'SubAgent Monitor',
                subtitle: '以聊天窗口形式展示 SubAgent 的 System、Context、Prompt、AI 输出、思维过程和工具调用。',
                runCount: '{count} 个运行',
                closePanel: '关闭面板',
                empty: '暂无 SubAgent 子对话记录。',
                defaultAgentName: 'Sub-Agent',
                loadedCount: '已加载 {loaded} / {total} 条记录',
                loadOlder: '加载更早消息',
                loadingOlder: '加载中…',
                pause: '暂停',
                resume: '继续',
                exit: '退出并让主工具失败',
                retrying: '自动重试 {attempt}/{maxAttempts}',
                retrySuccess: '自动重试成功',
                retryFailed: '自动重试失败：{error}',
                readOnly: '历史运行 · 仅可查看',
                controlUnavailable: '该运行已不在可控制状态，操作未生效',
                status: {
                    queued: '排队中',
                    running: '运行中',
                    paused: '已暂停',
                    awaitingMonitorAction: '等待处理',
                    completed: '已完成',
                    failed: '失败',
                    cancelled: '已取消',
                    interrupted: '已中断'
                }
            }
        },
        diff: {
            title: '变更',
            fileCount: '{count} 个文件',
            close: '关闭面板',
            empty: '暂无变更记录',
            noChange: '该文件没有内容差异',
            accept: '接受',
            reject: '拒绝',
            acceptAll: '全部接受',
            rejectAll: '全部拒绝',
            actionFailed: '操作失败',
            viewNewContent: '查看新内容',
            syntaxIssues: '{count} 个语法问题',
            noSyntaxIssues: '未发现语法问题',
            roundLabel: '第 {round} 轮',
            allProcessed: '所有变更均已处理（历史变更仍可查看与比对）',
            clearHistory: '清空历史',
            status: {
                pending: '待处理',
                accepted: '已接受',
                rejected: '已拒绝'
            }
        },
        codeView: {
            title: '代码查看',
            close: '关闭面板',
            empty: '从左侧工作区文件树选择文件，或输入路径打开代码',
            pathPlaceholder: '输入文件路径（如 src/main.ts）后回车',
            open: '打开',
            recent: '最近打开...',
            refresh: '重新加载',
            memorySource: '内存内容',
            jumpToLine: '跳转行号',
            issuesFound: '发现 {count} 个语法问题',
            noIssues: '未发现语法问题（共 {lines} 行）',
            workspaceFiles: '工作区文件',
            noWorkspace: '未打开工作区文件夹（文件树不可用）',
            refreshTree: '刷新文件树',
            treeEmpty: '（空目录）',
            errors: {
                openFailed: '打开文件失败'
            }
        },
        channels: {
            common: {
                temperature: {
                    label: '温度 (Temperature)',
                    hint: '0.0 - 1.0, 默认 1.0',
                    toggleHint: '启用后此参数将发送到 API'
                },
                maxTokens: {
                    label: '最大输出Tokens',
                    placeholder: '4096',
                    toggleHint: '启用后此参数将发送到 API'
                },
                topP: {
                    label: 'Top-P',
                    hint: '0.0 - 1.0',
                    toggleHint: '启用后此参数将发送到 API'
                },
                topK: {
                    label: 'Top-K',
                    toggleHint: '启用后此参数将发送到 API'
                },
                thinking: {
                    title: '思考配置',
                    toggleHint: '启用后思考参数将发送到 API'
                },
                thinkingBackfill: {
                    title: '思考回传配置',
                    signatures: '发送思考签名',
                    signaturesHint: '回传推理上下文（含历史思考签名与摘要），保持多轮交互的思考衔接；关闭时不回传 reasoning 项，以兼容不支持 reasoning 输入类型的第三方端点',
                    content: '发送思考内容',
                    currentGroup: '当前轮次',
                    currentSignatures: '发送最新思考签名',
                    currentSignaturesHint: '保持当前步骤的思考衔接',
                    currentContent: '发送最新思考内容',
                    currentContentHint: '回传当前轮次的推理过程',
                    historyGroup: '历史回合',
                    historySignatures: '发送历史思考签名',
                    historySignaturesHint: '保持跨多轮交互的思考上下文',
                    historyContent: '发送历史思考内容',
                    historyContentHint: '让 AI 看到之前已完成回合的思考过程',
                    roundsLabel: '发送历史思考回合数',
                    roundsHint: '控制发送多少轮非最新回合的历史对话思考。-1 表示全部，0 表示不发送历史对话，正数 N 表示发送最近 N 轮（如 1 表示只发送倒数第二回合）'
                }
            },
            anthropic: {
                thinking: {
                    typeLabel: '思考模式',
                    typeAdaptive: '自适应 (Adaptive)',
                    typeEnabled: '手动 (Enabled)',
                    typeDisabled: '关闭 (Disabled)',
                    typeAdaptiveHint: 'Claude 自动决定思考深度，推荐用于 Opus 4.6+',
                    typeEnabledHint: '手动设置思考 Token 预算，适用于所有支持思考的模型',
                    typeDisabledHint: '不启用思考（请求显式携带 {"thinking":{"type":"disabled"}}）',
                    budgetLabel: '思考预算 (Budget Tokens)',
                    budgetPlaceholder: '10000',
                    budgetHint: '思考过程使用的最大 Token 数量，建议 5000-50000',
                    effortLabel: '思考努力级别 (Effort)',
                    effortUltra: '极端努力（最高档）',
                    effortMax: '最大努力',
                    effortXHigh: '极高努力（Opus 4.7+）',
                    effortHigh: '高努力（默认）',
                    effortMedium: '中等努力',
                    effortLow: '低努力',
                    effortCustom: '自定义（手动输入）',
                    effortCustomPlaceholder: '输入自定义 effort 值（如 max、ultra）',
                    effortHint: '控制 Claude 的思考深度，级别越高思考越深入但消耗更多 Token；选择 custom 可手动输入任意 effort 值',
                    displayLabel: '思考内容显示',
                    displayHint: 'Opus 4.7+ 默认隐藏思考内容。选择「摘要」可恢复可见的思维链输出',
                    displayOmitted: '隐藏',
                    displayOmittedHint: '不返回思考内容，仅保留签名用于后续对话（Opus 4.7+ 默认）',
                    displaySummarized: '摘要',
                    displaySummarizedHint: '返回思考过程摘要，可在聊天面板中查看模型的推理思路'
                },
                promptCaching: {
                    title: 'Prompt Caching',
                    enable: '启用 Prompt Caching（手动缓存断点）',
                    hint: '在 system、tools、messages 的关键内容块上自动添加缓存标记，利用 Anthropic 的 Prompt Caching 降低成本和延迟',
                    ttlLabel: '缓存保持时间',
                    ttlHint: '5 分钟：写入价格 1.25x | 1 小时：写入价格 2x（缓存读取均为 0.1x）',
                    ttl5m: '5 分钟',
                    ttl5mHint: '默认选项，每次缓存读取会刷新 TTL，适合频繁对话',
                    ttl1h: '1 小时',
                    ttl1hHint: '写入价格为 2x 基础输入价格，适合间歇性长对话',
                    keepAlive: '缓存保活（4 分 30 秒自动续期）',
                    keepAliveHint: '当流式请求超过 4 分 30 秒未完成时，自动发送 max_tokens=5 的保活请求以刷新缓存 TTL'
                },
                userId: {
                    title: '请求用户标识（metadata.user_id）',
                    enable: '启用后为每个请求注入稳定的 metadata.user_id',
                    hint: '基于对话 ID（子代理为运行 ID）生成哈希标识，让主会话与各子代理的请求在服务端按运行域区分，缓存互不混淆；不包含任何隐私信息'
                }
            },
            gemini: {
                maxImages: {
                    label: '上游请求最多图片数',
                    placeholder: '0 = 不限制',
                    toggleHint: '启用后，发送给 Gemini 的整个请求中最多保留指定数量的图片',
                    hint: '设为 0 则不限制。超过上限的旧图片会被移除，优先保留最新图片'
                },
                thinking: {
                    includeThoughts: '返回思考内容',
                    includeThoughtsHint: '开启：请求携带 {"thinkingConfig":{"includeThoughts":true}}；关闭（取消勾选）= 关闭思考，请求显式携带 {"thinkingConfig":{"includeThoughts":false}}——Gemini 缺省即思考，必须显式传递 false 才真正关闭',
                    mode: '思考强度模式',
                    modeHint: '默认: 使用 API 默认值 | 等级: 选择预设等级 | 预算: 自定义 token 数',
                    modeDefault: '默认',
                    modeLevel: '等级',
                    modeBudget: '预算',
                    levelLabel: '思考等级',
                    levelHint: 'minimal: 最少思考 | low: 较少思考 | medium: 中等 | high: 深度思考',
                    levelMinimal: '最少',
                    levelLow: '低',
                    levelMedium: '中',
                    levelHigh: '高',
                    budgetLabel: '思考预算 (Token)',
                    budgetPlaceholder: '1024',
                    budgetHint: '自定义思考过程允许使用的 token 数量'
                },
                thinkingBackfill: {
                    sendContentHint: '启用后，将发送历史对话中的思考内容（包括摘要），这可能会显著增加上下文长度'
                }
            },
            openai: {
                deepSeekUserId: {
                    title: 'DeepSeek user_id',
                    hint: '为 DeepSeek Chat Completions 请求发送顶层 user_id，用于按对话隔离 KVCache。仅在当前主聊天请求存在对话 ID 时生效；总结、子代理等内部请求默认不会发送。请只为 DeepSeek 渠道开启。',
                    toggleHint: '开启后基于当前对话 ID 生成稳定且不包含隐私信息的 user_id'
                },
                pdfAttachment: {
                    title: 'PDF 附件发送',
                    hint: '将 PDF 附件作为原生 file 内容块发送给 API。仅官方 OpenAI 端点及支持 file 类型的兼容端点可用，不支持的端点会返回 400 错误；请确认端点支持后再开启。',
                    toggleHint: '开启后 PDF 附件将以 file 内容块发送'
                },
                frequencyPenalty: {
                    label: '频率惩罚 (Frequency Penalty)',
                    hint: '-2.0 - 2.0',
                    toggleHint: '启用后此参数将发送到 API'
                },
                presencePenalty: {
                    label: '存在惩罚 (Presence Penalty)',
                    hint: '-2.0 - 2.0',
                    toggleHint: '启用后此参数将发送到 API'
                },
                thinking: {
                    effortLabel: '思考强度 (Effort)',
                    effortHint: 'none: 完全不传递思考参数（请求缺省该段，API 默认思考）| minimal: 最少 | low: 较少 | medium: 中等 | high: 较多 | xhigh: 极高 | max: 最大 | ultra: 极端 | custom: 自定义。关闭思考（Off）时请求强制携带 {"thinking":{"type":"disabled"}}，不传递任何 effort',
                    effortNone: '无',
                    effortMinimal: '最少',
                    effortLow: '低',
                    effortMedium: '中',
                    effortHigh: '高',
                    effortXHigh: '极高',
                    effortMax: '最大',
                    effortUltra: '极端',
                    effortCustom: '自定义',
                    effortCustomPlaceholder: '输入自定义 effort 值（如 max、ultra）',
                    summaryLabel: '输出详细程度 (Summary)',
                    summaryHint: 'auto: 自动选择 | concise: 简洁输出 | detailed: 详细输出',
                    summaryAuto: '自动',
                    summaryConcise: '简洁',
                    summaryDetailed: '详细'
                },
                thinkingBackfill: {
                    sendSignaturesHint: '启用后，将发送历史对话中的思考签名（OpenAI 暂不支持）。不建议开启，且发送的是非最新一轮对话的签名',
                    sendContentHint: '统一控制当前轮次与历史回合的 reasoning_content，避免同一条消息在后续请求中因回合身份变化而改写提示词前缀'
                }
            },
            'openai-responses': {
                maxOutputTokens: {
                    label: '最大输出 Tokens',
                    placeholder: '8192',
                    hint: '对应 API 的 max_output_tokens 参数'
                },
                thinking: {
                    effortLabel: '思考强度 (Effort)',
                    effortHint: 'none: 完全不传递思考参数（请求缺省该段，API 默认思考）| minimal: 最少 | low: 较少 | medium: 中等 | high: 较多 | xhigh: 极高 | max: 最大 | ultra: 极端 | custom: 自定义。关闭思考（Off）时请求强制携带 {"thinking":{"type":"disabled"}}，不传递任何 effort',
                    effortNone: '无 (none)',
                    effortMinimal: '最少 (minimal)',
                    effortLow: '低 (low)',
                    effortMedium: '中 (medium)',
                    effortHigh: '高 (high)',
                    effortXHigh: '极高 (xhigh)',
                    effortMax: '最大 (max)',
                    effortUltra: '极端 (ultra)',
                    effortCustom: '自定义 (custom)',
                    effortCustomPlaceholder: '输入自定义 effort 值（如 max、ultra）',
                    summaryLabel: '输出详细程度 (Summary)',
                    summaryHint: 'auto: 自动选择 | concise: 简洁输出 | detailed: 详细输出',
                    summaryAuto: '自动',
                    summaryConcise: '简洁',
                    summaryDetailed: '详细'
                },
                thinkingBackfill: {
                    sendSignaturesHint: '保持跨多轮交互的思考上下文',
                    sendContentHint: '启用后，将发送历史对话中的 reasoning_content，这将增加上下文长度'
                }
            },
            customBody: {
                hint: '添加自定义请求体字段，支持嵌套 JSON 覆盖',
                modeSimple: '简单模式',
                modeAdvanced: '复杂模式',
                keyPlaceholder: '键名 (如: extra_body)',
                valuePlaceholder: '值 (支持 JSON，如: {"key": "value"})',
                empty: '暂无自定义 Body 项',
                addItem: '添加项',
                jsonError: 'JSON 格式错误',
                jsonHint: '完整 JSON 格式，支持嵌套覆盖',
                jsonPlaceholder: '{\n  "extra_body": {\n    "google": {\n      "thinking_config": {\n        "include_thoughts": false\n      }\n    }\n  }\n}',
                enabled: '已启用',
                disabled: '已禁用',
                deleteTooltip: '删除'
            },
            customHeaders: {
                hint: '添加自定义 HTTP 请求标头，按照顺序发送到 API',
                keyPlaceholder: 'Header-Name',
                valuePlaceholder: 'Header Value',
                keyDuplicate: '键名重复',
                empty: '暂无自定义标头',
                addHeader: '添加标头',
                enabled: '已启用',
                disabled: '已禁用',
                deleteTooltip: '删除'
            },
            toolOptions: {
                cropImage: {
                    title: '裁切图片 (crop_image)',
                    useNormalizedCoords: '使用归一化坐标 (0-1000)',
                    enabledTitle: '启用时',
                    enabledNote: '适用于 Gemini 等使用归一化坐标的模型',
                    disabledTitle: '禁用时',
                    disabledNote: '模型需自行计算图片的实际像素坐标',
                    coordTopLeft: '= 左上角',
                    coordBottomRight: '= 右下角',
                    coordCenter: '= 中心点'
                }
            },
            tokenCountMethod: {
                title: 'Token 计数方式',
                label: '计数方式',
                placeholder: '选择计数方式',
                hint: '选择用于计算 token 数量的方式，影响上下文裁剪的精确度',
                options: {
                    channelDefault: '使用渠道默认',
                    gemini: 'Gemini API',
                    openaiCustom: '自定义 OpenAI 格式',
                    openaiCustomDesc: '使用自定义 API 端点',
                    openaiResponses: 'OpenAI Responses API',
                    anthropic: 'Anthropic API',
                    local: '本地估算',
                    localDesc: '约 4 字符 = 1 token'
                },
                defaultDesc: {
                    gemini: '默认使用 Gemini countTokens API',
                    anthropic: '默认使用 Anthropic count_tokens API',
                    openai: '默认使用本地估算（OpenAI 无官方接口）'
                },
                apiConfig: {
                    title: 'API 配置',
                    url: 'API URL',
                    urlHint: '留空则使用渠道的 URL',
                    apiKey: 'API Key',
                    apiKeyPlaceholder: '输入 API Key',
                    apiKeyHint: '留空则使用渠道的 API Key',
                    model: '模型',
                    modelHint: '用于 token 计数的模型名称'
                }
            }
        },

        tools: {
            executing: '执行中...',
            executed: '已执行',
            failed: '执行失败',
            cancelled: '已取消',
            approve: '批准',
            reject: '拒绝',
            autoExecuted: '自动执行',
            terminate: '终止',
            saveToPath: '保存到路径',
            openFile: '打开文件',
            openFolder: '打开文件夹',
            viewDetails: '查看详情',
            hideDetails: '隐藏详情',
            parameters: '参数',
            result: '结果',
            error: '错误',
            duration: '耗时',
            file: {
                readFile: '读取文件',
                writeFile: '写入文件',
                deleteFile: '删除文件',
                createDirectory: '创建目录',
                listFiles: '列出文件',
                applyDiff: '应用diff',
                filesRead: '已读取文件',
                filesWritten: '已写入文件',
                filesDeleted: '已删除文件',
                directoriesCreated: '已创建目录',
                changesApplied: '已应用更改',
                applyDiffPanel: {
                    title: '应用diff',
                    changes: '个更改',
                    diffApplied: '差异已应用',
                    pending: '待审阅',
                    accepted: '已接受',
                    rejected: '已拒绝',
                    partial: '部分接受',
                    rejectedBlock: '此块已被用户拒绝',
                    line: '起始行',
                    diffNumber: '#',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 行',
                    copied: '已复制',
                    copyNew: '复制新内容',
                    deletedLines: '删除',
                    addedLines: '新增',
                    userEdited: '用户已编辑',
                    userEditedContent: '用户修改后的内容'
                },
                createDirectoryPanel: {
                    title: '创建目录',
                    total: '共 {count} 个',
                    noDirectories: '没有要创建的目录',
                    success: '成功',
                    failed: '失败'
                },
                deleteFilePanel: {
                    title: '删除文件',
                    total: '共 {count} 个',
                    noFiles: '没有要删除的文件',
                    success: '成功',
                    failed: '失败'
                },
                listFilesPanel: {
                    title: '列出文件',
                    recursive: '递归',
                    totalStat: '{dirCount} 个目录, {folderCount} 个文件夹, {fileCount} 个文件',
                    copyAll: '复制全部列表',
                    copyList: '复制列表',
                    dirStat: '{folderCount} 文件夹, {fileCount} 文件',
                    lines: '{count} 行',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 个',
                    emptyDirectory: '目录为空'
                },
                readFilePanel: {
                    title: '读取文件',
                    total: '共 {count} 个',
                    lines: '{count} 行',
                    copied: '已复制',
                    copyContent: '复制内容',
                    binaryFile: '二进制文件',
                    unknownSize: '未知大小',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 行',
                    emptyFile: '文件为空'
                },
                writeFilePanel: {
                    title: '写入文件',
                    total: '共 {count} 个',
                    lines: '{count} 行',
                    copied: '已复制',
                    copyContent: '复制内容',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 行',
                    noContent: '无写入内容',
                    viewContent: '内容',
                    viewDiff: '差异',
                    loadingDiff: '加载差异中...',
                    actions: {
                        created: '新建',
                        modified: '修改',
                        unchanged: '未变',
                        write: '写入'
                    }
                }
            },
            lsp: {
                getSymbols: '获取符号',
                gotoDefinition: '跳转定义',
                findReferences: '查找引用',
                getSymbolsPanel: {
                    title: '文件符号',
                    totalFiles: '共 {count} 个文件',
                    totalSymbols: '共 {count} 个符号',
                    noSymbols: '未找到符号',
                    symbolCount: '{count} 个符号',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 个',
                    copyAll: '复制全部',
                    copied: '已复制'
                },
                gotoDefinitionPanel: {
                    title: '定义',
                    definitionFound: '找到定义',
                    noDefinition: '未找到定义',
                    lines: '{count} 行',
                    copyCode: '复制代码',
                    copied: '已复制'
                },
                findReferencesPanel: {
                    title: '引用',
                    totalReferences: '共 {count} 个引用',
                    totalFiles: '{count} 个文件',
                    noReferences: '未找到引用',
                    referencesInFile: '{count} 个引用',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 个'
                }
            },
            mcp: {
                mcpTool: 'MCP 工具',
                serverName: '服务器名称',
                toolName: '工具名称',
                mcpToolPanel: {
                    requestParams: '请求参数',
                    errorInfo: '错误信息',
                    responseResult: '响应结果',
                    imagePreview: '图片预览',
                    waitingResponse: '等待响应...'
                }
            },
            media: {
                generateImage: '生成图片',
                resizeImage: '缩放图片',
                cropImage: '裁切图片',
                rotateImage: '旋转图片',
                removeBackground: '去除背景',
                generating: '生成中...',
                processing: '处理中...',
                imagesGenerated: '已生成图片',
                saveImage: '保存图片',
                saveTo: '保存到',
                saved: '已保存',
                saveFailed: '保存失败',
                cropImagePanel: {
                    title: '裁切图片',
                    tasksFailed: '{count} 个任务失败',
                    cancel: '终止',
                    cancelCrop: '终止裁切',
                    status: {
                        needDependency: '需要依赖',
                        cancelled: '已取消',
                        failed: '失败',
                        success: '成功',
                        error: '错误',
                        processing: '处理中...',
                        waiting: '等待中'
                    },
                    checkingDependency: '检查依赖状态...',
                    dependencyMessage: '裁切功能需要 sharp 库来处理图像。',
                    batchCrop: '批量裁切 ({count})',
                    cropTask: '裁切任务',
                    coordsHint: '坐标范围 0-1000（归一化），自动转换为实际像素',
                    cancelledMessage: '用户已取消裁切操作',
                    resultTitle: '裁切结果 ({count} 张)',
                    original: '原始:',
                    cropped: '裁切后:',
                    cropResultN: '裁切结果 {n}',
                    saved: '已保存',
                    overwriteSave: '覆盖保存',
                    save: '保存',
                    openInEditor: '在编辑器中打开',
                    savePaths: '保存路径:',
                    croppingImages: '正在裁切图片...',
                    openFileFailed: '打开文件失败:',
                    saveFailed: '保存失败'
                },
                generateImagePanel: {
                    title: '图像生成',
                    cancel: '终止',
                    cancelGeneration: '终止生成',
                    status: {
                        needDependency: '需要依赖',
                        cancelled: '已取消',
                        failed: '失败',
                        success: '成功',
                        error: '错误',
                        generating: '生成中...',
                        waiting: '等待中'
                    },
                    batchTasks: '批量任务 ({count})',
                    generateTask: '生成任务',
                    outputPath: '输出路径',
                    aspectRatio: '宽高比',
                    imageSize: '图片尺寸',
                    referenceImages: '{count} 张参考',
                    cancelledMessage: '用户已取消图像生成',
                    tasksFailed: '{count} 个任务失败',
                    resultTitle: '生成结果 ({count} 张)',
                    saved: '已保存',
                    overwriteSave: '覆盖保存',
                    save: '保存',
                    openInEditor: '在编辑器中打开',
                    savePaths: '保存路径:',
                    generatingImages: '正在生成图像...',
                    openFileFailed: '打开文件失败:',
                    saveFailed: '保存失败'
                },
                removeBackgroundPanel: {
                    title: '抠图',
                    cancel: '终止',
                    cancelRemove: '终止抠图',
                    status: {
                        needDependency: '需要依赖',
                        cancelled: '已取消',
                        failed: '失败',
                        success: '成功',
                        error: '错误',
                        processing: '处理中...',
                        waiting: '等待中',
                        disabled: '已禁用'
                    },
                    checkingDependency: '检查依赖状态...',
                    dependencyMessage: '抠图功能需要 sharp 库来处理图像。',
                    batchTasks: '批量任务 ({count})',
                    removeTask: '抠图任务',
                    subjectDescription: '主体描述',
                    maskPath: '遮罩: {path}',
                    needSharp: {
                        title: '需要安装 sharp 库',
                        message: '已生成遮罩图，但需要安装 sharp 库才能完成完整抠图。',
                        installCmd: 'pnpm add sharp'
                    },
                    cancelledMessage: '用户已取消抠图操作',
                    tasksFailed: '{count} 个任务失败',
                    resultTitle: '处理结果 ({count} 张)',
                    maskImage: '遮罩图',
                    resultImage: '抠图结果 {n}',
                    saved: '已保存',
                    overwriteSave: '覆盖保存',
                    save: '保存',
                    openInEditor: '在编辑器中打开',
                    savePaths: '保存路径:',
                    processingImages: '正在处理图片...',
                    openFileFailed: '打开文件失败:',
                    saveFailed: '保存失败'
                },
                resizeImagePanel: {
                    title: '缩放图片',
                    tasksFailed: '{count} 个任务失败',
                    cancel: '终止',
                    cancelResize: '终止缩放',
                    status: {
                        needDependency: '需要依赖',
                        cancelled: '已取消',
                        failed: '失败',
                        success: '成功',
                        error: '错误',
                        processing: '处理中...',
                        waiting: '等待中'
                    },
                    checkingDependency: '检查依赖状态...',
                    dependencyMessage: '缩放功能需要 sharp 库来处理图像。',
                    batchResize: '批量缩放 ({count})',
                    resizeTask: '缩放任务',
                    sizeHint: '图片将拉伸填充到目标尺寸（不保持宽高比）',
                    cancelledMessage: '用户已取消缩放操作',
                    resultTitle: '缩放结果 ({count} 张)',
                    resizeResultN: '缩放结果 {n}',
                    dimensions: {
                        original: '原始:',
                        resized: '缩放后:'
                    },
                    saved: '已保存',
                    overwriteSave: '覆盖保存',
                    save: '保存',
                    openInEditor: '在编辑器中打开',
                    savePaths: '保存路径:',
                    resizingImages: '正在缩放图片...',
                    openFileFailed: '打开文件失败:',
                    saveFailed: '保存失败'
                },
                rotateImagePanel: {
                    title: '旋转图片',
                    tasksFailed: '{count} 个任务失败',
                    cancel: '终止',
                    cancelRotate: '终止旋转',
                    status: {
                        needDependency: '需要依赖',
                        cancelled: '已取消',
                        failed: '失败',
                        success: '成功',
                        error: '错误',
                        processing: '处理中...',
                        waiting: '等待中'
                    },
                    checkingDependency: '检查依赖状态...',
                    dependencyMessage: '旋转功能需要 sharp 库来处理图像。',
                    batchRotate: '批量旋转 ({count})',
                    rotateTask: '旋转任务',
                    angleHint: '正角度逆时针，负角度顺时针。PNG/WebP 填充透明，JPG 填充黑色',
                    angleFormat: {
                        counterclockwise: '逆时针',
                        clockwise: '顺时针'
                    },
                    cancelledMessage: '用户已取消旋转操作',
                    resultTitle: '旋转结果 ({count} 张)',
                    rotateResultN: '旋转结果 {n}',
                    dimensions: {
                        rotation: '旋转:',
                        size: '尺寸:'
                    },
                    saved: '已保存',
                    overwriteSave: '覆盖保存',
                    save: '保存',
                    openInEditor: '在编辑器中打开',
                    savePaths: '保存路径:',
                    rotatingImages: '正在旋转图片...',
                    openFileFailed: '打开文件失败:',
                    saveFailed: '保存失败'
                }
            },
            search: {
                findFiles: '查找文件',
                searchInFiles: '在文件中搜索',
                filesFound: '找到文件',
                matchesFound: '找到匹配',
                noResults: '无结果',
                findFilesPanel: {
                    title: '查找文件',
                    totalFiles: '共 {count} 个文件',
                    fileCount: '{count} 个文件',
                    lines: '{count} 行',
                    truncated: '已截断',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 个文件',
                    noFiles: '没有找到匹配的文件'
                },
                searchInFilesPanel: {
                    title: '搜索内容',
                    replaceTitle: '搜索替换',
                    regex: '正则',
                    matchCount: '{count} 个匹配',
                    fileCount: '{count} 个文件',
                    truncated: '已截断',
                    keywords: '关键词：',
                    replaceWith: '替换为：',
                    emptyString: '(空字符串)',
                    path: '路径：',
                    pattern: '模式：',
                    noResults: '没有找到匹配的内容',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 个匹配',
                    replacements: '已替换 {count} 处',
                    replacementsInFile: '{count} 处替换',
                    filesModified: '{count} 个文件',
                    viewMatches: '匹配项',
                    viewDiff: '差异',
                    loadingDiff: '加载差异中...',
                    omittedUnchangedLines: '… 已省略 {count} 行未变化内容 …'
                }
            },
            history: {
                historySearch: '历史搜索',
                searchHistory: '搜索历史',
                readHistory: '读取历史',
                readAll: '全部',
                panel: {
                    searchTitle: '搜索已总结历史',
                    readTitle: '读取已总结历史',
                    regex: '正则',
                    keywords: '关键词：',
                    lineRange: '行范围：',
                    lineCount: '{count} 行',
                    matchLineCount: '{count} 个匹配行',
                    blockCount: '{count} 个片段',
                    contextBlock: '片段 {index}',
                    match: '匹配',
                    noContent: '没有返回内容',
                    collapse: '收起',
                    expandRemaining: '展开剩余 {count} 行',
                    copyContent: '复制内容',
                    copied: '已复制'
                }
            },
            terminal: {
                executeCommand: '执行命令',
                command: '命令',
                output: '输出',
                exitCode: '退出码',
                running: '运行中',
                terminated: '已终止',
                terminateCommand: '终止命令',
                executeCommandPanel: {
                    title: '终端',
                    status: {
                        failed: '失败',
                        terminated: '已终止',
                        success: '成功',
                        exitCode: '退出码: {code}',
                        running: '运行中...',
                        pending: '等待中'
                    },
                    terminate: '终止',
                    terminateTooltip: '终止进程',
                    copyOutput: '复制输出',
                    copied: '已复制',
                    output: '输出',
                    truncatedInfo: '显示最后 {outputLines} 行 (共 {totalLines} 行)',
                    autoScroll: '自动滚动',
                    waitingOutput: '等待输出...',
                    noOutput: '没有输出',
                    executing: '命令执行中...'
                }
            },
            subagents: {
                title: '子代理',
                task: '任务',
                context: '上下文',
                completed: '执行完成',
                failed: '执行失败',
                executing: '正在执行...',
                partialResponse: '部分响应',
                background: '后台',
                steps: '步骤 {count}',
                noTools: '未调用工具',
                toolsUsed: '工具: {tools}'
            }
        }
    },

    app: {
        retryPanel: {
            title: '请求失败，正在自动重试',
            cancelTooltip: '取消重试',
            defaultError: '请求失败'
        },
        autoSummaryPanel: {
            summarizing: '自动总结中…',
            manualSummarizing: '手动总结中…',
            cancelTooltip: '取消总结'
        },
        agentStopNotification: {
            errorTitle: 'GrayCode Agent 已停止',
            errorMessage: '当前对话执行失败。点击通知可回到对应窗口继续处理。',
            errorMessageWithConversation: '对话“{title}”执行失败。点击通知可回到对应窗口继续处理。',
            awaitingUserActionTitle: 'GrayCode 等待您的操作',
            awaitingUserActionMessage: '当前对话需要您点击“{action}”。点击通知可回到对应窗口继续处理。',
            awaitingUserActionMessageWithConversation: '对话“{title}”需要您点击“{action}”。点击通知可回到对应窗口继续处理。',
            continueRequiredTitle: 'GrayCode 等待继续',
            continueRequiredMessage: '当前对话需要继续。点击通知可回到对应窗口继续处理。',
            continueRequiredMessageWithConversation: '对话“{title}”需要继续。点击通知可回到对应窗口继续处理。',
            actions: {
                generatePlan: '生成计划',
                executePlan: '执行计划',
                continue: '继续',
                genericConfirmation: '回到 GrayCode 继续'
            }
        }
    },

    errors: {
        networkError: '网络错误，请检查网络连接',
        apiError: 'API 请求失败',
        timeout: '请求超时',
        invalidConfig: '配置无效',
        fileNotFound: '文件未找到',
        permissionDenied: '权限被拒绝',
        unknown: '未知错误',
        connectionFailed: '连接失败',
        authFailed: '认证失败',
        rateLimited: '请求过于频繁',
        serverError: '服务器错误',
        invalidResponse: '响应格式无效',
        cancelled: '操作已取消'
    },

    composables: {
        useAttachments: {
            errors: {
                validationFailed: '附件验证失败',
                createThumbnailFailed: '创建缩略图失败',
                createVideoThumbnailFailed: '创建视频缩略图失败',
                readFileFailed: '读取文件失败',
                loadVideoFailed: '加载视频失败',
                readResultNotString: '读取结果不是字符串'
            }
        }
    },

    stores: {
        terminalStore: {
            errors: {
                killTerminalFailed: '杀死终端失败',
                refreshOutputFailed: '刷新终端输出失败'
            }
        },
        chatStore: {
            defaultTitle: '无标题',
            errors: {
                loadConversationsFailed: '加载对话列表失败',
                createConversationFailed: '创建对话失败',
                deleteConversationFailed: '删除对话失败',
                sendMessageFailed: '发送消息失败',
                streamError: '流式响应错误',
                loadHistoryFailed: '加载历史记录失败',
                retryFailed: '重试失败',
                editRetryFailed: '编辑重试失败',
                deleteFailed: '删除失败',
                noConversationSelected: '未选择对话',
                unknownError: '未知错误',
                restoreFailed: '恢复失败',
                restoreCheckpointFailed: '恢复检查点失败',
                restoreRetryFailed: '回档并重试失败',
                restoreDeleteFailed: '回档并删除失败',
                noConfigSelected: '未选择配置',
                summarizeFailed: '总结失败',
                restoreEditFailed: '回档并编辑失败',
                messageChanged: '消息已发生变化，请刷新历史后重试'
            },
            relativeTime: {
                justNow: '刚刚',
                minutesAgo: '{minutes}分钟前',
                hoursAgo: '{hours}小时前',
                daysAgo: '{days}天前'
            }
        }
    },

    utils: {
        tools: {
            noFile: '无文件',
            changes: '{count} 个更改',
            cwdLabel: '目录: {cwd}',
            recursiveSuffix: ' (递归)',
            dirCount: '{count} 个目录',
            searchModeSearch: '搜索内容',
            searchModeReplace: '搜索替换'
        }
    }
};

export default zhCN;
