/**
 * GrayCode Backend - 日本語言語パック
 */

import type { BackendLanguageMessages } from '../types';

const ja: BackendLanguageMessages = {
    desktop: {
        responsesNative: {
            "websocket": {
                "title": "ネイティブ WebSocket と生成中の追加メッセージ",
                "hint": "初期状態では無効です。デスクトップと Web ではタスク内の Responses 接続を再利用し、生成中の追加メッセージを送信します。モデルとゲートウェイが WebSocket と steering に対応している必要があります。"
            },
            "asyncTools": {
                "title": "ネイティブ非同期ツール",
                "hint": "初期状態では無効です。読み取り、コマンド、ブラウザのツールを最大 4 個実行しながら、モデルは作業を続けられます。必要なタスクだけを待ち、結果は元の呼び出しに返します。バックグラウンドのタスク管理とタブ内の操作順序、権限・承認ルールを維持します。上流の async 対応が必要です。"
            }
        },
        "discardQuit": "変更を破棄して終了",
        "saveAllProgress": "ファイルと設定を保存中…",
        "saveAllDetail": "すべてのファイルと設定を保存して終了するか、未保存の変更を破棄できます。終了するとバックグラウンドの作業と接続は停止します。",
            "saveAllQuit": "すべて保存して終了",
            "saveAllUnavailable": "エディターを利用できないため、終了しません。",
            "saveAllIncomplete": "未保存の変更を確認して再試行してください。",
            "shell": {
                "documentRecoveryConflict": "ファイルが変更されました。編集中の内容は保持されています。内容をコピーしてからファイルを開き直し、変更を統合してください。",
                "connectionTimeout": "接続がタイムアウトしました。ネットワークを確認して再試行してください。",
                "initializationFailed": "ワークスペースの初期化に失敗しました",
                "retryInitialization": "接続を再試行",
                "chatInitializationFailed": "チャット画面の準備が完了していません。接続を確認して再読み込みしてください。",
                "retryChat": "チャット画面を再読み込み",
                "reviewRecords": "{count} 件の変更記録",
                "reviewPendingGroup": "未処理",
                "reviewProcessedGroup": "処理済み",
                "reviewPendingStatus": "レビュー待ち",
                "reviewAcceptedStatus": "承認済み",
                "reviewRejectedStatus": "拒否済み",
                "reviewCancelledStatus": "キャンセル済み",
                "reviewHideList": "変更一覧を閉じる",
                "reviewToggleList": "変更一覧を切り替える",
                "reviewTitle": "レビュー",
                "reviewLoading": "変更を読み込み中…",
                "reviewRefresh": "変更を更新",
                "reviewEmptyTitle": "レビューする変更はありません",
                "reviewEmptyDetail": "AI が提案したファイルの変更がここに表示されます。",
                "reviewTargetMissing": "指定した変更はこの一覧にありません",
                "reviewTargetMissingDetail": "一覧を更新するか、別の変更を選択してください。",
                "reviewReject": "拒否",
                "reviewAccept": "承認",
                "reviewProcessing": "処理中…",
                "awaitingInput": "回答待ち",
                "awaitingApproval": "確認待ち",
                "chat": "チャット",
                "chatDetail": "会話と日常の作業",
                "code": "コード",
                "codeDetail": "プロジェクトの編集と開発作業",
                "character": "キャラクター",
                "characterDetail": "キャラクター設定と物語の会話",
                "workspace": "ワークスペース",
                "workbench": "ワークベンチ",
                "backToChat": "チャットに戻る",
                "openPanel": "サイドパネルを開く",
                "closePanel": "サイドパネルを隠す",
                "library": "ライブラリ",
                "characterSetup": "キャラクター設定",
                "addWorkspace": "ワークスペースを追加",
                "chooseFolder": "フォルダーを選択",
                "connecting": "ローカルコアに接続中…",
                "close": "閉じる",
                "copyError": "機密情報を除いた診断をコピー",
                "copied": "コピーしました",
                "copyFailed": "コピーに失敗しました",
                "previewImageTools": "画像ツール",
                "previewImageMenu": "画像の操作",
                "previewZoomOut": "縮小",
                "previewZoomIn": "拡大",
                "previewZoomPercent": "現在の表示倍率",
                "previewFit": "フィット",
                "previewFitToWindow": "ウィンドウに合わせる",
                "previewActualSize": "元のサイズ（100%）",
                "previewRotateLeft": "左に回転",
                "previewRotateRight": "右に回転",
                "previewSaveImage": "元の画像を保存",
                "previewSaveAttachment": "添付ファイルを保存",
                "previewCopyImage": "画像をコピー",
                "previewCopyingImage": "コピー中…",
                "previewCopyUnavailable": "このブラウザでは画像をコピーできません。HTTPS で開いてクリップボードへのアクセスを許可するか、元の画像を保存してください。",
                "previewCopyFailed": "画像をコピーできませんでした。クリップボードの権限を確認して再試行するか、元の画像を保存してください。",
                "previewImageLoadFailed": "画像を表示できません。元の画像を保存し、ローカルアプリで開いてください。",
                "previewDoubleClick": "ダブルクリックで元のサイズ（100%）とウィンドウへのフィットを切り替え",
                "previewPrevious": "前の画像",
                "previewNext": "次の画像",
                "previewPdf": "PDF プレビュー",
                "previewUnsupported": "保存してローカルアプリで開くことができます。",
                "startupFailed": "GrayCode を起動できませんでした",
                "startupDetail": "元のデータは保持されます。再試行するか、別のデータフォルダーで起動し、設定から復元できます。",
                "retry": "再試行",
                "openLogs": "ログフォルダーを開く",
                "chooseData": "別のデータフォルダーで起動"
            },
        installerArtwork: {
            tagline: "ローカル優先の AI ワークスペース",
            intro: "対話と創作で、自分の作業空間を。",
            progress: "ワークスペースをインストール中"
        },
        "trayOpen": "GrayCode を開く",
        "trayWaiting": "GrayCode · バックグラウンドタスク完了後に終了",
        "trayResident": "GrayCode · バックグラウンド常駐を選択済み",
        settingsDraft: {
            cleanHint: "すべての分類で設定の下書きを共有します。",
            dirtyHint: "未保存の変更があります。分類を切り替えても下書きは保持されます。",
            discardAll: "すべて破棄",
            saveAll: "すべて保存",
            processing: "処理中…",
            unsavedTitle: "未保存の設定",
            unsavedDescription: "すべての分類の変更を保存するか、下書きを破棄してチャットに戻れます。",
            continueEditing: "編集を続ける",
            discardAndReturn: "破棄して戻る",
            saving: "保存中…",
            saveAndReturn: "保存して戻る",
        },
        settingsGroups: {
            models: "モデルとプロンプト",
            execution: "実行と権限",
            context: "会話とメモリ",
            connections: "連携と接続",
            application: "アプリ",
        },
        buildDetails: "ビルドとアプリの情報",
        cancelFailed: "キャンセルに失敗しました。再試行してください。",
        "quitTitle": "GrayCode を終了",
        "quitMessage": "作業を終了しますか？",
        "quitDetail": "終了するとバックグラウンドのタスクと接続が停止し、未保存の変更は破棄されます。保存済みの会話と設定は保持されます。",
        "continueWorking": "作業を続ける",
        "background": "バックグラウンドで実行",
        "quit": "アプリを終了",
        "unsavedFiles": "未保存のファイルが {count} 件あります",
        "unsavedSettings": "設定に未保存の変更があります",
        "unsavedRemoteFiles": "リモートクライアントに未保存のファイル下書きが {count} 件あります",
        "unsavedRemoteSettings": "リモートクライアントに未保存の設定の下書きがあります",
        "remoteDraftQuitDetail": "元のリモート画面で下書きを保存してから終了してください。切断した下書きは再接続時に復元できます。「破棄して終了」を選ぶと、これらの未保存の下書きも破棄されます。",
        "activeTasks": "バックグラウンドのタスクまたは接続が動作中です",
        "backgroundDetail": "バックグラウンド実行ではトレイに常駐し、ウィンドウと未保存の変更が保持されます。トレイから再び開けます。",
        "closingTitle": "GrayCode を終了しています",
        "closingMessage": "安全に終了しています",
        "closingDetail": "後処理が完了するとアプリは自動的に終了します。",
        "closingBackups": "バックアップ処理を終了しています",
        "closingWindows": "デスクトップペットとブラウザーを閉じています",
        "closingCore": "タスクと接続を停止し、データを保存しています",
        "closingUpdate": "アップデーターを起動しています",
        "installerTitle": "インストールと復元",
        "restart": "確認して再起動",
        "retry": "再試行",
        "terminalUnavailable": "端末の出力を復元できませんでした。入力を停止しています。",
        "loadingPanel": "パネルを開いています…",
        "loadPanelFailed": "パネルを読み込めませんでした。",
        "close": "閉じる",
        "updateTitle": "インストールと更新",
        "currentVersion": "現在のバージョン",
        "installedKind": "インストール版",
        "portableKind": "ポータブル版",
        "portableHint": "Windows インストール版を導入すると、ここから更新や以前のバージョンへの復元ができます。既存のデータディレクトリも使用できます。",
        "checkUpdate": "更新を確認",
        "downloadUpdate": "更新をダウンロード",
        "offlineUpdate": "オフライン更新を選択",
        "releasePage": "リリースページを開く",
        "checking": "更新を確認しています",
        "downloading": "ダウンロードと検証中",
        "backup": "現在のデータをバックアップ中",
        "preparing": "更新を準備中",
        "readyTitle": "更新の準備ができました",
        "readyDescription": "バージョン {version} のダウンロードと検証が完了しました。インストール前に現在のアプリとデータのバックアップを保存します。",
        "restartInstall": "再起動してインストール",
        "installLater": "後でインストール",
        "restorePoint": "復元ポイント",
        "recoveryHint": "以前のバージョンと更新前のデータを復元し、現在のデータを別途バックアップします。復元後はバックグラウンドサービスを手動で再接続してください。",
        "recoveryRescue": "インストールの中断で起動できない場合、復元フォルダーの Restore-GrayCode.cmd を実行してアプリを修復できます。",
        "rollback": "以前のバージョンとデータを復元",
        "openRecovery": "復元フォルダーを開く",
        "transitionFailed": "前回のバージョン切り替えが完了していません。現在は {version} が動作中です。再インストールするか、復元フォルダーを開いてください。",
        "alreadyCurrent": "新しいバージョンはありません。",
        "downloaded": "バージョン {version} の準備ができました。変更を保存してから再起動してください。",
        "restarting": "バックグラウンドサービスを停止し、インストール後にアプリを再起動します。",
        "available": "バージョン {version} が見つかりました。",
        "loadingUpdate": "インストール状態を読み込み中…",
        "unknownDate": "日時不明",
        "updateReadyDescription": "更新のダウンロードと検証が完了しました。変更を保存してから再起動してください。インストール前に現在のデータをバックアップします。",
        "applying": "再起動とインストールを準備中…",
        "retryUpdate": "更新を再試行"
    },
    modules: {
        diff: {
            previewNotFound: "変更プレビューが見つかりません。現在のタスクを更新してください。",
            previewAmbiguous: "変更プレビューを特定できません。現在のタスクを更新してください。",
        },
        chatgpt: {
            storageUnavailable: "暗号化された認証情報ストレージがありません。デスクトップ版を使うか、--key-env でサーバーの暗号化キーを設定してください。",
            invalidResponse: "ChatGPT 認証応答の形式が無効です。",
            missingScopes: "ChatGPT 応答に許可されたスコープがありません。",
            invalidTokens: "ChatGPT 応答に有効なトークンや有効期限がありません。",
            unsupportedTokenType: "ChatGPT が未対応のトークン形式を返しました。",
            invalidIdentityToken: "ChatGPT ID トークンが無効です。",
            identityMismatch: "ChatGPT の本人確認または今回のログイン検証に失敗しました。",
            accountMismatch: "返された ChatGPT アカウントは選択したアカウントと一致しません。",
            missingIdentityToken: "ChatGPT 認証応答に ID トークンがありません。",
            missingIdentity: "ChatGPT 認証応答に本人情報がありません。",
            missingRefreshToken: "ChatGPT 応答に更新トークンがありません。",
            invalidCredentials: "保存された ChatGPT 認証情報が無効です。再ログインしてください。",
            callbackNotFound: "このログインコールバックが見つかりません。",
            callbackSuccess: "ChatGPT 認証が完了しました。GrayCode に戻ってください。",
            callbackFailed: "ログインを完了できませんでした。GrayCode に戻って状態を確認するか、再ログインしてください。",
            loginTimeout: "ChatGPT ログインがタイムアウトしました。再試行してください。",
            callbackMismatch: "コールバックは今回の認証と一致しません。",
            loginEnded: "このログインコールバックは処理済みまたは終了しています。",
            consentDeclined: "ChatGPT 認証が未完了です。再ログインしてプランの使用を許可してください。",
            invalidCallback: "ChatGPT コールバックに有効な認証コードやクライアント登録がありません。",
            accountMissing: "選択した ChatGPT アカウントがありません。",
            loginMissing: "完了待ちの ChatGPT ログインがありません。",
            signInRequired: "チャネル設定で ChatGPT にログインして、GrayCode にプランの使用を許可してください。",
            accountChanged: "ChatGPT アカウントが切り替えられたかログアウトしました。再度リクエストを送信してください。",
            refreshPermissionMissing: "更新した ChatGPT 認証にプランの利用権限がありません。再ログインしてください。",
            refreshNotReady: "ChatGPT セッションはまだ更新可能な時刻に達していません。少し待ってから再試行してください。",
            signInExpired: "ChatGPT ログインの有効期限が切れました。チャネル設定で再ログインしてください。",
            unsupportedHost: "このホストは ChatGPT プランのログインに対応していません。",
            channelRequired: "OpenAI Responses チャネルを選択してください。",
            unknownOperation: "不明な ChatGPT 認証操作です。",
            modelsSignInRequired: "まず ChatGPT にログインしてプランの使用を許可してください。",
            invalidModels: "ChatGPT モデル一覧の形式が無効です。",
            authLabel: "認証方式",
            apiKey: "API キー",
            subscription: "ChatGPT プラン",
            hint: "ChatGPT にログインしてプランの利用枠を使います。OpenAI に直接接続し、常にストリーミングを使用します。サンプリングと出力トークン上限はプラン側で処理されます。",
            account: "ChatGPT アカウント",
            usingPlan: "ChatGPT プランを使用中",
            notConnected: "ログインして GrayCode にプランの利用を許可すると、モデルの取得とリクエストの送信ができます。",
            needsPermission: "プランの利用が許可されていないか、ログアウトしています。再度ログインして利用を許可してください。",
            connect: "Continue with ChatGPT",
            reconnect: "再ログイン",
            addAccount: "アカウント・ワークスペースを追加",
            disconnect: "このアカウントからログアウト",
            usage: "プランの使用量を管理",
            waiting: "ブラウザーでログインと許可を完了してください。",
            exchanging: "本人確認と認証情報の保存中…",
            openBrowser: "認証ページを開く",
            pasteLabel: "コールバックが完了しない場合は URL 全体を貼り付けてください",
            pastePlaceholder: "http://127.0.0.1:…/auth/callback?…",
            complete: "ログインを完了",
            cancel: "ログインをキャンセル",
            revocationUnconfirmed: "ローカルでログアウトしましたが、リモートの取り消しは未確認です。ChatGPT 設定で GrayCode を切断できます。",
            failed: "ChatGPT ログインに失敗しました。再試行してください。",
            firstUseTitle: "ChatGPT プランを使用しています",
            firstUseMessage: "GrayCode の対象リクエストは ChatGPT プランやクレジットを使用します。ChatGPT 設定で使用量、アプリの権限と上限を管理できます。",
            understood: "了解",
            close: "閉じる",
        },
        config: {
            errors: {
                configNotFound: '設定が見つかりません: {configId}',
                configExists: '設定は既に存在します: {configId}、overwrite オプションを使用して置き換えてください',
                invalidConfig: '無効な設定',
                validationFailed: '設定の検証に失敗しました: {errors}',
                saveFailed: '設定の保存に失敗しました',
                loadFailed: '設定の読み込みに失敗しました'
            },
            validation: {
                nameRequired: '名前は必須です',
                typeRequired: 'タイプは必須です',
                invalidUrl: 'API URL が無効です',
                apiKeyEmpty: 'API Key が空です。使用前に設定が必要です',
                modelNotSelected: '利用可能なモデルがありますが、選択されていません',
                temperatureRange: 'temperature は 0.0 から 2.0 の間である必要があります',
                maxOutputTokensMin: 'maxOutputTokens は 0 より大きい必要があります',
                maxOutputTokensHigh: 'maxOutputTokens が大きすぎます。高遅延の原因になる可能性があります',
                temperatureRangeAnthropic: 'temperature は 0.0 〜 1.0 の範囲でなければなりません（Anthropic）',
                maxTokensMin: 'max_tokens は 0 より大きくなければなりません',
                topPRange: 'top_p は 0.0 〜 1.0 の範囲でなければなりません',
                topKMin: 'top_k は 0 以上でなければなりません',
                thinkingBudgetMin: 'thinking.budget_tokens は 1024 以上でなければなりません',
                unsupportedType: 'サポートされていないチャンネルタイプ: {type}',
                retryCountInvalid: 'retryCount は 0 以上の整数である必要があります',
                retryIntervalInvalid: 'retryInterval は正の数である必要があります',
                timeoutInvalid: 'timeout は正の数である必要があります'
            }
        },

        conversation: {
            defaultTitle: '会話 {conversationId}',
            errors: {
                conversationNotFound: '会話が見つかりません: {conversationId}',
                conversationExists: '会話は既に存在します: {conversationId}',
                messageNotFound: 'メッセージが見つかりません: {messageId}',
                messageIndexOutOfBounds: 'メッセージインデックスが範囲外です: {index}',
                snapshotNotFound: 'スナップショットが見つかりません: {snapshotId}',
                snapshotNotBelongToConversation: 'スナップショットはこの会話に属していません',
                saveFailed: '会話の保存に失敗しました',
                loadFailed: '会話の読み込みに失敗しました'
            }
        },

        mcp: {
            errors: {
                connectionFailed: '接続に失敗しました: {serverName}',
                serverNotFound: 'サーバーが見つかりません: {serverId}',
                serverNotFoundWithAvailable: 'サーバーが見つかりません: {serverId}。利用可能なサーバー: {available}',
                serverDisabled: 'サーバーが無効です: {serverId}',
                serverNotConnected: 'サーバーが接続されていません: {serverName}',
                clientNotConnected: 'クライアントが接続されていません',
                toolCallFailed: 'ツール呼び出しに失敗しました',
                requestTimeout: 'リクエストがタイムアウトしました ({timeout}ms)',
                invalidServerId: 'ID には英数字、アンダースコア、ハイフンのみ使用できます',
                serverIdExists: 'サーバー ID "{serverId}" は既に存在します'
            },
            status: {
                connecting: '接続中...',
                connected: '接続済み',
                disconnected: '切断済み',
                error: 'エラー'
            }
        },

        checkpoint: {
            description: {
                before: '実行前',
                after: '実行後'
            },
            restore: {
                success: '"{toolName}" {phase}の状態に復元しました',
                filesUpdated: '{count} 個のファイルが更新されました',
                filesDeleted: '{count} 個のファイルが削除されました',
                filesUnchanged: '{count} 個のファイルは変更なし',
                chainBroken: '増分チェーンが破損しています：参照先のベースチェックポイントが見つかりません',
                partialFailure: '"{toolName}" {phase}の状態に復元しましたが、{count} 件の失敗があります',
                workspaceMismatch: '現在のワークスペースがチェックポイント記録のワークスペースと一致しないため、復元を拒否しました',
                multiRootLegacyNotSupported: '旧形式のチェックポイント（相対パス形式）はマルチルートワークスペースでは復元できません',
                checkpointNotFound: 'チェックポイントが見つかりません',
                manifestMissing: 'チェックポイントのバックアップデータが見つかりません（manifest が見つかりません）',
                cannotBuildChain: 'チェックポイントの増分チェーンを構築できません',
                backupDirNotFound: 'バックアップディレクトリが見つかりません: {dirs}',
                moreFailures: 'ほか {count} 件の失敗',
                excludedNote: 'このチェックポイントは作成時の除外ルールで {count} 個のファイルを除外しました',
                excludedNoteChanged: 'このチェックポイントは作成時の除外ルールで {count} 個のファイルを除外しました。現在の除外ルールは変更されているため、復元は現在のルールに従います'
            },
            defaultConversationTitle: '会話 {conversationId}',
            errors: {
                createFailed: 'チェックポイントの作成に失敗しました',
                restoreFailed: 'チェックポイントの復元に失敗しました',
                deleteFailed: 'チェックポイントの削除に失敗しました'
            }
        },

        settings: {
            contextMethod: {
                defaultTitle: '既定のコンテキスト管理方式',
                description: '自動・手動操作では現在のチャネルの方式を優先します。個別設定のないチャネルでは、この既定値を使用します。元のメッセージと添付ファイルは復元・検索・閲覧できます。',
                defaultHint: 'チャネルの個別設定が優先されます。Bot は独自の方式と時間ベースの要約を引き続き使用します。',
                channelTitle: 'コンテキスト管理方式',
                channelHint: 'このチャネルの自動処理と手動要約に適用します。しきい値は自動処理の開始だけを制御します。保存後、新しいターンと次の手動操作から反映されます。',
            },
            contextRetention: {
                title: '通常の会話で保持するユーザーメッセージ',
                first: '最初のメッセージ＋直近の入力',
                all: 'すべてのユーザーメッセージ',
                hint: '通常の会話の自動・手動要約とノートウィンドウに適用します。切り替え前の直近の実際のユーザー入力は必ず保持します。Bot には影響しません。次のターンまたは手動操作から反映されます。',
                summaryHint: '現在のモデル、システムプロンプト、ツールを再利用して要約を依頼します。選択したユーザーの原文と新しい要約を保持して続行します。',
                notesHint: '追加の要約生成なしでウィンドウを切り替えます。選択したユーザーの原文と復元案内を保持し、必要に応じてノートや履歴を参照します。',
            },
            clawdSettings: {
                title: 'Clawd デスクトップペット連携',
                description: '起動中の Clawd に GrayCode の思考、ツール実行、確認待ち、完了、エラーの状態を表示します。',
                enabled: 'タスク状態の連携を有効にする',
                agentId: 'Clawd Agent ID',
                setup: 'Clawd の Settings → Agents で GrayCode の実行ファイルまたはインストール先を追加し、スキャンして登録した後、生成された Agent ID をここに貼り付けてください。',
                hint: '「すべて保存」後に反映されます。GrayCode サーバーと同じコンピューターの Clawd に接続し、ポートを自動検出します。承認操作は GrayCode で行います。',
                check: '接続を確認',
                checking: '確認中…',
                saveFirst: '接続を確認する前に、すべての設定を保存してください。',
                status_disabled: '無効',
                status_waiting: '有効、タスクの開始待ち',
                status_connected: 'Clawd が状態を受信しました。おやすみモードではアニメーションが非表示になる場合があります',
                status_offline: 'Clawd が未起動または接続できません。タスクは通常どおり続行します',
                status_unregistered: 'Clawd でこの Agent ID を登録して有効にしてください',
                status_error: 'Clawd が状態を受け付けませんでした。バージョンと登録設定を確認してください',
                invalidAgentId: 'Clawd の設定で GrayCode を登録した際に生成された完全な Agent ID を入力してください。',
            },
            backgroundGalleryPolicy: 'JPG・PNG・WebP、1 枚最大 10 MB。インポート画像は設定と一緒に保存・破棄されます。アップロードと保存済み画像の管理はすぐに反映されます。',
            errors: {
                loadFailed: '設定の読み込みに失敗しました',
                saveFailed: '設定の保存に失敗しました',
                invalidValue: '無効な設定値',
                invalidCheckpointExclusionPatterns: 'チェックポイント除外ルールが無効です: {detail}',
                invalidCheckpointExclusionProfiles: 'チェックポイント除外カテゴリが無効です: {detail}',
                invalidCheckpointMaxFileSize: '単一ファイルサイズ上限は有限の数値である必要があります',
                invalidCheckpointConfigField: 'チェックポイント設定フィールドが無効です: {field}',
                exclusionPatternReason: {
                    empty: '空パターン',
                    absolute: '絶対パスパターン',
                    negationOnly: '! のみの否定（ルール本体なし）',
                    traversal: '.. による越界',
                    newline: '改行を含む',
                    blanket: 'ワークスペース全体を除外するパターン'
                }
            },
            storage: {
                pathNotAbsolute: 'パスは絶対パスである必要があります: {path}',
                pathNotDirectory: 'パスはディレクトリである必要があります: {path}',
                createDirectoryFailed: 'ディレクトリの作成に失敗しました: {error}',
                migrationFailed: '移行に失敗しました: {error}',
                migrationSuccess: 'ストレージの移行が完了しました',
                migratingFiles: 'ファイルを移行中...',
                migratingConversations: '会話を移行中...',
                migratingCheckpoints: 'チェックポイントを移行中...',
                migratingConfigs: '設定を移行中...'
            },
            exporter: {
                parseFailed: 'エクスポートファイルの解析に失敗しました：{error}',
                invalidRoot: 'エクスポートファイルの形式が無効です：ルート要素はオブジェクトである必要があります',
                missingVersion: 'エクスポートファイルに version フィールドがありません',
                unsupportedVersion: 'サポートされていないエクスポートファイルバージョン：{version}（現在サポートされているのは {supported} のみ）',
                missingChannelConfigs: 'エクスポートファイルに channelConfigs 配列がありません',
                missingMcpServers: 'エクスポートファイルに mcpServers 配列がありません',
                missingSkills: 'エクスポートファイルに skills 配列がありません',
                missingVscodeSettings: 'エクスポートファイルに vscodeSettings オブジェクトがありません',
                importVscodeSettingsFailed: 'VSCode 設定のインポートに失敗しました：{error}',
                importChannelConfigsFailed: 'チャンネル設定のインポートに失敗しました：{error}',
                importMcpServersFailed: 'MCP サーバー設定のインポートに失敗しました：{error}',
                importSkillsFailed: 'スキルのインポートに失敗しました：{error}',
                reloadSettingsFailed: '設定の再読み込みに失敗しました：{error}',
                partialVscodeSettingsImportFailed: '一部の VSCode 設定のインポートに失敗しました：{detail}',
                channelConfigItemError: 'チャンネル設定 "{name}": {error}',
                partialChannelConfigsImportFailed: '一部のチャンネル設定のインポートに失敗しました：{detail}',
                mcpServerItemError: 'MCP サーバー "{name}": {error}',
                partialMcpServersImportFailed: '一部の MCP サーバー設定のインポートに失敗しました：{detail}',
                skillItemError: 'スキル "{name}": {error}',
                skillRestoreError: 'スキル "{name}" の有効状態の復元：{error}',
                skillRestoreFailuresSummary: '{count} 件のスキルの有効状態の復元に失敗しました（ファイルはインポート済み）：{detail}',
                partialSkillsImportFailed: '一部のスキルのインポートに失敗しました：{detail}'
            }
        },

        update: {
            errors: {
                cannotReadVersion: '現在の拡張機能バージョンを読み取れませんでした',
                invalidDownloadUrl: '不正なダウンロードURLです：このリポジトリの GitHub Releases の vsix パッケージのみ受け付けます。',
                invalidVersion: '不正なバージョン番号：{version}',
                downloadFailed: 'ダウンロードに失敗しました：HTTP {status} {statusText}',
                emptyDownload: 'ダウンロード内容が空です。vsix が破損している可能性があります。',
                downloadTimeout: 'ダウンロードがタイムアウトしました（{seconds} 秒超過）',
                apiError: 'GitHub Releases API が {status} {statusText} を返しました',
                apiResponseInvalid: 'GitHub Releases API の応答形式が不正です',
                checkTimeout: '更新チェックがタイムアウトしました（{seconds} 秒超過）'
            }
        },

        dependencies: {
            descriptions: {
                sharp: '背景除去でマスク適用に使用する高性能画像処理ライブラリ',
                pdfjsDist: 'DeepSeek Vision のページ単位画像入力に使用する PDF ページレンダリングライブラリ',
                napiCanvas: 'PDF ページを画像にラスタライズする Node.js ネイティブキャンバス実装'
            },
            errors: {
                requiresContext: 'DependencyManager は初回呼び出し時に ExtensionContext が必要です',
                unknownDependency: '不明な依存関係: {name}',
                nodeModulesNotFound: 'インストール後に node_modules ディレクトリが見つかりません',
                moduleNotFound: 'インストール後に {name} モジュールが見つかりません',
                installFailed: 'インストールに失敗しました: {error}',
                uninstallFailed: '{name} のアンインストールに失敗しました',
                loadFailed: '{name} の読み込みに失敗しました'
            },
            progress: {
                installing: '{name} をインストール中...',
                downloading: '{name} をダウンロード中...',
                installSuccess: '{name} のインストールが完了しました！'
            }
        },

        channel: {
            formatters: {
                streamError: '{provider} がストリーム中にエラーを返しました: {message}',
                gemini: {
                    errors: {
                        invalidResponse: '無効な Gemini API レスポンス: 候補がありません',
                        apiError: 'API がエラーステータスを返しました: {code}',
                        emptyCandidate: 'Gemini が内容のない候補を返しました（終了理由: {finishReason}、コンテンツ安全フィルターの可能性）'
                    }
                },
                anthropic: {
                    errors: {
                        invalidResponse: '無効な Anthropic API レスポンス: コンテンツがありません'
                    }
                },
                openai: {
                    errors: {
                        invalidResponse: '無効な OpenAI API レスポンス: 選択肢がありません'
                    }
                }
            },
            errors: {
                configNotFound: '設定が見つかりません: {configId}',
                configDisabled: '設定が無効です: {configId}',
                unsupportedChannelType: 'サポートされていないチャンネルタイプ: {type}',
                configValidationFailed: '設定の検証に失敗しました: {configId}',
                buildRequestFailed: 'リクエストの構築に失敗しました: {error}',
                apiError: 'API がエラーステータスを返しました: {status}',
                parseResponseFailed: 'レスポンスの解析に失敗しました: {error}',
                httpRequestFailed: 'HTTP リクエストに失敗しました: {error}',
                parseStreamChunkFailed: 'ストリームチャンクの解析に失敗しました: {error}',
                streamRequestFailed: 'ストリームリクエストに失敗しました: {error}',
                requestTimeout: 'リクエストがタイムアウトしました ({timeout}ms)',
                requestTimeoutNoResponse: 'リクエストがタイムアウトしました ({timeout}ms 内に応答なし)',
                requestCancelled: 'リクエストがキャンセルされました',
                requestAborted: 'リクエストが中止されました',
                noResponseBody: 'レスポンスボディがありません',
                emptyResponse: 'モデルが空の応答を返しました',
                streamTruncated: 'ストリーム出力が途中で切断されました（完了マーカー未受信）。ネットワークまたはプロキシの中断が原因の可能性があります',
                streamBufferOverflow: 'ストリームバッファがサイズ上限を超えました：上流データを解析できませんでした（バッファが消費されず増加し続けました）',
                invalidRetryConfig: '無効な再試行設定: {configId}（retryCount は 0 以上の整数である必要があります）'
            },
            modelList: {
                errors: {
                    apiKeyRequired: 'API Key は必須です',
                    fetchModelsFailed: 'モデルの取得に失敗しました: {error}',
                    unsupportedConfigType: 'サポートされていない設定タイプ: {type}'
                }
            }
        },

        api: {
            channel: {
                errors: {
                    listChannelsFailed: 'チャンネル設定一覧の取得に失敗しました',
                    channelNotFound: 'チャンネル設定が見つかりません: {channelId}',
                    getChannelFailed: 'チャンネル設定の取得に失敗しました',
                    channelAlreadyExists: 'チャンネル設定は既に存在します: {channelId}',
                    createChannelFailed: 'チャンネル設定の作成に失敗しました',
                    updateChannelFailed: 'チャンネル設定の更新に失敗しました',
                    deleteChannelFailed: 'チャンネル設定の削除に失敗しました',
                    setChannelStatusFailed: 'チャンネルステータスの設定に失敗しました'
                }
            },
            settings: {
                errors: {
                    getSettingsFailed: '設定の取得に失敗しました',
                    updateSettingsFailed: '設定の更新に失敗しました',
                    setActiveChannelFailed: 'アクティブチャンネルの設定に失敗しました',
                    setToolStatusFailed: 'ツールステータスの設定に失敗しました',
                    batchSetToolStatusFailed: 'ツールステータスの一括設定に失敗しました',
                    setDefaultToolModeFailed: 'デフォルトツールモードの設定に失敗しました',
                    updateUISettingsFailed: 'UI 設定の更新に失敗しました',
                    updateProxySettingsFailed: 'プロキシ設定の更新に失敗しました',
                    resetSettingsFailed: '設定のリセットに失敗しました',
                    toolRegistryNotAvailable: 'ツールレジストリが利用できません',
                    getToolsListFailed: 'ツール一覧の取得に失敗しました',
                    getToolConfigFailed: 'ツール設定の取得に失敗しました',
                    updateToolConfigFailed: 'ツール設定の更新に失敗しました',
                    updateListFilesConfigFailed: 'list_files 設定の更新に失敗しました',
                    updateApplyDiffConfigFailed: 'apply_diff 設定の更新に失敗しました',
                    getCheckpointConfigFailed: 'チェックポイント設定の取得に失敗しました',
                    updateCheckpointConfigFailed: 'チェックポイント設定の更新に失敗しました',
                    getSummarizeConfigFailed: '要約設定の取得に失敗しました',
                    updateSummarizeConfigFailed: '要約設定の更新に失敗しました',
                    getGenerateImageConfigFailed: '画像生成設定の取得に失敗しました',
                    updateGenerateImageConfigFailed: '画像生成設定の更新に失敗しました',
                    tokenCountFailed: 'トークン数カウントに失敗しました',
                    toolNotFound: 'ツールが見つかりません: {toolName}',
                    memoryConfigFailed: 'メモリ設定の取得に失敗しました',
                    updateMemoryConfigFailed: 'メモリ設定の更新に失敗しました'
                }
            },
            models: {
                errors: {
                    configNotFound: '設定が見つかりません',
                    getModelsFailed: 'モデル一覧の取得に失敗しました',
                    addModelsFailed: 'モデルの追加に失敗しました',
                    removeModelFailed: 'モデルの削除に失敗しました',
                    modelNotInList: 'モデルがリストにありません',
                    setActiveModelFailed: 'アクティブモデルの設定に失敗しました'
                }
            },
            mcp: {
                errors: {
                    listServersFailed: 'MCP サーバー一覧の取得に失敗しました',
                    serverNotFound: 'MCP サーバーが見つかりません: {serverId}',
                    getServerFailed: 'MCP サーバーの取得に失敗しました',
                    createServerFailed: 'MCP サーバーの作成に失敗しました',
                    updateServerFailed: 'MCP サーバーの更新に失敗しました',
                    deleteServerFailed: 'MCP サーバーの削除に失敗しました',
                    setServerStatusFailed: 'MCP サーバーステータスの設定に失敗しました',
                    connectServerFailed: 'MCP サーバーへの接続に失敗しました',
                    disconnectServerFailed: 'MCP サーバーの切断に失敗しました'
                }
            },
            chat: {
                errors: {
                    configNotFound: '設定が見つかりません: {configId}',
                    configDisabled: '設定が無効です: {configId}',
                    maxToolIterations: '最大ツール呼び出し回数に達しました ({maxIterations})',
                    unknownError: '不明なエラー',
                    toolExecutionSuccess: 'ツールの実行に成功しました',
                    mcpToolCallFailed: 'MCP ツール呼び出しに失敗しました',
                    invalidMcpToolName: '無効な MCP ツール名: {toolName}',
                    toolNotFound: 'ツールが見つかりません: {toolName}',
                    toolExecutionFailed: 'ツールの実行に失敗しました',
                    noHistory: '会話履歴が空です',
                    lastMessageNotModel: '最後のメッセージがモデルメッセージではありません',
                    noFunctionCalls: '保留中のファンクション呼び出しがありません',
                    userRejectedTool: 'ユーザーがツールの実行を拒否しました',
                    toolCallCancelled: 'ユーザーがリクエストをキャンセルしたため、このツール呼び出しは実行されませんでした',
                    notEnoughRounds: '会話ラウンド数が不足しています。現在 {currentRounds} ラウンド、{keepRounds} ラウンド保持、要約は不要です',
                    notEnoughContent: '会話ラウンド数が不足しています。現在 {currentRounds} ラウンド、{keepRounds} ラウンド保持、要約するコンテンツがありません',
                    noMessagesToSummarize: '要約するメッセージがありません',
                    summarizeAborted: '要約リクエストが中止されました',
                    emptySummary: 'AI が生成した要約が空です',
                    lowQualitySummary: 'AI が生成した要約が短すぎて重要な情報が失われる可能性があるため、履歴の置き換えは行いませんでした',
                    summarizeRangeStale: '要約中に会話履歴が変更されたため、要約範囲が無効になり、書き込みを中止しました',
                    messageNotFound: 'メッセージが見つかりません: インデックス {messageIndex}',
                    canOnlyEditUserMessage: 'ユーザーメッセージのみ編集できます。現在のメッセージロール: {role}',
                    messageChanged: 'メッセージが変更されました。更新後に再試行してください',
                    invalidTargetIndex: '削除対象のインデックスが無効です: {targetIndex}',
                    editTargetNotInHistory: '選択したメッセージは現在の会話履歴にありません。コンテキスト圧縮で削除された可能性があります',
                    contextOverflow: 'モデルのコンテキストウィンドウ内で有効なリクエストを構築できません: 最小候補は約 {estimatedInputTokens} 入力トークン必要で、{inputTokenLimit} トークンのウィンドウを超えています。モデルのコンテキストウィンドウを増やすか、履歴/保持予算を調整してください',
                    summarizeContextOverflow: '要約対象の内容と要約プロンプトが要約モデルのコンテキスト上限を超えています。要約モデルのコンテキストウィンドウを増やすか、保持予算を調整してください'
                },
                prompts: {
                    defaultSummarizePrompt: `上記の会話内容を簡潔に要約してください。書式マーカーなしで直接要約を出力してください。

要件：
1. 重要な情報とコンテキストのポイントを保持する
2. 冗長な内容とツール呼び出しの詳細を削除する
3. トピック、議論された問題、結論を要約する
4. 重要な技術的詳細と決定を保持する
5. プレフィックス、タイトル、書式マーカーなしで直接要約内容を出力する`,
                    summaryPrefix: '[会話要約]',
                    autoSummarizePrompt: `上記の会話履歴を要約し、AIが未完了のタスクを続行できるように以下の内容を出力してください。

## ユーザーの要件
ユーザーが達成したいこと（全体的な目標）。

## 完了した作業
時系列順に、どのファイルを変更したか、どのような決定を下したかを含め、完了した作業をリストアップしてください。
ファイルパス、変数名、設定値は正確に保持し、一般化しないでください。

## 現在の進捗
どのステップまで到達したか、現在何をしているか。

## TODOアイテム
まだ行う必要があること、優先順位順にリストアップ。

## 重要な規約
ユーザーが提示した制約、好み、技術的要件（例：「サードパーティライブラリを使用しない」、「TypeScriptを使用」など）。

プレフィックスなしで直接内容を出力してください。`
                }
            }
        }
    },

    tools: {
        contextStatus: {
            title: '入力トークン使用量', remaining: '残り', reservedOutput: '出力予約', capacity: 'コンテキスト容量',
            threshold: '要約しきい値', method: '管理方式', retention: '保持するユーザーメッセージ',
            summary: '通常の要約', notes: '作業ノート', retainFirst: '最初と最新', retainAll: 'すべて', retainBot: 'Bot の設定',
            summaryOption: '通常の要約 · 履歴を圧縮', notesOption: '作業ノート · 必要な履歴を復元',
            notesHint: 'しきい値に達したら作業ノートを保存してコンテキストを切り替え、ノートと必要な履歴を読み込んで作業を続けます。',
            switched: 'コンテキストを切り替えました', disabled: '自動管理オフ', pending: 'コンテキストの切り替え待ち',
            normal: '上限内', overThreshold: '要約しきい値に到達', overBudget: '入力上限を超過', unknown: '未提供',
            localEstimate: 'ローカル推定', usageSource: '現在の使用量', details: '使用量の詳細', empty: '使用量データがありません',
            fixedPrompt: '固定プロンプト', history: '履歴', messages: 'メッセージ数', measuredAt: '確認時刻',
            thresholdTokens: 'しきい値トークン数', contextId: 'コンテキスト ID', initial: '初期コンテキスト',
        },
        runtimeControl: {
            contextStatusName: 'コンテキスト状態',
            contextStatusDescription: '現在のトークン使用量と要約方針を確認',
            terminalTaskName: 'バックグラウンド端末タスク',
            terminalTaskDescription: 'execute_command の状態確認、出力の差分読み取り、管理対象プロセスツリーの停止を行います。',
        },
        automation: {
            "actions": {
                "list": "一覧",
                "create": "作成",
                "show": "表示",
                "close": "閉じる",
                "snapshot": "ページを読む",
                "screenshot": "スクリーンショット",
                "logs": "ログを読む",
                "navigate": "移動",
                "back": "戻る",
                "forward": "進む",
                "reload": "再読み込み",
                "click": "クリック",
                "hover": "ホバー",
                "check": "選択状態を設定",
                "wait": "ページの条件を待機",
                "type": "入力",
                "fill": "置換入力",
                "press": "キー入力",
                "scroll": "スクロール",
                "drag": "ドラッグ",
                "upload": "アップロード",
                "download": "ダウンロード",
                "acquire": "制御を取得",
                "status": "状態を確認",
                "release": "制御を解放",
                "focusWindow": "ウィンドウにフォーカス",
                "focusElement": "要素にフォーカス",
                "invoke": "要素を実行",
                "setValue": "値を設定",
                "select": "選択",
                "toggle": "切り替え",
                "expand": "展開",
                "collapse": "折りたたむ",
                "key": "キー入力",
                "query": "ペットを照会",
                "play": "動作を再生",
                "expression": "表情を設定",
                "look": "視線を変更",
                "parameters": "パラメータを設定",
                "cancel": "動作を取消",
                "resume": "再開",
                "stat": "添付情報",
                "read": "添付を読む"
            },
            "currentPage": "現在のページ",
            "openedTabs": "この操作で開いたタブ",
            "openedTabsHint": "以下のスクリーンショットとスナップショットは元のタブのものです。新しいページを読むには、そのタブ ID を使用してください。",
            "closedTab": "閉じました",
            "requestedUrl": "要求した URL",
            "profiles": "ログイン設定",
            "activeTab": "現在のタブ",
            "untitled": "無題",
            "noTabs": "開いているタブはありません",
            "loading": "読み込み中",
            "userControlled": "ユーザーが制御中",
            "controlledBy": "制御中のタスク",
            "windowVisible": "ワークベンチが表示中",
            "logs": "ページログ",
            "noLogs": "新しいログはありません",
            "nextCursor": "次のカーソル",
            "snapshotCount": "一致した {total} 件のうち {count} 件を取得",
            "conditionMet": "ページが待機条件を満たしました",
            "conditionTimedOut": "待機が終了しましたが、ページは条件を満たしていません",
            "truncated": "結果は省略されています。今回返された部分のみ表示します",
            "uploaded": "ファイル入力に設定済み",
            "downloaded": "ダウンロードを保存済み",
            "observation": "観察記録",
            "capturedAt": "取得時刻",
            "dimensions": "画像サイズ",
            "imageCoordinates": "座標は返された画像の実ピクセルに基づきます",
            "observationUnavailable": "後続の観察に失敗（動作結果は変わりません）",
            "operationStatus": "動作結果",
            "operationUnknown": "結果未確認",
            "dispatching": "送信済み・確認待ち",
            "repeated": "既存の動作結果を返しました。再実行していません",
            "displays": "ディスプレイ",
            "primaryDisplay": "メインディスプレイ",
            "foreground": "前面ウィンドウ",
            "minimized": "最小化中",
            "noWindows": "利用できるウィンドウはありません",
            "control": "コンピューター制御",
            "controlActive": "制御中",
            "controlInactive": "未制御",
            "reason": "状態の理由",
            "controller": "制御者",
            "stopShortcut": "停止ショートカット",
            "available": "利用可能",
            "unavailable": "利用不可",
            "focusedElement": "現在のフォーカス",
            "accessibilityUnavailable": "要素の読み取りに失敗",
            "noElements": "今回の観察には要素がありません",
            "petModel": "現在のペット",
            "noPet": "ペットが選択されていません",
            "renderer": "プレイヤー",
            "phases": {
                "unloaded": "未読み込み",
                "loading": "読み込み中",
                "ready": "準備完了",
                "failed": "読み込み失敗"
            },
            "visible": "表示中",
            "stopped": "ユーザーが停止",
            "accepted": "要求を受け付けました",
            "notAccepted": "要求は受け付けられていません",
            "applied": "プレイヤーが適用を確認",
            "notApplied": "プレイヤーの適用確認なし",
            "currentCommand": "現在の動作",
            "confirmedCommand": "最後に確認された動作",
            "petActions": "利用可能な動作",
            "expressions": "利用可能な表情",
            "parameterRanges": "実際のパラメータ範囲",
            "range": "範囲",
            "defaultValue": "既定値",
            "duration": "継続時間",
            "lookAngle": "視線の角度",
            "front": "正面に戻す",
            "requestId": "要求 ID",
            "attachments": "会話の添付ファイル",
            "noAttachments": "この会話に読み取り可能な添付はありません",
            "size": "ファイルサイズ",
            "encoding": "文字コード",
            "characterRange": "文字範囲 {start}–{end}",
            "nextOffset": "次のオフセット",
            "endOfDocument": "文書の末尾です",
            "emptyText": "この範囲に本文はありません"
        },
        platform: {
            "noData": "結果の詳細は返されていません。",
            "partial": "一部の結果",
            "nextOffset": "続きの位置：{offset}",
            "nextCursor": "次のページがあります。カーソルは詳細を参照してください。",
            "version": "バージョン {version}",
            "file": {
                "actions": {
                    "list": "ファイル一覧",
                    "read": "ファイルを読む",
                    "write": "ファイルを書き込む",
                    "edit": "ファイルを編集",
                    "delete": "ファイルを削除"
                },
                "range": "{total} 行中 {start}–{end} 行",
                "nextLine": "次は {line} 行目から読み込み",
                "matches": "{count} 件の一致",
                "scanned": "{count} ファイルを検索済み",
                "scanIncomplete": "検索はまだ完了していません。現在の結果はスキャン済みのファイルのみを対象としています。",
                "scanIncompleteEmpty": "検索はまだ完了していません。現在0件でも、検索範囲全体に一致がないとは限りません。",
                "scanLimit": "検索ファイル数の上限に達しました。ディレクトリを絞ってください。未検索ファイルにはオフセットで移動できません。",
                "matchLimit": "一致する結果がまだあります。同じクエリ・ディレクトリ・大文字小文字の設定で続けてください。",
                "saved": "ファイルを書き込みました",
                "deleted": "ファイルを削除しました",
                "requested": "書き込みを要求した内容",
                "before": "置換前",
                "after": "置換後",
                "empty": "ファイル項目はありません",
                "noMatches": "一致する行はありません"
            },
            "process": {
                "actions": {
                    "read": "プロセス出力を読む",
                    "input": "プロセスに入力",
                    "stop": "プロセスを停止"
                },
                "running": "プロセスは実行中です",
                "exited": "プロセスは終了しました",
                "unknown": "プロセスの状態は返されていません",
                "output": "プロセス出力",
                "noOutput": "プロセス出力はまだありません",
                "truncated": "末尾の出力のみ保持されています。以前の出力は切り詰められました。",
                "input": "送信した入力",
                "taskActions": { "list": "バックグラウンドコマンド一覧", "status": "バックグラウンドコマンドの状態", "read": "バックグラウンド出力を読む", "stop": "バックグラウンドコマンドを停止" },
                "taskCount": "{count} 件のコマンドタスク",
                "noTasks": "この会話にはバックグラウンドコマンドがありません",
                "interrupted": "中断済み",
                "moreOutput": "続けて読み取れる出力があります。"
            },
            "team": {
                "actions": {
                    "list": "共有タスク",
                    "get": "タスクの詳細",
                    "create": "タスクを作成",
                    "claim_ready": "実行可能なタスクを取得",
                    "claim": "タスクを取得",
                    "complete": "タスクを完了",
                    "release": "タスクを解放",
                    "set_dependencies": "依存関係を更新"
                },
                "task": "タスク",
                "dependencies": "{count} 件の依存関係",
                "blockedBy": "{count} 件の未完了依存",
                "ready": "{count} 件のタスクが取得可能",
                "unclaimed": "未取得",
                "assigned": "取得済み",
                "empty": "タスクは返されていません",
                "noReady": "取得可能なタスクはありません",
                "emptyEvents": "新しいチームイベントはありません",
                "nextTasks": "次のタスクは作成順序 {sequence} の後から",
                "moreEvents": "次のイベントは順序 {sequence} の後から",
                "reasons": {
                    "events": "チームイベントを受信",
                    "ready_work": "取得可能なタスクあり",
                    "no_progress": "現在は進められません",
                    "timeout": "新しいイベントがないまま待機が終了しました"
                },
                "noProgress": "実行可能なタスクも、進行できる他のメンバーもいません。問題の解消・報告、または待機の終了が必要です。",
                "events": {
                    "task_created": "タスクを作成済み",
                    "task_claimed": "タスクを取得済み",
                    "task_completed": "タスクを完了済み",
                    "task_released": "タスクを解放済み",
                    "task_dependencies_changed": "タスクの依存関係を更新済み",
                    "message_queued": "メッセージは待機列にあります",
                    "member_changed": "メンバーの状態が変化しました"
                }
            },
            "memory": {
                "topics": "記憶のトピック",
                "scopes": "許可された範囲",
                "records": "{count} 件の記憶",
                "sources": "出典の抜粋",
                "source": "出典",
                "root": "トピックのルート",
                "empty": "記憶は返されていません",
                "kinds": {
                    "fact": "事実",
                    "preference": "好み",
                    "experience": "経験",
                    "project": "プロジェクト",
                    "procedure": "手順",
                    "event": "出来事",
                    "summary": "要約"
                },
                "confidence": {
                    "confirmed": "確認済み",
                    "inferred": "推測",
                    "disputed": "異論あり"
                },
                "origins": {
                    "user": "ユーザーメッセージ",
                    "model": "モデルのメッセージ",
                    "tool": "ツール結果",
                    "fiction": "物語",
                    "import": "インポート資料"
                },
                "scopeKinds": {
                    "personal": "個人",
                    "workspace": "プロジェクト",
                    "group": "グループ",
                    "library": "ライブラリ"
                },
                "preview": "削除影響のプレビュー · 未削除",
                "apply": "削除の結果",
                "retract": "撤回の結果",
                "affected": "{total} 項目に影響（記憶 {records} 件）",
                "removed": "{count} 項目を削除しました",
                "requested": "送信した記憶内容",
                "append": "追記を要求した内容",
                "saved": "保存された記録 {count} 件を受信",
                "omitted": "予算または件数の制限で {count} 項目を省略",
                "unavailable": "{count} 項目は利用不可",
                "requiredBudget": "必要なトークン予算：{count}",
                "truncated": "一部の記憶のみ返されました。範囲を絞るか予算を調整してください。",
                "pageRange": "文字 {start}–{end} / {total}",
                "sourcePage": "出典本文の一部",
                "recordPage": "記憶本文の一部",
                "conflicts": "{count} 件の矛盾する記録",
                "dependencies": "{count} 件の出典・記憶への依存",
                "previewIds": "影響を受ける記憶と出典の ID"
            }
        },
        contextNotes: {
            recorded: '{count} 件のノートを記録しました', submitted: '今回送信したノート：{count} 件',
            recalled: '今回返されたノート本文：{count} 件', budget: 'ローカル推定：{used} / {budget} tokens',
            alreadyProvided: '{count} 件のノートは現在のコンテキストに提供済みです',
            providedExplanation: 'モデルはこれらの本文を引き続き参照できます。今回は履歴参照を返します。再読するにはノート ID を指定して inspect を使ってください。',
            historyReference: '履歴参照：', missingDependencies: '{count} 件の必須情報が完全には返されていません',
            unavailable: '{count} 件のノートは現在利用できません', omitted: '予算または件数制限により {count} 件のノートを省略しました',
            truncated: '今回の取得には必要な情報がすべて含まれていません。範囲を絞るか token 予算を増やして続けてください。',
            empty: '現在有効なノートは見つかりませんでした。', replacements: 'ノートの置換関係', about: '関連する対象：',
            sourceRange: '情報源 offset={offset}、length={length}', nextOffset: 'offset={offset} で続きを読み取れます。',
            kinds: { constraint: '制約', decision: '決定', observation: '観察', hypothesis: '仮説', task: 'タスク', lesson: '経験' },
            states: { current: '現在有効', superseded: '置換済み', outside_time: '指定した時間の範囲外', source_unavailable: '情報源が無効' },
            relations: { requires: '依存先', supports: '支持する対象', contradicts: '矛盾する対象', applies_to: '適用先', supersedes: '置換する対象' },
            providedReasons: { recorded: '記録時の呼び出しで提供済み', recalled: '取得結果で提供済み', verbatim: '原文が現在のコンテキストに存在' },
            historyActions: { windows: 'コンテキストウィンドウ一覧', list: '最近のメッセージ一覧', search: '履歴を検索', read: 'メッセージを読み取り' },
        },
        presentation: {
            gotoDefinition: {
                pageSummary: 'このページに {returned} 件の定義、合計 {total} 件',
                nextPage: '検索条件を変えずに offset={offset} で続きを取得してください。',
                contentTruncated: 'この定義の本文は省略されています。表示されたパスと行範囲で残りのコードを読み取れます。',
                emptyPage: 'このページに定義はありません'
            },
            // Responses の strict はチャネル設定に従い、暗黙には有効化されない。
            strictToolsOpenaiResponses: 'OpenAI Responses：既定では無効。有効にすると任意パラメータに null を指定可能',
            messageBody: '送信内容', recipient: '宛先', mainAgent: 'メインエージェント',
            contentUnavailable: 'この履歴には本文が保存されていません。受領情報は詳細で確認できます。',
            messageSaved: 'メッセージを保存しました。受信側の次の実行区切りで読み込まれます。',
            noteContent: 'ノート本文', appendedContent: '今回の追記', noteDirectory: 'ノート一覧',
            historyMessages: '履歴', characters: '{count} 文字',
            invalidatedNote: 'このノートは無効です。有効な情報源から整理し直してください。',
            partialContent: '本文の一部を表示しています。返された範囲を使って続きを読むことができます。',
            partialSuccess: '一部完了', partialRange: '一部の内容', diffUnavailable: '差分を読み込めませんでした。',
            cancelFailed: 'タスクをキャンセルできませんでした。もう一度お試しください。',
            searchReplace: {
                accepted: '適用済み', rejected: '拒否済み', pending: '確認待ち',
                filesRejected: '{count} ファイルを拒否', proposed: '置換候補 {count} 件', skipped: '{count} ファイルをスキップ',
                keywordFallback: '次のキーワードで検索しました：',
            },
            moreHistory: '返された履歴位置を使って、さらに古い記録を読み込めます。',
            // ページの続行とローカル展開を区別し、除外元は今回の結果に記録された情報だけを表示する。
            findFiles: {
                returnedFiles: '{count} 件のファイルを取得',
                pageFiles: 'このページに {count} 件',
                pageOffset: 'このページは {offset} 件をスキップ',
                nextPage: '次のページは再呼び出しが必要：offset={offset}、このパターンと除外条件を維持',
                expandPage: 'このページの残り {count} 件を表示',
                restartAfterFailure: '検索は未完了です。エラーを解消して offset=0 から再検索してください。このページから確実に続行することはできません。',
                continuationDetails: '続行の案内',
                workspaceErrors: 'ワークスペースの検索失敗',
                exclusions: '適用された除外規則',
                excludeSources: {
                    argument: '呼び出し引数（設定を置換）',
                    settings: 'ツール設定',
                    fallback: '既定のフォールバック',
                    includeIgnored: '無視されたファイルを明示的に含める',
                    unknown: '適用元の記録なし'
                }
            }
        },
        errors: {
            toolNotFound: 'ツールが見つかりません: {toolName}',
            executionFailed: 'ツールの実行に失敗しました: {error}',
            invalidParams: '無効なパラメータ',
            timeout: '実行がタイムアウトしました'
        },

        file: {
            errors: {
                fileNotFound: 'ファイルが見つかりません: {path}',
                readFailed: 'ファイルの読み取りに失敗しました: {error}',
                writeFailed: 'ファイルの書き込みに失敗しました: {error}',
                deleteFailed: 'ファイルの削除に失敗しました: {error}',
                permissionDenied: '権限が拒否されました: {path}'
            },
            diffManager: {
                saved: '変更を保存しました: {filePath}',
                saveFailed: '保存に失敗しました: {error}',
                savedShort: '保存完了: {filePath}',
                rejected: '変更を拒否しました: {filePath}',
                diffTitle: '{filePath} (AI の変更 - Ctrl+S で保存)',
                diffGuardWarning: 'この変更はファイルの {deletePercent}% のコンテンツ（{deletedLines}/{totalLines} 行）を削除し、{threshold}% のガード閾値を超えています。慎重に確認してください。'
            },
            diffCodeLens: {
                accept: '承認',
                reject: '拒否',
                acceptAll: 'すべて承認',
                rejectAll: 'すべて拒否'
            },
            diffEditorActions: {
                noActiveDiff: '保留中の diff 変更はありません',
                allBlocksProcessed: 'すべての diff ブロックが処理されました',
                diffBlock: 'Diff ブロック #{index}',
                lineRange: '{start}-{end} 行目',
                acceptAllBlocks: 'すべてのブロックを承認',
                rejectAllBlocks: 'すべてのブロックを拒否',
                blocksCount: '{count} 個の保留中ブロック',
                selectBlockToAccept: '承認する Diff ブロックを選択',
                selectBlockToReject: '拒否する Diff ブロックを選択',
                selectBlockPlaceholder: '複数選択可能'
            },
            diffInline: {
                hoverOrLightbulb: 'ホバーまたは 💡 をクリックして適用',
                acceptBlock: 'Diff ブロック #{index} を承認',
                rejectBlock: 'Diff ブロック #{index} を拒否',
                acceptAll: 'すべての変更を承認',
                rejectAll: 'すべての変更を拒否'
            },
            readFile: {
                cannotReadFile: 'このファイルを読み取ることができません'
            },
            selectionContext: {
                hoverAddToInput: '選択範囲を入力欄に追加',
                codeActionAddToInput: 'LimCode: 選択範囲を入力欄に追加',
                noActiveEditor: 'アクティブなエディターがありません',
                noSelection: '選択範囲がありません',
                failedToAddSelection: '選択範囲の追加に失敗しました: {error}'
            }
        },

        terminal: {
            nextActions: {
                processMoreOutput: 'まだ返されていない保持済みの出力を読み取ります。',
                processIntermediateOutput: '途中の出力が必要なときだけ読み取り、その間は独立した作業を続けてください。',
                processInspect: '現在のセッション状態と保持済みの出力を確認します。コマンドは再起動されません。',
                nativePending: 'ネイティブ非同期呼び出しは実行中です。独立した作業を続け、最終結果が必要になったときだけ task_handle を wait_for_tasks に渡してください。途中の出力は terminal_task で読み取れます。',
                nativeWait: '後続の作業でこのネイティブ非同期コマンドの結果が必要なときだけ待機します。',
                terminalStatus: '状態の確認や診断が必要なときだけ照会してください。完了結果は自動的に届きます。',
                terminalMoreOutput: '残りの出力ページを読み取ります。',
                terminalIntermediateOutput: '途中の出力や進捗の確認が必要なときだけ読み取ります。',
                terminalExitedMoreOutput: 'コマンドは終了しています。待機せずに残りの出力を読み取れます。',
                terminalExitedInspect: 'コマンドは終了しています。追加の診断が必要なときだけ保持済みの出力を読み取ってください。',
                terminalNextPage: '次のタスク一覧ページを読み取ります。',
                terminalResetCursor: '無効なカーソルを省略して保持済みの出力を読み取り、返された nextCursor で続けてください。'
            },
            errors: {
                executionFailed: 'コマンドの実行に失敗しました',
                timeout: 'コマンドの実行がタイムアウトしました',
                killed: 'コマンドが終了されました'
            },
            shellCheck: {
                wslNotInstalled: 'WSL がインストールされていないか、有効になっていません',
                shellNotFound: '見つかりません: {shellPath}',
                shellNotInPath: '{shellPath} が PATH にありません'
            }
        },

        search: {
            errors: {
                searchFailed: '検索に失敗しました: {error}',
                invalidPattern: '無効な検索パターン: {pattern}'
            }
        },

        media: {
            errors: {
                processingFailed: '処理に失敗しました: {error}',
                invalidFormat: '無効な形式: {format}',
                dependencyMissing: '依存関係が不足しています: {dependency}'
            }
        },
        
        common: {
            taskNotFound: 'タスク {id} が見つからないか、既に完了しています',
            cancelTaskFailed: 'タスクのキャンセルに失敗しました: {error}',
            toolAlreadyExists: 'ツールは既に存在します: {name}',
            show: '表示',
            hide: '非表示'
        },
        
        skills: {
            exampleSkill: {
                description: 'Skill 作成前に必読！正しい形式、命名規則、よくある間違いについて。',
                content: `# Skill 作成前に必読

## ⚠️ よくある間違い

1. **name はフォルダ名と完全に一致する必要があります**
   - フォルダ名が \`my-tool\` の場合、frontmatter には \`name: my-tool\` と書く必要があります
   - 不一致の場合、Skill はサイレントにスキップされ、パネルに表示されません

2. **name に使用できるのは小文字、数字、ハイフンのみ**
   - ✅ \`my-skill-name\`、\`tool2\`
   - ❌ \`My_Skill\`、\`ツール\`、\`my--skill\`（連続ハイフン不可）
   - 長さ：1〜64 文字

3. **frontmatter は必須です**
   - ファイルは \`---\` で始まり、\`name\` と \`description\` の両フィールドが必要です
   - frontmatter のない SKILL.md は無視されます

## Skill ファイル形式

\`\`\`markdown
---
name: your-skill-name
description: "このスキルの機能と使用場面の簡単な説明"
---

# スキル名

## 手順
[AI に対する明確なステップバイステップの指示]

## 例
[このスキルの具体的な使用例]
\`\`\`

## 作成手順

1. skills ディレクトリにフォルダを作成（フォルダ名がスキル名）
2. フォルダ内に \`SKILL.md\` ファイルを作成
3. ファイル先頭に frontmatter を記述（\`name\` + \`description\`）
4. frontmatter の後にスキル内容を記述

## Skills ディレクトリの場所

- プロジェクトレベル：\`.graycode/skills/\` または \`.agents/skills/\`
- ユーザーレベル：\`~/.graycode/skills/\` または \`~/.agents/skills/\`

プロジェクトレベルが優先されます。同名の Skill は優先度が最も高いもののみ読み込まれます。

## 仕組み

1. AI はツール説明で有効な全 Skill の名前と説明を確認できます
2. AI が必要と判断すると \`read_skill\` ツールで全文を読み込みます
3. このオンデマンド読み込みにより token を節約し、タスクに応じて最適なナレッジモジュールを動的に選択できます`
            },
            errors: {
                managerNotInitialized: 'Skills マネージャーが初期化されていません'
            }
        },
        
        history: {
            noSummarizedHistory: '要約された履歴が見つかりません。この会話ではまだコンテキスト要約がトリガーされていません。',
            noHistory: '会話履歴が見つかりません。',
            searchResultHeader: '履歴で "{query}" の一致が {count} 件見つかりました（全 {totalLines} 行）',
            noMatchesFound: '履歴で "{query}" の一致は見つかりませんでした（全 {totalLines} 行）。別のキーワードをお試しください。',
            keywordFallbackNotice: '[完全一致するフレーズが見つからなかったため、空白で区切ったキーワードを個別に検索しました：{terms}]',
            resultsLimited: '[結果は {max} 件に制限されています。より具体的なクエリをお試しください。]',
            readResultHeader: '履歴の {start}-{end} 行目（全 {totalLines} 行）',
            readTruncated: '[出力は {max} 行に制限されています。start_line={nextStart} で続きを読んでください。]',
            invalidRegex: '無効な正規表現：{error}',
            invalidRange: '無効な行範囲：{start}-{end}（ドキュメントは全 {totalLines} 行）',
            errors: {
                contextRequired: 'ツールコンテキストが必要です',
                conversationIdRequired: 'ツールコンテキストに conversationId が必要です',
                conversationStoreRequired: 'ツールコンテキストに conversationStore が必要です',
                getHistoryNotAvailable: 'conversationStore.getHistory は利用できません',
                invalidMode: '無効なモード："{mode}"。"search" または "read" を指定してください',
                queryRequired: 'search モードには query パラメータが必要です',
                searchFailed: '履歴検索に失敗しました：{error}'
            }
        },
        reviewDocument: {
            sections: {
                scope: 'レビュー範囲',
                summary: 'レビュー要約',
                findings: 'レビュー所見',
                milestones: 'レビューマイルストーン',
                finalConclusion: '最終結論',
                snapshot: 'レビュースナップショット'
            },
            header: {
                date: '日付',
                overview: '概要',
                status: '状態',
                overallDecision: '総合結論'
            },
            summary: {
                currentStatus: '現在の状態',
                reviewedModules: 'レビュー済みモジュール',
                currentProgress: '現在の進捗',
                totalMilestones: 'マイルストーン総数',
                completedMilestones: '完了済みマイルストーン',
                totalFindings: '問題総数',
                findingsBySeverity: '重大度別の問題',
                latestConclusion: '最新の結論',
                recommendedNextAction: '次の対応',
                overallDecision: '総合結論'
            },
            finding: {
                severity: '重大度',
                category: '分類',
                trackingStatus: '追跡状態',
                description: '説明',
                recommendation: '提案',
                relatedMilestones: '関連マイルストーン',
                evidenceFiles: '証拠'
            },
            milestone: {
                status: '状態',
                recordedAt: '記録時刻',
                reviewedModules: 'レビュー済みモジュール',
                summary: '要約',
                conclusion: '結論',
                evidenceFiles: '証拠',
                recommendedNextAction: '次の対応',
                findings: '問題'
            },
            values: {
                pending: '保留',
                milestoneStatus: {
                    inProgress: '進行中',
                    completed: '完了'
                },
                overallDecision: {
                    pending: '保留',
                    accepted: '承認',
                    conditionallyAccepted: '条件付き承認',
                    rejected: '却下',
                    needsFollowUp: '追加対応が必要'
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
                    accessibility: 'アクセシビリティ',
                    performance: 'パフォーマンス',
                    maintainability: '保守性',
                    docs: 'ドキュメント',
                    test: 'テスト',
                    other: 'その他'
                },
                trackingStatus: {
                    open: 'オープン',
                    acceptedRisk: 'リスク受容',
                    fixed: '修正済み',
                    wontFix: '修正しない',
                    duplicate: '重複'
                }
            },
            placeholders: {
                noMilestones: '<!-- no milestones -->',
                noFindings: '<!-- no findings -->',
                defaultReviewScope: '_レビュー範囲は未記入です。_',
                defaultFinalConclusion: '_最終結論は未確定です。_'
            },
            templates: {
                currentProgressWithLatest: '{count} 件のマイルストーンを記録済み；最新: {latestId}',
                currentProgressEmpty: '記録済みマイルストーン 0 件',
                findingsBySeverity: '高 {high} / 中 {medium} / 低 {low}'
            }
        }
    },
    
    notifications: {
        windowsAgentStop: {
            currentWindow: '現在のウィンドウ',
            reasonLabels: {
                error: '失敗',
                awaitingUserAction: 'ユーザー操作待ち',
                continueRequired: '続行待ち'
            },
            actionLabels: {
                generatePlan: '計画を生成',
                executePlan: '計画を実行',
                continue: '続行',
                genericConfirmation: '確認'
            }
        }
    },
    
    workspace: {
        noWorkspaceOpen: 'ワークスペースが開いていません',
        singleWorkspace: 'ワークスペース: {path}',
        multiRootMode: 'マルチルートワークスペースモード:',
        useWorkspaceFormat: '特定のワークスペース内のファイルにアクセスするには「ワークスペース名/パス」形式を使用してください'
    },
    
    multimodal: {
        cannotReadFile: '{ext} ファイルを読み取れません：マルチモーダルツールが有効になっていません。チャンネル設定で「マルチモーダルツール」オプションを有効にしてください。',
        cannotReadBinaryFile: 'バイナリファイル {ext} を読み取れません：このファイル形式はサポートされていません。',
        cannotReadImage: '{ext} 画像を読み取れません：現在のチャンネルタイプは画像の読み取りをサポートしていません。',
        cannotReadDocument: '{ext} ドキュメントを読み取れません：現在のチャンネルタイプはドキュメントの読み取りをサポートしていません。OpenAI 形式は画像のみサポートし、ドキュメントはサポートしていません。'
    },
    
    webview: {
        errors: {
            noWorkspaceOpen: 'ワークスペースが開いていません',
            workspaceNotFound: 'ワークスペースが見つかりません',
            invalidFileUri: '無効なファイル URI',
            pathNotFile: 'パスがファイルではありません',
            fileNotExists: 'ファイルが存在しません',
            fileNotInWorkspace: 'ファイルが現在のワークスペースにありません',
            fileNotInAnyWorkspace: 'ファイルが開いているワークスペースにありません',
            fileInOtherWorkspace: 'ファイルは別のワークスペースに属しています: {workspaceName}',
            readFileFailed: 'ファイルの読み取りに失敗しました',
            attachmentTooLarge: 'ファイルが大きすぎます（{maxSizeMB}MB 超）。ファイル選択またはプレビューをご利用ください',
            conversationFileNotExists: '会話ファイルが存在しません',
            cannotRevealInExplorer: 'エクスプローラーで表示できません',
            
            deleteMessageFailed: 'メッセージの削除に失敗しました',
            
            interruptMessageInvalidConversation: '無効な会話 ID です',
            interruptMessageEmptyText: 'メッセージ本文を空にすることはできません',
            interruptMessageConversationNotFound: '会話が見つかりません',
            interruptMessageRateLimited: 'メッセージの挿入が頻繁すぎます。しばらくしてから再試行してください',
            interruptMessageFailed: 'メッセージの挿入に失敗しました',
            
            getModelsFailed: 'モデル一覧の取得に失敗しました',
            addModelsFailed: 'モデルの追加に失敗しました',
            removeModelFailed: 'モデルの削除に失敗しました',
            setActiveModelFailed: 'アクティブモデルの設定に失敗しました',
            
            updateUISettingsFailed: 'UI 設定の更新に失敗しました',
            getSettingsFailed: '設定の取得に失敗しました',
            updateSettingsFailed: '設定の更新に失敗しました',
            setActiveChannelFailed: 'アクティブチャンネルの設定に失敗しました',
            
            getToolsFailed: 'ツール一覧の取得に失敗しました',
            setToolEnabledFailed: 'ツールステータスの設定に失敗しました',
            getToolConfigFailed: 'ツール設定の取得に失敗しました',
            updateToolConfigFailed: 'ツール設定の更新に失敗しました',
            getAutoExecConfigFailed: '自動実行設定の取得に失敗しました',
            getMcpToolsFailed: 'MCP ツール一覧の取得に失敗しました',
            setToolAutoExecFailed: 'ツールの自動実行設定に失敗しました',
            updateListFilesConfigFailed: 'list_files 設定の更新に失敗しました',
            updateApplyDiffConfigFailed: 'apply_diff 設定の更新に失敗しました',
            updateExecuteCommandConfigFailed: 'ターミナル設定の更新に失敗しました',
            checkShellFailed: 'シェルの確認に失敗しました',
            
            killTerminalFailed: 'ターミナルの終了に失敗しました',
            getTerminalOutputFailed: 'ターミナル出力の取得に失敗しました',
            
            cancelImageGenFailed: '画像生成のキャンセルに失敗しました',
            
            cancelTaskFailed: 'タスクのキャンセルに失敗しました',
            getTasksFailed: 'タスク一覧の取得に失敗しました',
            
            getCheckpointConfigFailed: 'チェックポイント設定の取得に失敗しました',
            updateCheckpointConfigFailed: 'チェックポイント設定の更新に失敗しました',
            getCheckpointsFailed: 'チェックポイント一覧の取得に失敗しました',
            createCheckpointFailed: 'チェックポイントの作成に失敗しました',
            restoreCheckpointFailed: 'チェックポイントの復元に失敗しました',
            previewRestoreFailed: '復元のプレビューに失敗しました',
            deleteCheckpointFailed: 'チェックポイントの削除に失敗しました',
            deleteAllCheckpointsFailed: 'すべてのチェックポイントの削除に失敗しました',
            deleteCheckpointsBatchFailed: 'チェックポイントの一括削除に失敗しました',
            getConversationsWithCheckpointsFailed: 'チェックポイント付き会話の取得に失敗しました',
            previewExclusionsFailed: '除外結果のプレビューに失敗しました',
            previewExclusionsNoWorkspace: '利用可能なワークスペースルートがありません',
            getCheckpointManifestFailed: 'チェックポイントのマニフェスト取得に失敗しました',
            getCheckpointOperationProgressFailed: 'チェックポイント操作の進捗取得に失敗しました',
            cancelCheckpointOperationFailed: 'チェックポイント操作のキャンセルに失敗しました',
            
            openDiffPreviewFailed: 'diff プレビューを開くのに失敗しました',
            diffContentNotFound: 'Diff 内容が見つからないか、期限切れです',
            loadDiffContentFailed: 'Diff 内容の読み込みに失敗しました',
            invalidDiffData: '無効な diff データ',
            noFileContent: 'ファイルコンテンツがありません',
            unsupportedToolType: 'サポートされていないツールタイプ: {toolName}',
            
            getRelativePathFailed: '相対パスの取得に失敗しました',
            previewAttachmentFailed: '添付ファイルのプレビューに失敗しました',
            readImageFailed: '画像の読み取りに失敗しました',
            openFileFailed: 'ファイルを開くのに失敗しました',
            saveImageFailed: '画像の保存に失敗しました',
            
            openMcpConfigFailed: 'MCP 設定ファイルを開くのに失敗しました',
            getMcpServersFailed: 'MCP サーバー一覧の取得に失敗しました',
            validateMcpServerIdFailed: 'MCP サーバー ID の検証に失敗しました',
            createMcpServerFailed: 'MCP サーバーの作成に失敗しました',
            updateMcpServerFailed: 'MCP サーバーの更新に失敗しました',
            deleteMcpServerFailed: 'MCP サーバーの削除に失敗しました',
            connectMcpServerFailed: 'MCP サーバーへの接続に失敗しました',
            disconnectMcpServerFailed: 'MCP サーバーの切断に失敗しました',
            setMcpServerEnabledFailed: 'MCP サーバーステータスの設定に失敗しました',
            
            getSummarizeConfigFailed: '要約設定の取得に失敗しました',
            updateSummarizeConfigFailed: '要約設定の更新に失敗しました',
            summarizeFailed: 'コンテキストの要約に失敗しました',
            
            getGenerateImageConfigFailed: '画像生成設定の取得に失敗しました',
            updateGenerateImageConfigFailed: '画像生成設定の更新に失敗しました',
            
            getContextAwarenessConfigFailed: 'コンテキスト認識設定の取得に失敗しました',
            updateContextAwarenessConfigFailed: 'コンテキスト認識設定の更新に失敗しました',
            getOpenTabsFailed: '開いているタブの取得に失敗しました',
            getActiveEditorFailed: 'アクティブエディターの取得に失敗しました',
            
            getSystemPromptConfigFailed: 'システムプロンプト設定の取得に失敗しました',
            updateSystemPromptConfigFailed: 'システムプロンプト設定の更新に失敗しました',
            
            getPinnedFilesConfigFailed: 'ピン留めファイル設定の取得に失敗しました',
            checkPinnedFilesExistenceFailed: 'ファイルの存在確認に失敗しました',
            updatePinnedFilesConfigFailed: 'ピン留めファイル設定の更新に失敗しました',
            addPinnedFileFailed: 'ピン留めファイルの追加に失敗しました',
            removePinnedFileFailed: 'ピン留めファイルの削除に失敗しました',
            setPinnedFileEnabledFailed: 'ピン留めファイルステータスの設定に失敗しました',
            
            listDependenciesFailed: '依存関係一覧の取得に失敗しました',
            installDependencyFailed: '依存関係のインストールに失敗しました',
            uninstallDependencyFailed: '依存関係のアンインストールに失敗しました',
            getInstallPathFailed: 'インストールパスの取得に失敗しました',
            
            showNotificationFailed: '通知の表示に失敗しました',
            rejectToolCallsFailed: 'ツール呼び出しの拒否に失敗しました',
            
            getStorageConfigFailed: 'ストレージ設定の取得に失敗しました',
            updateStorageConfigFailed: 'ストレージ設定の更新に失敗しました',
            validateStoragePathFailed: 'ストレージパスの検証に失敗しました',
            migrateStorageFailed: 'ストレージの移行に失敗しました'
        },
        
        messages: {
            historyDiffPreview: '{filePath} (履歴差分プレビュー)',
            newFileContentPreview: '{filePath} (新規コンテンツプレビュー)',
            fullFileDiffPreview: '{filePath} (完全ファイル差分プレビュー)',
            searchReplaceDiffPreview: '{filePath} (検索置換差分プレビュー)'
        },
        dialogs: {
            selectStorageFolder: 'ストレージフォルダを選択',
            selectFolder: 'フォルダを選択'
        },

        promptSettings: {
            dynamicSection: {
                strategyTitle: '動的コンテキスト戦略',
                strategySingle: '単一の動的コンテキスト',
                strategyPreserve: '古い動的コンテキストを元の位置に保持',
                strategyDescription: '単一モードは既存の動作を維持します。保持モードでは、キャッシュ済みの古い動的コンテキストを元のターン位置に戻し、新しいコンテキストを新しいメッセージの前に挿入します。',
                strategyPreserveWarning: '保持モードはリクエストのトークン数を増やします。保持するコンテキストが多いほど、コンテキスト裁剪や要約が発生しやすくなります。',
                strategyVarsPrefix: 'プリセットエントリまたは従来テンプレートに',
                strategyVarsSeparator: '、',
                strategyVarsSuffix: 'などの変化する変数が含まれる場合、この設定は古いターンのスナップショットを保持するかどうかを決定します。',
                strategyVarsWarning: '古い動的コンテキストを元の位置に保持すると、古いターンの動的スナップショットを元の位置に固定して戻し、現在のターンに現在のコンテキストを挿入します。長いコンテキストや多数の履歴ターンに適しています。'
            },
            assemblyMode: {
                title: 'プロンプト組み立て方式',
                description: '各モードで選択できる組み立て方式は 1 つだけです：従来テンプレートまたはプリセットエントリ。',
                legacyLabel: '従来テンプレート',
                legacyDescription: 'システムプロンプトテンプレートと動的コンテキストテンプレートを使用します。',
                entriesLabel: 'プリセットエントリ',
                entriesDescription: '並べ替え可能なエントリを使用し、Chat History で実際の履歴の位置を制御します。'
            }
        }
    },

    errors: {
        unknown: '不明なエラー',
        timeout: '操作がタイムアウトしました',
        cancelled: '操作がキャンセルされました',
        networkError: 'ネットワークエラー',
        invalidRequest: '無効なリクエスト',
        internalError: '内部エラー'
    }
};

export default ja;
