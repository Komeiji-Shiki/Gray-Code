/**
 * Diff 绠＄悊鍣?- 绠＄悊寰呭闃呯殑鏂囦欢淇敼銆?
 *
 * DiffManager 璐熻矗鍏紑 API銆乨iff 棰勮涓庡伐鍏风瓑寰呰涔夛紱鍗曚釜 review 鐨?outcome 鐢?DiffReviewSession 鍗忎綔鑰呮壙杞姐€?
 *
 * 鍔熻兘锛?
 * - 绠＄悊寰呭鐞嗙殑 diff 淇敼
 * - 鏄剧ず VS Code diff 瑙嗗浘
 * - 鏀寔鑷姩淇濆瓨鍜屾墜鍔ㄥ闃呮ā寮?
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { t } from '../../i18n';

import { getDiffCodeLensProvider } from './DiffCodeLensProvider';
import {
    applyDiffToContent,
    applyStructuredDiffHunksBestEffort,
    type StructuredDiffHunk
} from './apply_diff';
import { DiffReviewSession } from './DiffReviewSession';
import { applyUnifiedDiffHunks, type UnifiedDiffHunk } from './unifiedDiff';

/**
 * 寰呭鐞嗙殑 Diff 淇敼
 */
export interface PendingDiff {
    /** 鍞竴 ID */
    id: string;
    /** 鏂囦欢璺緞锛堢浉瀵硅矾寰勶級 */
    filePath: string;
    /** 鏂囦欢缁濆璺緞 */
    absolutePath: string;
    /** 鍘熷鍐呭 */
    originalContent: string;
    /** 淇敼鍚庣殑鍐呭锛圓I 寤鸿鐨勫唴瀹癸級 */
    newContent: string;
    /**
     * 鐢ㄦ埛鏂板/鏇挎崲琛屾憳瑕侊紙浠呭綋鐢ㄦ埛淇敼浜?AI 寤鸿鏃跺瓨鍦級銆?
     *
     * 鏍煎紡锛堟瘡琛屼竴鏉¤褰曪紝澶氳鐢?`\n` 鍒嗛殧锛涚┖琛屽唴瀹逛负绌哄瓧绗︿覆锛夛細
     * - 鏂板锛歚+ | newLine | 鍐呭`  锛坣ewLine 涓虹敤鎴锋渶缁堜繚瀛樺唴瀹逛腑鐨?1-based 琛屽彿锛?
     * - 鏇挎崲锛歚~ | newLine | 鍐呭`  锛坣ewLine 涓虹敤鎴锋渶缁堜繚瀛樺唴瀹逛腑鐨?1-based 琛屽彿锛?
     * - 鍒犻櫎锛歚- | baseLine | 鍐呭` 锛坆aseLine 涓虹郴缁熷缓璁繚瀛樺唴瀹逛腑鐨?1-based 琛屽彿锛?
     */
    userEditedContent?: string;
    /** 鍒涘缓鏃堕棿 */
    timestamp: number;
    /** 鐘舵€?*/
    status: 'pending' | 'accepted' | 'rejected';
    /** 鍏宠仈鐨?diff 鍧楋紙鐢ㄤ簬 CodeLens锛?*/
    blocks?: Array<{
        index: number;
        startLine: number;
        endLine: number;
    }>;
    /** 鍘熷 diffs 鍒楄〃 */
    rawDiffs?: any[];
    /** 鍏宠仈鐨勫伐鍏?ID */
    toolId?: string;
    /** diff 璀︽垝鍊艰鍛婁俊鎭紙褰撳垹闄よ鏁拌秴杩囬槇鍊兼椂璁剧疆锛?*/
    diffGuardWarning?: string;
    /** 鍒犻櫎琛屽崰姣旓紙0-100锛岀敤浜庡墠绔樉绀猴級 */
    diffGuardDeletePercent?: number;
    /**
     * 鑷姩淇濆瓨澶辫触鍘熷洜銆?
     * 涓轰粈涔堟柊澧烇細autoSave=true 琛ㄧず宸ュ叿搴旇嚜鍔ㄦ敹鏁涳紱濡傛灉淇濆瓨澶辫触浠嶄繚鎸?pending锛屾祦寮忔彁鍓嶆墽琛屼細涓€鐩寸瓑寰呫€?
     * 鎬庝箞鏀癸細鍦ㄥ悗绔嚜鍔ㄤ繚瀛樺け璐ュ悗璁板綍閿欒骞剁粓缁?diff锛屽伐鍏风粨鏋滃彲鎹杩斿洖鏄庣‘澶辫触鐘舵€併€?
     * 鐩殑锛氶伩鍏嶈嚜鍔ㄧ‘璁ゆā寮忎笅鍑虹幇蹇呴』鐢ㄦ埛涓鐨勬偓鎸傜姸鎬併€?
     */
    autoSaveError?: string;
}

/**
 * Diff 璁剧疆
 */
export interface DiffSettings {
    /** 鏄惁鑷姩淇濆瓨 */
    autoSave: boolean;
    /** 鑷姩淇濆瓨寤惰繜锛堟绉掞級 */
    autoSaveDelay: number;
}

/**
 * 鐘舵€佸彉鍖栫洃鍚櫒
 */
type StatusChangeListener = (pending: PendingDiff[], allProcessed: boolean) => void;

/**
 * Diff 淇濆瓨鐩戝惉鍣紙褰?diff 琚疄闄呬繚瀛樺埌纾佺洏鏃惰皟鐢級
 */
type DiffSaveListener = (diff: PendingDiff) => void;

/**
 * Diff 缁撶畻绛夊緟缁撴灉銆?
 *
 * 涓轰粈涔堣鏂板锛氬涓枃浠剁紪杈戝伐鍏烽兘鍦ㄧ瓑寰?pending diff 缁撴潫锛屼絾 apply_diff 鍙潬鐘舵€佺洃鍚紝
 * 鍦ㄧ敤鎴蜂腑鏂竻鎺夎嚜鍔ㄤ繚瀛樺畾鏃跺櫒涓旀病鏈夊悗缁姸鎬佷簨浠舵椂鍙兘涓€鐩寸瓑寰呫€?
 * 鎬庝箞鏀癸細鎶娾€滄甯哥粨鏉熴€乤bort 鍙栨秷銆佺敤鎴锋柊璇锋眰涓柇鈥濇娊璞℃垚 DiffManager 绾у埆鐨勯€氱敤缁撴灉銆?
 * 鐩殑锛氭墍鏈?diff-review 宸ュ叿鍏变韩鍚屼竴濂楃敓鍛藉懆鏈熺瓑寰呰涔夛紝閬垮厤鏌愪釜宸ュ叿鐙嚜閬楁紡涓柇璺緞銆?
 */
export type DiffResolutionReason = 'none' | 'abort' | 'user';

/**
 * 鐢ㄦ埛涓柇鏍囪
 */
let userInterruptFlag = false;

/**
 * Diff 绠＄悊鍣?
 */
type DiffOp = {
    type: 'equal' | 'insert' | 'delete';
    line: string;
};

export interface CreatePendingDiffOptions {
    confirmedByToolConfirmation?: boolean;
}

function isLegacySearchReplaceDiff(d: any): d is { search: string; replace: string; start_line?: number } {
    return !!d && typeof d === 'object' && typeof d.search === 'string' && typeof d.replace === 'string';
}

function isUnifiedDiffHunk(d: any): d is UnifiedDiffHunk {
    return (
        !!d &&
        typeof d === 'object' &&
        typeof d.oldStart === 'number' &&
        typeof d.newStart === 'number' &&
        Array.isArray(d.lines)
    );
}

function isStructuredDiffHunk(d: any): d is StructuredDiffHunk {
    // 涓轰粈涔堣璇嗗埆缁撴瀯鍖?hunk锛歛pply_diff 鏂版牸寮忓瓨鍏?rawDiffs 鍚庯紝鍧楃骇鎺ュ彈/鎷掔粷闇€瑕佹寜鍚屼竴濂?oldContent/newContent 瑙勫垯閲嶆斁銆?
    // 鎬庝箞鏀癸細鐢ㄥ瓧娈靛舰鎬佸尯鍒嗭紝涓嶆柊澧炲伐鍏风被鍨嬫垨閰嶇疆鍒嗘敮锛岄伩鍏嶅墠鍚庣鍑虹幇绗笁濂楀苟琛屽崗璁€?
    // 鐩殑锛氳 DiffManager 鍦ㄧ敤鎴锋嫆缁濇煇涓潡鍚庝粛鑳藉噯纭噸绠楁渶缁堟枃浠跺唴瀹广€?
    return (
        !!d &&
        typeof d === 'object' &&
        typeof d.oldContent === 'string' &&
        typeof d.newContent === 'string'
    );
}

function splitLines(text: string): string[] {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    // 濡傛灉鏂囨湰浠ユ崲琛岀粨灏撅紝split 浼氫骇鐢熸渶鍚庝竴涓┖琛岋紝杩欓噷鍘绘帀锛岄伩鍏嶈鍙疯绠楀亸宸?
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/**
 * Myers 宸垎锛堟寜琛岋級锛岃繑鍥炴搷浣滃簭鍒?
 */
function myersDiffLines(a: string[], b: string[]): DiffOp[] {
    const n = a.length;
    const m = b.length;
    const max = n + m;

    // v[k] = x
    let v = new Map<number, number>();
    v.set(1, 0);
    const trace: Array<Map<number, number>> = [];

    for (let d = 0; d <= max; d++) {
        trace.push(new Map(v));

        const vNext = new Map<number, number>();
        for (let k = -d; k <= d; k += 2) {
            const vKMinus = v.get(k - 1) ?? 0;
            const vKPlus = v.get(k + 1) ?? 0;

            let x: number;
            if (k === -d || (k !== d && vKMinus < vKPlus)) {
                x = vKPlus; // down
            } else {
                x = vKMinus + 1; // right
            }
            let y = x - k;

            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }

            vNext.set(k, x);

            if (x >= n && y >= m) {
                // backtrack
                const ops: DiffOp[] = [];
                let bx = n;
                let by = m;

                for (let bd = d; bd >= 0; bd--) {
                    const vv = trace[bd];
                    const kk = bx - by;

                    const vvKMinus2 = vv.get(kk - 1) ?? 0;
                    const vvKPlus2 = vv.get(kk + 1) ?? 0;

                    let prevK: number;
                    if (kk === -bd || (kk !== bd && vvKMinus2 < vvKPlus2)) {
                        prevK = kk + 1;
                    } else {
                        prevK = kk - 1;
                    }

                    const prevX = vv.get(prevK) ?? 0;
                    const prevY = prevX - prevK;

                    while (bx > prevX && by > prevY) {
                        ops.push({ type: 'equal', line: a[bx - 1] });
                        bx--;
                        by--;
                    }

                    if (bd === 0) {
                        break;
                    }

                    if (bx === prevX) {
                        // insert
                        ops.push({ type: 'insert', line: b[by - 1] });
                        by--;
                    } else {
                        // delete
                        ops.push({ type: 'delete', line: a[bx - 1] });
                        bx--;
                    }
                }

                ops.reverse();
                return ops;
            }
        }

        v = vNext;
    }

    // 鏈壘鍒扮紪杈戣剼鏈椂杩斿洖绌哄彉鏇达紝鐢辫皟鐢ㄦ柟鎸夋棤宸紓澶勭悊銆?
    return [];
}

function computeUserEditedNewLinesSummary(baseContent: string, userContent: string): string {
    const a = splitLines(baseContent);
    const b = splitLines(userContent);
    const ops = myersDiffLines(a, b);

    let baseLine = 1;
    let newLine = 1;

    // replace 鐨勫垽瀹氾細鍦ㄤ笂涓€娆?equal 涔嬪悗鏄惁鍑虹幇杩?delete銆?
    // - delete 鍚庣揣璺?insert => 瑙嗕负 replace锛垀锛?
    // - 鍙湁 insert => insert锛?锛?
    let hadDeleteSinceLastEqual = false;

    const result: string[] = [];

    for (const op of ops) {
        if (op.type === 'equal') {
            hadDeleteSinceLastEqual = false;
            baseLine++;
            newLine++;
            continue;
        }

        if (op.type === 'delete') {
            // 鍒犻櫎琛岋細琛屽彿浣跨敤 baseSuggestedContent锛堢郴缁熷缓璁繚瀛樺唴瀹癸級鐨勮鍙?
            result.push(`- | ${baseLine} | ${op.line}`);
            hadDeleteSinceLastEqual = true;
            baseLine++;
            continue;
        }

        // insert锛堝寘鍚柊澧炶锛屼互鍙?replace 鐨勬柊琛岋級
        const opType = hadDeleteSinceLastEqual ? '~' : '+';
        // 鏂板/鏇挎崲琛岋細琛屽彿浣跨敤 userContent锛堢敤鎴锋渶缁堜繚瀛樺唴瀹癸級鐨勮鍙?
        result.push(`${opType} | ${newLine} | ${op.line}`);
        newLine++;
    }

    return result.join('\n');
}

export class DiffManager {
    private static instance: DiffManager | null = null;

    /** 寰呭鐞嗙殑 diff 鍒楄〃锛堝叕寮€杩斿洖鍊间粛涓?PendingDiff锛岀敓鍛藉懆鏈熺姸鎬佺敱 diffSessions 鎸佹湁鍚屼竴瀵硅薄锛?*/
    private pendingDiffs: Map<string, PendingDiff> = new Map();

    /** 鍗曚釜 diff review 鐨勫唴閮ㄧ敓鍛藉懆鏈熷崗浣滆€?*/
    private diffSessions: Map<string, DiffReviewSession> = new Map();

    /** 铏氭嫙鏂囨。鍐呭鎻愪緵鑰?*/
    private contentProvider: OriginalContentProvider;

    /** 鍐呭鎻愪緵鑰呮敞鍐?*/
    private providerDisposable: vscode.Disposable | null = null;

    /** 璁剧疆 */
    private settings: DiffSettings = {
        autoSave: false,
        autoSaveDelay: 3000
    };

    /** 鑷姩淇濆瓨瀹氭椂鍣?*/
    private autoSaveTimers: Map<string, NodeJS.Timeout> = new Map();

    /** 鐘舵€佸彉鍖栫洃鍚櫒 */
    private statusListeners: Set<StatusChangeListener> = new Set();

    /** Diff 淇濆瓨鐩戝惉鍣紙褰撴枃浠惰瀹為檯淇濆瓨鏃惰皟鐢級 */
    private saveCompleteListeners: Set<DiffSaveListener> = new Set();

    /** 鏂囨。淇濆瓨浜嬩欢鐩戝惉鍣?*/
    private saveListeners: Map<string, vscode.Disposable> = new Map();

    /** 鏂囨。鍗冲皢淇濆瓨浜嬩欢鐩戝惉鍣?*/
    private willSaveListeners: Map<string, vscode.Disposable> = new Map();

    /** 鏂囨。鍏抽棴浜嬩欢鐩戝惉鍣?*/
    private closeListeners: Map<string, vscode.Disposable> = new Map();

    /** 琚潪鎵嬪姩淇濆瓨鎵撴柇鍚庯紝闇€瑕佸湪淇濆瓨瀹屾垚鍚庢仮澶嶇殑鑽夌鍐呭 */
    private suppressedNonManualSaveDrafts: Map<string, string> = new Map();

    /** 姝ｅ湪鎵ц鎺ュ彈鍔ㄤ綔鐨?diff */
    private acceptingDiffIds: Set<string> = new Set();

    /** 姝ｅ湪鎵ц鎷掔粷鍔ㄤ綔鐨?diff */
    private rejectingDiffIds: Set<string> = new Set();

    /**
     * Diff 鍔ㄤ綔鍏ㄥ眬涓茶闃熷垪銆?
     *
     * 涓轰粈涔堣鏀癸細澶氫釜 diff 纭鍏ュ彛鍙兘鍚屾椂瑙﹀彂锛屼緥濡傚墠绔寜閽€佽嚜鍔ㄤ繚瀛樸€丆odeLens 鎴栬繛缁伐鍏疯皟鐢紝鍗曢潬 20ms 寤惰繜鍙兘闄嶄綆姒傜巼锛屼笉鑳戒繚璇?VS Code 鏂囨。淇濆瓨銆佹爣绛鹃〉鍒囨崲鍜岀姸鎬佸箍鎾寜椤哄簭鏀舵暃銆?
     * 鎬庝箞鏀癸細鐢?Promise 闃熷垪鎶婃墍鏈変細鏀瑰彉 diff 鐘舵€佹垨缂栬緫鍣ㄥ唴瀹圭殑鍔ㄤ綔涓茶鎵ц锛涙瘡涓换鍔℃棤璁烘垚鍔熷け璐ラ兘浼氶噴鏀鹃槦鍒楋紝閬垮厤鍚庣画纭琚案涔呴樆濉炪€?
     * 鐩殑锛氫粠鍗忚灞傛秷闄ゅ苟鍙戠‘璁ょ珵鎬侊紝鑰屼笉鏄緷璧栧浐瀹氭椂闂寸瓑寰呫€?
     */
    private diffActionQueue: Promise<void> = Promise.resolve();

    private constructor() {
        this.contentProvider = new OriginalContentProvider();
        this.providerDisposable = vscode.workspace.registerTextDocumentContentProvider(
            'gemini-diff-original',
            this.contentProvider
        );
    }

    /**
     * 鑾峰彇鍗曚緥瀹炰緥
     */
    public static getInstance(): DiffManager {
        if (!DiffManager.instance) {
            DiffManager.instance = new DiffManager();
        }
        return DiffManager.instance;
    }

    /**
     * 鏇存柊璁剧疆
     */
    public updateSettings(settings: Partial<DiffSettings>): void {
        this.settings = { ...this.settings, ...settings };
    }

    /**
     * 鑾峰彇褰撳墠璁剧疆
     * 浼樺厛浠庡叏灞€璁剧疆绠＄悊鍣ㄨ鍙栵紝鍚﹀垯浣跨敤鏈湴璁剧疆
     */
    public getSettings(): DiffSettings {
        const settingsManager = getGlobalSettingsManager();
        if (settingsManager) {
            const config = settingsManager.getApplyDiffConfig();
            return {
                autoSave: config.autoSave,
                autoSaveDelay: config.autoSaveDelay
            };
        }
        return { ...this.settings };
    }

    /**
     * 鍒锋柊鑷姩淇濆瓨瀹氭椂鍣紙鐢ㄤ簬杩愯鏃惰缃彉鏇达級
     *
     * 璇存槑锛?
     * - 褰撶敤鎴峰湪 diff 宸茬粡澶勪簬 pending 鐘舵€佸悗锛屾墠寮€鍚?鍏抽棴鈥滃惎鐢ㄨ嚜鍔ㄥ簲鐢ㄢ€濇垨璋冩暣寤惰繜鏃讹紝
     *   闇€瑕侀€氳繃姝ゆ柟娉曡褰撳墠宸插瓨鍦ㄧ殑 pending diff 绔嬪嵆鎸夋渶鏂伴厤缃敓鏁堛€?
     *
     * 琛屼负锛?
     * - autoSave = false锛氬彇娑堟墍鏈夊凡璋冨害鐨勮嚜鍔ㄤ繚瀛?
     * - autoSave = true锛氫负鎵€鏈?pending diff 璋冨害/閲嶇疆鑷姩淇濆瓨锛堜娇鐢ㄦ渶鏂扮殑 autoSaveDelay锛?
     */
    public refreshAutoSaveTimers(): void {
        const currentSettings = this.getSettings();

        // 鍏抽棴鑷姩淇濆瓨锛氭竻鐞嗗叏閮ㄥ畾鏃跺櫒
        if (!currentSettings.autoSave) {
            for (const timer of this.autoSaveTimers.values()) {
                clearTimeout(timer);
            }
            this.autoSaveTimers.clear();
            return;
        }

        // 寮€鍚嚜鍔ㄤ繚瀛橈細涓烘墍鏈?pending diff 璋冨害/閲嶇疆瀹氭椂鍣?
        for (const diff of this.getPendingDiffs()) {
            this.scheduleAutoSave(diff.id);
        }
    }

    /**
     * 娣诲姞鐘舵€佸彉鍖栫洃鍚櫒
     */
    public addStatusListener(listener: StatusChangeListener): void {
        this.statusListeners.add(listener);
    }

    /**
     * 绉婚櫎鐘舵€佸彉鍖栫洃鍚櫒
     */
    public removeStatusListener(listener: StatusChangeListener): void {
        this.statusListeners.delete(listener);
    }

    /**
     * 閫氱煡鐘舵€佸彉鍖?
     */
    private notifyStatusChange(): void {
        const pending = this.getPendingDiffs();
        const allProcessed = this.areAllProcessed();
        for (const listener of this.statusListeners) {
            listener(pending, allProcessed);
        }
    }

    /**
     * 娣诲姞 diff 淇濆瓨瀹屾垚鐩戝惉鍣?
     */
    public addSaveCompleteListener(listener: DiffSaveListener): void {
        this.saveCompleteListeners.add(listener);
    }

    /**
     * 绉婚櫎 diff 淇濆瓨瀹屾垚鐩戝惉鍣?
     */
    public removeSaveCompleteListener(listener: DiffSaveListener): void {
        this.saveCompleteListeners.delete(listener);
    }

    /**
     * 閫氱煡 diff 淇濆瓨瀹屾垚
     */
    private notifySaveComplete(diff: PendingDiff): void {
        for (const listener of this.saveCompleteListeners) {
            listener(diff);
        }
    }

    /**
     * 鏌愪釜 diff 鏄惁姝ｅ浜庡唴閮ㄦ帴鍙?鎷掔粷鍔ㄤ綔澶勭悊涓?
     */
    public isDiffActionInProgress(id: string): boolean {
        return this.acceptingDiffIds.has(id) || this.rejectingDiffIds.has(id);
    }

    private runDiffActionSerialized<T>(action: () => Promise<T>): Promise<T> {
        // 涓轰粈涔堜笉鐢?setTimeout(20)锛氬浐瀹氬欢杩熸棤娉曡鐩栨參纾佺洏銆佹參 VS Code 淇濆瓨銆佸涓?diff 鏍囩椤靛垏鎹㈢瓑鐪熷疄鑰楁椂宸紓銆?
        // 鎬庝箞鏀癸細鎶婁笅涓€涓姩浣滄帴鍒板綋鍓嶉槦灏句箣鍚庯紝骞舵妸闃熷熬褰掍竴鍖栦负 void Promise锛岀‘淇濆け璐ヤ笉浼氭墦鏂悗缁槦鍒椼€?
        // 鐩殑锛氳 accept/reject/block/auto-save 鐨勭姸鎬佸彉鏇村舰鎴愮‘瀹氶『搴忥紝閬垮厤骞跺彂纭閾捐矾浜掔浉鎶㈠崰銆?
        const previous = this.diffActionQueue.catch(() => undefined);
        const current = previous.then(action);
        this.diffActionQueue = current.then(
            () => undefined,
            () => undefined
        );
        return current;
    }

    /**
     * 閲婃斁 diff 鐩稿叧鐩戝惉鍣?
     */
    private disposeDiffListeners(id: string): void {
        const saveListener = this.saveListeners.get(id);
        if (saveListener) {
            saveListener.dispose();
            this.saveListeners.delete(id);
        }

        const willSaveListener = this.willSaveListeners.get(id);
        if (willSaveListener) {
            willSaveListener.dispose();
            this.willSaveListeners.delete(id);
        }

        const closeListener = this.closeListeners.get(id);
        if (closeListener) {
            closeListener.dispose();
            this.closeListeners.delete(id);
        }

        this.suppressedNonManualSaveDrafts.delete(id);
    }

    private async restorePendingDraftAfterNonManualSave(diff: PendingDiff, draftContent: string): Promise<void> {
        const fileUri = vscode.Uri.file(diff.absolutePath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === diff.absolutePath)
            || await vscode.workspace.openTextDocument(fileUri);

        const currentContent = doc.getText();
        if (currentContent === draftContent) {
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(currentContent.length)
        );
        edit.replace(fileUri, fullRange, draftContent);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            throw new Error(`Failed to restore pending diff draft for ${diff.filePath}`);
        }
    }

    private finalizeAcceptedDiff(diff: PendingDiff, options?: { partial?: boolean }): void {
        if (diff.status !== 'pending') {
            return;
        }
        const session = this.diffSessions.get(diff.id);
        const finalized = session
            ? session.accept({ partial: options?.partial ?? !!diff.userEditedContent })
            : this.finalizeLegacyPendingDiff(diff, 'accepted');
        if (!finalized) {
            return;
        }
        this.disposeDiffListeners(diff.id);
        this.cleanup(diff.id);
        this.notifyStatusChange();
        this.notifySaveComplete(diff);
    }

    private finalizeRejectedDiff(diff: PendingDiff): void {
        if (diff.status !== 'pending') {
            return;
        }
        const session = this.diffSessions.get(diff.id);
        const finalized = session
            ? session.reject()
            : this.finalizeLegacyPendingDiff(diff, 'rejected');
        if (!finalized) {
            return;
        }
        this.disposeDiffListeners(diff.id);
        this.cleanup(diff.id);
        this.notifyStatusChange();
    }

    private finalizeCancelledDiff(diff: PendingDiff): void {
        if (diff.status !== 'pending') {
            return;
        }
        const session = this.diffSessions.get(diff.id);
        const finalized = session
            ? session.cancel()
            : this.finalizeLegacyPendingDiff(diff, 'rejected');
        if (!finalized) {
            return;
        }
        this.disposeDiffListeners(diff.id);
        this.cleanup(diff.id);
    }

    private finalizeLegacyPendingDiff(diff: PendingDiff, status: PendingDiff['status']): boolean {
        diff.status = status;
        return true;
    }

    /**
     * 鍒涘缓寰呭闃呯殑 diff
     */
    private getFullApplyDiffConfig() {
        const settingsManager = getGlobalSettingsManager();
        if (settingsManager) {
            return settingsManager.getApplyDiffConfig();
        }
        return null;
    }

    /**
     * 妫€鏌?diff 璀︽垝鍊?
     * 璁＄畻鍒犻櫎琛屾暟鍗犲師濮嬫枃浠舵€昏鏁扮殑鐧惧垎姣?
     */
    private checkDiffGuard(originalContent: string, newContent: string): { warning?: string; deletePercent: number } {
        const config = this.getFullApplyDiffConfig();
        if (!config || !config.diffGuardEnabled) {
            return { deletePercent: 0 };
        }

        // 浣跨敤缁熶竴鐨勬寜琛屽垏鍒嗭紙澶勭悊 CRLF/灏鹃儴鎹㈣锛夛紝閬垮厤琛屾暟缁熻鍋忓樊
        const originalLines = splitLines(originalContent);
        const newLines = splitLines(newContent);
        const totalOriginalLines = originalLines.length;

        if (totalOriginalLines === 0) {
            return { deletePercent: 0 };
        }

        // 璁＄畻鈥滅湡瀹炲垹闄よ鏁扳€濓紙鑰岄潪鍑€琛屾暟鍙樺寲锛夛細
        // - 渚嬪 3 琛岃鍒犻櫎锛屽悓鏃舵彃鍏?1 琛岋紝鍑€鍑忓皯 2 琛岋紱
        //   浣嗗垹闄よ鏁板簲璁颁负 3 琛屻€?
        // 杩欓噷鍩轰簬 Myers diff 缁熻 delete 鎿嶄綔鏁伴噺銆?
        const ops = myersDiffLines(originalLines, newLines);
        let deletedLineCount = ops.filter(op => op.type === 'delete').length;

        // 鏋佺鍏滃簳锛氬鏋滃樊鍒嗗紓甯歌繑鍥炵┖锛岄€€鍖栦负鍑€琛屾暟鍙樺寲锛堣嚦灏戜繚璇佹湁鍊硷級
        if (ops.length === 0 && originalLines.length !== newLines.length) {
            deletedLineCount = Math.max(0, totalOriginalLines - newLines.length);
        }

        const deletePercent = Math.round((deletedLineCount / totalOriginalLines) * 100);

        if (deletePercent >= config.diffGuardThreshold) {
            const warning = t('tools.file.diffManager.diffGuardWarning', {
                deletePercent: String(deletePercent),
                threshold: String(config.diffGuardThreshold),
                deletedLines: String(deletedLineCount),
                totalLines: String(totalOriginalLines)
            });
            return { warning, deletePercent };
        }

        return { deletePercent };
    }

    /**
     * 鍒涘缓寰呭闃呯殑 diff锛堝師濮嬫柟娉曪級
     */
    public async createPendingDiff(
        filePath: string,
        absolutePath: string,
        originalContent: string,
        newContent: string,
        blocks?: Array<{ index: number; startLine: number; endLine: number }>,
        rawDiffs?: any[],
        toolId?: string,
        options?: CreatePendingDiffOptions
    ): Promise<PendingDiff> {
        const id = `diff-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const session = DiffReviewSession.create({
            id,
            filePath,
            absolutePath,
            originalContent,
            newContent,
            blocks,
            rawDiffs,
            toolCallId: toolId
        });
        const pendingDiff = session.pendingDiff;

        this.diffSessions.set(id, session);
        this.pendingDiffs.set(id, pendingDiff);

        // 妫€鏌?diff 璀︽垝鍊?
        const guardResult = this.checkDiffGuard(originalContent, newContent);
        if (guardResult.warning) {
            pendingDiff.diffGuardWarning = guardResult.warning;
        }
        pendingDiff.diffGuardDeletePercent = guardResult.deletePercent;

        // 鑾峰彇瀹屾暣閰嶇疆浠ュ喅瀹氭槸鍚﹁烦杩?diff 瑙嗗浘
        // 濡傛灉宸ュ叿璋冪敤宸茬粡缁忚繃鍘熷宸ュ叿纭锛屽苟涓斿綋鍓嶅浜庤嚜鍔ㄥ簲鐢ㄦā寮忥紝璇存槑鐢ㄦ埛宸茬粡鎵瑰噯杩欐鍐欏叆銆?
        // 姝ゆ椂鐩存帴淇濆瓨锛岄伩鍏嶁€滃伐鍏风‘璁や竴娆?+ diff 鑷姩淇濆瓨鍐嶇瓑寰呬竴娆♀€濈殑鍙岄噸纭閾捐矾銆?
        const currentSettings = this.getSettings();
        const fullConfig = this.getFullApplyDiffConfig();
        const shouldDirectApplyConfirmedToolDiff =
            options?.confirmedByToolConfirmation === true && currentSettings.autoSave === true;
        const shouldSkipDiffView = shouldDirectApplyConfirmedToolDiff ||
            (fullConfig?.autoSave && fullConfig?.autoApplyWithoutDiffView);

        // 娉ㄥ唽鍘熷鍐呭鍒版彁渚涜€咃紙浠呭湪闇€瑕佹樉绀?diff 瑙嗗浘鏃讹級
        if (!shouldSkipDiffView) {
            this.contentProvider.setContent(id, originalContent);
        }

        // 濡傛灉鏈夊潡淇℃伅涓斾笉璺宠繃 diff 瑙嗗浘锛屾敞鍐屽埌 CodeLens 鎻愪緵鑰?
        if (blocks && !shouldSkipDiffView) {
            const provider = getDiffCodeLensProvider();
            provider.addSession({
                id,
                filePath,
                absolutePath,
                blocks: blocks.map(b => ({ ...b, confirmed: false, rejected: false })),
                originalContent,
                newContent,
                timestamp: Date.now()
            });

            // 璁剧疆鍥炶皟
            provider.setConfirmCallback(async (sessionId, blockIndex) => {
                if (blockIndex === undefined) {
                    await this.acceptDiff(sessionId, true);
                } else {
                    await this.confirmBlock(sessionId, blockIndex);
                }
            });

            provider.setRejectCallback(async (sessionId, blockIndex) => {
                if (blockIndex === undefined) {
                    await this.rejectDiff(sessionId);
                } else {
                    await this.rejectBlock(sessionId, blockIndex);
                }
            });
        }

        // 鏍规嵁閰嶇疆鍐冲畾鏄惁鏄剧ず diff 瑙嗗浘
        if (shouldSkipDiffView) {
            // 璺宠繃 diff 瑙嗗浘锛氱洿鎺ュ啓鍏ユ枃浠跺苟淇濆瓨
            await this.directApplyAndSave(pendingDiff);
        } else {
            // 鏄剧ず diff 瑙嗗浘
            try {
                await this.showDiffView(pendingDiff);
            } catch (error) {
                console.warn(
                    `[DiffManager] Failed to open diff view for ${filePath}; keeping pending diff available for manual apply/reject.`,
                    error
                );
            }
        }

        // 濡傛灉寮€鍚嚜鍔ㄤ繚瀛樹笖 diff 浠嶅浜?pending 鐘舵€侊紝璁剧疆瀹氭椂鍣?
        if (pendingDiff.status === 'pending') {
            const currentSettings = this.getSettings();
            if (currentSettings.autoSave) {
                this.scheduleAutoSave(id);
            }
        }

        // 閫氱煡鐘舵€佸彉鍖?
        this.notifyStatusChange();

        return pendingDiff;
    }

    /**
     * 鐩存帴搴旂敤淇敼骞朵繚瀛橈紙涓嶆墦寮€ diff 瑙嗗浘锛?
     * 鐢ㄤ簬 autoApplyWithoutDiffView 妯″紡
     */
    private async directApplyAndSave(diff: PendingDiff): Promise<void> {
        try {
            // 鐩存帴鍐欏叆鏂囦欢鍒扮鐩?
            fs.writeFileSync(diff.absolutePath, diff.newContent, 'utf8');

            // 濡傛灉鏂囨。宸插湪缂栬緫鍣ㄤ腑鎵撳紑锛屽垯鍒锋柊瀹?
            const uri = vscode.Uri.file(diff.absolutePath);
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === diff.absolutePath);
            if (openDoc) {
                // revert 璁?VSCode 浠庣鐩橀噸鏂板姞杞?
                try {
                    // 鍏?focus 鍒拌鏂囨。锛岀劧鍚?revert
                    await vscode.window.showTextDocument(openDoc, { preview: false, preserveFocus: true });
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                } catch {
                    // ignore
                }
            }

            // 鏍囪涓哄凡鎺ュ彈
            this.finalizeAcceptedDiff(diff);

            vscode.window.setStatusBarMessage(
                `$(check) ${t('tools.file.diffManager.savedShort', { filePath: diff.filePath })}`,
                3000
            );
        } catch (error) {
            console.error('[DiffManager] directApplyAndSave failed:', error);
            // 鍥為€€鍒版樉绀?diff 瑙嗗浘
            await this.showDiffView(diff);
        }
    }

    /**
     * 纭鍗曚釜鍧?
     */
    public async confirmBlock(sessionId: string, blockIndex: number): Promise<void> {
        await this.runDiffActionSerialized(() => this.confirmBlockUnlocked(sessionId, blockIndex));
    }

    private async confirmBlockUnlocked(sessionId: string, blockIndex: number): Promise<void> {
        this.diffSessions.get(sessionId)?.markPresented();
        const provider = getDiffCodeLensProvider();
        provider.updateBlockStatus(sessionId, blockIndex, true);

        // 濡傛灉鎵€鏈夊潡閮藉鐞嗗畬浜嗭紝鑷姩缁撴潫鏁翠釜 diff
        if (provider.isSessionComplete(sessionId)) {
            const session = provider.getSession(sessionId);
            // 鐞嗚涓?confirmBlock 涓€瀹氫細鏈?confirmed锛屽洜姝や笉澶彲鑳?allRejected锛屼絾杩欓噷浠嶅仛淇濇姢
            const allRejected = !!session && session.blocks.length > 0 && session.blocks.every(b => b.rejected);
            if (allRejected) {
                await this.rejectDiffUnlocked(sessionId);
            } else {
                await this.acceptDiffUnlocked(sessionId, true);
            }
        }
    }

    /**
     * 鎷掔粷鍗曚釜鍧?
     */
    public async rejectBlock(sessionId: string, blockIndex: number): Promise<void> {
        await this.runDiffActionSerialized(() => this.rejectBlockUnlocked(sessionId, blockIndex));
    }

    private async rejectBlockUnlocked(sessionId: string, blockIndex: number): Promise<void> {
        this.diffSessions.get(sessionId)?.markPresented();
        const provider = getDiffCodeLensProvider();
        provider.updateBlockStatus(sessionId, blockIndex, false);

        // 瀹炴椂鏇存柊缂栬緫鍣ㄥ唴瀹癸紝绉婚櫎琚嫆缁濈殑鍧?
        const diff = this.pendingDiffs.get(sessionId);
        if (diff && diff.rawDiffs && diff.rawDiffs.length > 0) {
            let tempContent = diff.originalContent;
            const session = provider.getSession(sessionId);
            if (session) {
                // 鏈闇€瑕佸簲鐢ㄧ殑鍧楋紙鏈鎷掔粷锛?
                const applyIndices = new Set<number>();
                for (let i = 0; i < diff.rawDiffs.length; i++) {
                    const blockInfo = session.blocks.find(b => b.index === i);
                    if (blockInfo && !blockInfo.rejected) {
                        applyIndices.add(i);
                    }
                }

                const first = diff.rawDiffs[0];

                if (isStructuredDiffHunk(first)) {
                    // 涓轰粈涔堢粨鏋勫寲 hunk 瑕佷紭鍏堝鐞嗭細瀹冨拰 legacy search/replace 瀛楁鍚嶄笉鍚岋紝浣嗗悓鏍烽渶瑕佹敮鎸佸潡绾ф嫆缁濆悗鐨勫唴瀹归噸绠椼€?
                    // 鎬庝箞鏀癸細澶嶇敤 apply_diff 瀵煎嚭鐨勭粨鏋勫寲搴旂敤鍑芥暟锛屽苟浼犲叆鏈嫆缁濆潡绱㈠紩闆嗗悎銆?
                    // 鐩殑锛氶伩鍏嶆嫆缁濇煇涓?hunk 鍚庣敤鏃?start_line 閫昏緫璇畻鍚庣画閲嶅鍐呭銆?
                    try {
                        const hunks = diff.rawDiffs as StructuredDiffHunk[];
                        const r = applyStructuredDiffHunksBestEffort(tempContent, hunks, { applyIndices });
                        tempContent = r.newContent;

                        for (const h of r.blocks) {
                            const blockInfo = session.blocks.find(b => b.index === h.index);
                            if (blockInfo) {
                                blockInfo.startLine = h.startLine;
                                blockInfo.endLine = h.endLine;
                            }
                        }
                    } catch (e) {
                        console.warn('[DiffManager] Failed to recompute structured diff content after rejecting a block:', e);
                    }
                } else if (isUnifiedDiffHunk(first)) {
                    // unified diff hunks锛氶噸鏂颁粠 originalContent 璁＄畻鈥滀粎鍖呭惈鏈嫆缁濆潡鈥濈殑鏈€缁堝唴瀹?
                    try {
                        const hunks = diff.rawDiffs as UnifiedDiffHunk[];
                        const r = applyUnifiedDiffHunks(tempContent, hunks, { applyIndices });
                        tempContent = r.newContent;

                        // 鏇存柊鍚勫潡鍦ㄥ綋鍓嶅唴瀹逛腑鐨勮寖鍥?
                        for (const h of r.appliedHunks) {
                            const blockInfo = session.blocks.find(b => b.index === h.index);
                            if (blockInfo) {
                                blockInfo.startLine = h.startLine;
                                blockInfo.endLine = h.endLine;
                            }
                        }
                    } catch (e) {
                        console.warn('[DiffManager] Failed to recompute unified diff content after rejecting a block:', e);
                    }
                } else {
                    // legacy search/replace diffs锛堝悜鍚庡吋瀹癸級
                    for (let i = 0; i < diff.rawDiffs.length; i++) {
                        const blockInfo = session.blocks.find(b => b.index === i);
                        const d = diff.rawDiffs[i];
                        if (!blockInfo || blockInfo.rejected || !isLegacySearchReplaceDiff(d)) {
                            continue;
                        }

                        const replaceLines = d.replace.split('\n').length;

                        const result = applyDiffToContent(tempContent, d.search, d.replace, d.start_line);
                        if (result.success && result.matchedLine !== undefined) {
                            tempContent = result.result;

                            // 鏇存柊姝ゅ潡鍦ㄥ綋鍓嶅唴瀹逛腑鐨勮寖鍥?
                            blockInfo.startLine = result.matchedLine;
                            blockInfo.endLine = result.matchedLine + replaceLines - 1;
                        }
                    }
                }

                // 鏇存柊缂栬緫鍣?
                const uri = vscode.Uri.file(diff.absolutePath);
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === diff.absolutePath);
                if (doc) {
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        doc.positionAt(0),
                        doc.positionAt(doc.getText().length)
                    );
                    edit.replace(uri, fullRange, tempContent);
                    await vscode.workspace.applyEdit(edit);
                }
            }
        }

        // 濡傛灉鎵€鏈夊潡閮藉鐞嗗畬浜嗭紝鑷姩缁撴潫
        if (provider.isSessionComplete(sessionId)) {
            const session = provider.getSession(sessionId);
            const allRejected = !!session && session.blocks.length > 0 && session.blocks.every(b => b.rejected);

            // 鍏ㄩ儴鍧楅兘琚嫆缁濓細瑙嗕负鐢ㄦ埛鏄庣‘鎷掔粷鏈 diff锛堜笉淇濆瓨浠讳綍鏇存敼锛?
            if (allRejected) {
                await this.rejectDiffUnlocked(sessionId);
            } else {
                // 閮ㄥ垎鎺ュ彈/閮ㄥ垎鎷掔粷锛氫繚瀛樷€滃墿浣欐帴鍙楃殑鍧椻€?
                await this.acceptDiffUnlocked(sessionId, true);
            }
        }
    }

    private hasRejectedBlocks(id: string): boolean {
        const session = getDiffCodeLensProvider().getSession(id);
        return !!session && session.blocks.some(b => b.rejected);
    }

    private computeFinalSuggestedContent(id: string, diff: PendingDiff): string {
        // 璁＄畻鏈€缁堝唴瀹癸紙浠呭寘鍚凡纭鐨勫潡锛?
        let finalContent = diff.newContent;

        if (!diff.rawDiffs || diff.rawDiffs.length === 0) {
            return finalContent;
        }

        const provider = getDiffCodeLensProvider();
        const session = provider.getSession(id);
        if (!session) {
            return finalContent;
        }

        const rejectedBlocks = session.blocks.filter(b => b.rejected);
        if (rejectedBlocks.length === 0) {
            return finalContent;
        }

        // 鏈夎鎷掔粷鐨勫潡锛岄噸鏂拌绠楀唴瀹?
        finalContent = diff.originalContent;

        // 闇€瑕佸簲鐢ㄧ殑鍧楋紙鏈鎷掔粷锛?
        const applyIndices = new Set<number>();
        for (let i = 0; i < diff.rawDiffs.length; i++) {
            const blockInfo = session.blocks.find(b => b.index === i);
            if (blockInfo && !blockInfo.rejected) {
                applyIndices.add(i);
            }
        }

        const first = diff.rawDiffs[0];

        if (isStructuredDiffHunk(first)) {
            // 涓轰粈涔?finalContent 涔熻鏀寔缁撴瀯鍖?hunk锛氫繚瀛樺墠浼氭牴鎹敤鎴锋嫆缁濈殑鍧楅噸鏂拌绠楁渶缁堝缓璁唴瀹广€?
            // 鎬庝箞鏀癸細澶嶇敤鍚屼竴涓粨鏋勫寲搴旂敤鍑芥暟锛屽彧搴旂敤鏈嫆缁濈殑 hunk 绱㈠紩銆?
            // 鐩殑锛氱‘淇濈紪杈戝櫒瀹炴椂鍐呭鍜屾渶缁堣惤鐩樺唴瀹逛娇鐢ㄥ畬鍏ㄤ竴鑷寸殑閲嶆斁瑙勫垯銆?
            try {
                const hunks = diff.rawDiffs as StructuredDiffHunk[];
                const r = applyStructuredDiffHunksBestEffort(finalContent, hunks, { applyIndices });
                finalContent = r.newContent;
            } catch (e) {
                console.warn('[DiffManager] Failed to recompute final suggested content for structured diff:', e);
            }
        } else if (isUnifiedDiffHunk(first)) {
            // unified diff hunks
            try {
                const hunks = diff.rawDiffs as UnifiedDiffHunk[];
                const r = applyUnifiedDiffHunks(finalContent, hunks, { applyIndices });
                finalContent = r.newContent;
            } catch (e) {
                console.warn('[DiffManager] Failed to recompute final suggested content for unified diff:', e);
            }
        } else {
            // legacy search/replace diffs
            for (let i = 0; i < diff.rawDiffs.length; i++) {
                const blockInfo = session.blocks.find(b => b.index === i);
                const d = diff.rawDiffs[i];
                if (!blockInfo || blockInfo.rejected || !isLegacySearchReplaceDiff(d)) {
                    continue;
                }

                const result = applyDiffToContent(finalContent, d.search, d.replace, d.start_line);
                if (result.success) {
                    finalContent = result.result;
                }
            }
        }

        return finalContent;
    }

    /**
     * 鏄剧ず鍐呰仈 diff 瑙嗗浘
     */
    private async showDiffView(diff: PendingDiff): Promise<void> {
        const fileUri = vscode.Uri.file(diff.absolutePath);
        this.diffSessions.get(diff.id)?.markPresented();

        const isPending = () => diff.status === 'pending';

        const restoreToOriginalBestEffort = async (): Promise<void> => {
            try {
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === diff.absolutePath);
                const targetDoc = doc || (await vscode.workspace.openTextDocument(fileUri));
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                    targetDoc.positionAt(0),
                    targetDoc.positionAt(targetDoc.getText().length)
                );
                edit.replace(fileUri, fullRange, diff.originalContent);
                await vscode.workspace.applyEdit(edit);
            } catch {
                // ignore
            }
        };

        // 濡傛灉鍦ㄨ繘鍏?showDiffView 涔嬪墠灏卞凡琚鐞嗭紙渚嬪 cancelAllPending 鍏堜竴姝ュ彂鐢燂級锛岀洿鎺ョ煭璺?
        if (!isPending()) {
            return;
        }

        // 1. 鎵撳紑骞朵慨鏀圭洰鏍囨枃浠讹紙涓嶄繚瀛橈級
        const document = await vscode.workspace.openTextDocument(fileUri);
        if (!isPending()) {
            return;
        }
        const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false
        });
        if (!isPending()) {
            return;
        }

        // 搴旂敤淇敼
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );

        await editor.edit((editBuilder) => {
            editBuilder.replace(fullRange, diff.newContent);
        });

        // 鑻ュ湪 apply edit 杩囩▼涓鍙栨秷/鎷掔粷锛岀珛鍗虫仮澶嶅師濮嬪唴瀹瑰苟閫€鍑猴紝閬垮厤鐣欎笅鑴忔枃妗?
        if (!isPending()) {
            await restoreToOriginalBestEffort();
            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch {
                // ignore
            }
            return;
        }

        // 2. 鍒涘缓鍘熷鍐呭鐨勮櫄鎷?URI
        const originalUri = vscode.Uri.parse(`gemini-diff-original:${diff.id}/${path.basename(diff.filePath)}`);

        // 4. 鎵撳紑 diff 瑙嗗浘
        const title = t('tools.file.diffManager.diffTitle', { filePath: diff.filePath });
        if (!isPending()) {
            await restoreToOriginalBestEffort();
            return;
        }
        await vscode.commands.executeCommand('vscode.diff', originalUri, fileUri, title, {
            preview: false
        });

        // 鑻ュ湪鎵撳紑 diff 瑙嗗浘鏈熼棿琚彇娑?鎷掔粷锛屽叧闂?diff 骞舵仮澶嶅師濮嬪唴瀹癸紝閬垮厤 UI 娈嬬暀
        if (!isPending()) {
            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch {
                // ignore
            }
            await restoreToOriginalBestEffort();
            return;
        }

        // 5. 鐩戝惉鏂囨。鍗冲皢淇濆瓨浜嬩欢
        const willSaveListener = vscode.workspace.onWillSaveTextDocument((event) => {
            if (event.document.uri.fsPath !== diff.absolutePath || diff.status !== 'pending') {
                return;
            }

            if (this.isDiffActionInProgress(diff.id)) {
                return;
            }

            const currentSettings = this.getSettings();
            if (currentSettings.autoSave || event.reason === vscode.TextDocumentSaveReason.Manual) {
                return;
            }

            const currentDraftContent = event.document.getText();
            this.suppressedNonManualSaveDrafts.set(diff.id, currentDraftContent);

            const fullRange = new vscode.Range(
                event.document.positionAt(0),
                event.document.positionAt(currentDraftContent.length)
            );

            event.waitUntil(Promise.resolve([
                vscode.TextEdit.replace(fullRange, diff.originalContent)
            ]));
        });

        // 6. 鐩戝惉鏂囨。淇濆瓨浜嬩欢
        const saveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
            if (savedDoc.uri.fsPath !== diff.absolutePath || diff.status !== 'pending') {
                return;
            }

            if (this.isDiffActionInProgress(diff.id)) {
                return;
            }

            const suppressedDraft = this.suppressedNonManualSaveDrafts.get(diff.id);
            if (suppressedDraft !== undefined) {
                this.suppressedNonManualSaveDrafts.delete(diff.id);
                try {
                    await this.restorePendingDraftAfterNonManualSave(diff, suppressedDraft);
                } catch (error) {
                    console.warn(
                        `[DiffManager] Failed to restore pending diff draft after non-manual save for ${diff.filePath}:`,
                        error
                    );
                }
                return;
            }

            // 妫€鏌ョ敤鎴锋槸鍚︿慨鏀逛簡鍐呭锛堜繚瀛樻椂鐨勬渶缁堝唴瀹癸級
            const savedContent = savedDoc.getText();

            if (savedContent === diff.originalContent) {
                this.finalizeRejectedDiff(diff);

                const currentSettings = this.getSettings();
                if (!currentSettings.autoSave) {
                    await this.closeDiffTab(diff.absolutePath);
                }
                return;
            }

            // 浠モ€滅郴缁熷缓璁皢淇濆瓨鐨勫唴瀹光€濅负鍩哄噯锛堣€冭檻 CodeLens 鎷掔粷鍧楃瓑锛?
            const baseSuggestedContent = this.computeFinalSuggestedContent(diff.id, diff);

            if (savedContent !== baseSuggestedContent && savedContent !== diff.originalContent) {
                // 浠呬繚鐣欐憳瑕侊紝涓嶅湪宸ュ叿鍝嶅簲閲屽彂閫佸畬鏁存枃浠跺唴瀹?
                diff.userEditedContent = computeUserEditedNewLinesSummary(baseSuggestedContent, savedContent);
            }

            this.finalizeAcceptedDiff(diff, { partial: !!diff.userEditedContent || this.hasRejectedBlocks(diff.id) });

            // 闈炶嚜鍔ㄤ繚瀛樻ā寮忎笅锛岀敤鎴锋墜鍔ㄤ繚瀛樺悗鑷姩鍏抽棴 diff 鏍囩椤?
            const currentSettings = this.getSettings();
            if (!currentSettings.autoSave) {
                await this.closeDiffTab(diff.absolutePath);
            }
        });

        // 7. 鐩戝惉鏂囨。鍏抽棴浜嬩欢
        const closeListener = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
            if (closedDoc.uri.fsPath !== diff.absolutePath || diff.status !== 'pending') {
                return;
            }

            if (this.isDiffActionInProgress(diff.id)) {
                return;
            }

            try {
                const currentContent = fs.readFileSync(diff.absolutePath, 'utf8');
                if (currentContent !== diff.newContent) {
                    this.finalizeRejectedDiff(diff);
                }
            } catch (e) {
                // 蹇界暐閿欒
            }
        });

        // 鑻ュ湪娉ㄥ唽鐩戝惉鍣ㄦ湡闂磋鍙栨秷/鎷掔粷锛岀珛鍗抽噴鏀剧洃鍚櫒骞舵仮澶嶅唴瀹癸紝閬垮厤娈嬬暀璁㈤槄閫犳垚鍚庣画閿欎贡
        if (!isPending()) {
            try {
                willSaveListener.dispose();
            } catch {
                // ignore
            }
            try {
                saveListener.dispose();
            } catch {
                // ignore
            }
            try {
                closeListener.dispose();
            } catch {
                // ignore
            }
            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch {
                // ignore
            }
            await restoreToOriginalBestEffort();
            return;
        }

        this.willSaveListeners.set(diff.id, willSaveListener);
        this.saveListeners.set(diff.id, saveListener);
        this.closeListeners.set(diff.id, closeListener);
    }

    /**
     * 璁剧疆鑷姩淇濆瓨瀹氭椂鍣?
     */
    private scheduleAutoSave(id: string): void {
        const existingTimer = this.autoSaveTimers.get(id);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const currentSettings = this.getSettings();
        const session = this.diffSessions.get(id);
        const runAutoSave = async () => {
            // 鑷姩淇濆瓨锛氬己鍒朵娇鐢?AI 寤鸿鐨勫唴瀹癸紙閬垮厤瑕嗙洊鐢ㄦ埛鍙兘姝ｅ湪杩涜鐨勬墜鍔ㄤ慨鏀癸級
            const accepted = await this.acceptDiff(id, true, true);
            if (!accepted) {
                // 鑷姩淇濆瓨澶辫触蹇呴』浠ユ槑纭?rejected 鏀舵暃锛屽惁鍒欑瓑寰?diff 缁撴潫鐨勫伐鍏?Promise 浼氭案涔?pending銆?
                await this.finalizeAutoSaveFailure(id, 'Auto-save failed while accepting diff. The diff was rejected to unblock tool execution.');
            }
            this.autoSaveTimers.delete(id);
        };

        const timer = session
            ? session.scheduleAutoSave(currentSettings.autoSaveDelay, runAutoSave)
            : setTimeout(runAutoSave, currentSettings.autoSaveDelay);

        this.autoSaveTimers.set(id, timer);
    }

    private async finalizeAutoSaveFailure(id: string, message: string): Promise<void> {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending') {
            return;
        }

        // 淇濈暀 acceptDiff 鎹曡幏鍒扮殑搴曞眰淇濆瓨閿欒锛涜繖閲屼粎琛ュ厖鑷姩淇濆瓨鏀舵暃璇箟锛岄伩鍏嶈鐩栫湡瀹炲紓甯搞€?
        diff.autoSaveError = diff.autoSaveError
            ? `${message} ${diff.autoSaveError}`
            : message;

        const rejected = await this.rejectDiff(id);
        if (rejected) {
            return;
        }

        // rejectDiff 涔熷け璐ユ椂鍙噴鏀剧瓑寰呬腑鐨勫伐鍏?Promise锛屼笉鍐嶅皾璇曚繚瀛樻垨鎭㈠锛岄伩鍏嶉噸澶嶈Е鍙?VS Code 缂栬緫鍣ㄧ珵鎬併€?
        this.finalizeRejectedDiff(diff);
    }

    /**
     * 鎺ュ彈 diff锛堜繚瀛樹慨鏀癸級
     * @param id diff ID
     * @param closeTab 鏄惁鍏抽棴鏍囩椤?
     * @param isAutoSave 鏄惁涓鸿嚜鍔ㄤ繚瀛橈紙鑷姩淇濆瓨鏃跺己鍒朵娇鐢?AI 鍐呭锛涙墜鍔ㄦ帴鍙楁椂灏介噺淇濈暀鐢ㄦ埛缂栬緫锛?
     */
    public async acceptDiff(id: string, closeTab: boolean = false, isAutoSave: boolean = false): Promise<boolean> {
        return this.runDiffActionSerialized(() => this.acceptDiffUnlocked(id, closeTab, isAutoSave));
    }

    private async acceptDiffUnlocked(id: string, closeTab: boolean = false, isAutoSave: boolean = false): Promise<boolean> {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending' || this.isDiffActionInProgress(id)) {
            return false;
        }

        this.acceptingDiffIds.add(id);

        try {
            const finalContent = this.computeFinalSuggestedContent(id, diff);

            const uri = vscode.Uri.file(diff.absolutePath);
            let doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === diff.absolutePath);

            // 濡傛灉鏂囨。鏈墦寮€锛屽厛鎵撳紑瀹?
            if (!doc) {
                doc = await vscode.workspace.openTextDocument(uri);
            }

            const currentContent = doc.getText();

            // 鑷姩淇濆瓨锛氬己鍒朵繚瀛?AI 璁＄畻鍑烘潵鐨?finalContent銆?
            // 鎵嬪姩鎺ュ彈锛氬鏋滅敤鎴峰湪缂栬緫鍣ㄤ腑鏀硅繃鍐呭锛屽垯淇濈暀褰撳墠鍐呭锛屼笉瑕嗙洊銆?
            let contentToSave = finalContent;

            if (isAutoSave || currentContent === diff.originalContent) {
                // 瑕嗙洊鍒?finalContent锛堣嚜鍔ㄤ繚瀛?/ 鏂囨。浠嶆槸鍘熷鍐呭鏃讹級
                if (currentContent !== finalContent) {
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        doc.positionAt(0),
                        doc.positionAt(currentContent.length)
                    );
                    edit.replace(uri, fullRange, finalContent);
                    const applied = await vscode.workspace.applyEdit(edit);
                    if (!applied) {
                        throw new Error(`Failed to stage accepted diff content for ${diff.filePath}`);
                    }
                }
                contentToSave = finalContent;
            } else {
                // currentContent != original => 璁や负鐢ㄦ埛宸茬粡鍦?AI 寤鸿涓婂仛浜嗚皟鏁达紙鍖呭惈鎵嬪姩缂栬緫/鎷掔粷閮ㄥ垎鍧楋級
                if (currentContent !== finalContent) {
                    diff.userEditedContent = computeUserEditedNewLinesSummary(finalContent, currentContent);
                }
                contentToSave = currentContent;
            }

            const normalizeToLF = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            const revertOpenDocumentToDisk = async (): Promise<void> => {
                try {
                    // 鍏抽敭锛氫娇鐢?revert 涓㈠純鑴忕姸鎬佸苟浠庣鐩橀噸鏂板姞杞斤紝閬垮厤 VSCode 鈥滄枃浠跺唴瀹硅緝鏂扳€濅繚瀛樺啿绐佹彁绀?
                    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                } catch {
                    // ignore
                }
            };

            // 璇诲彇纾佺洏鍐呭锛岀敤浜庡垽鏂槸鍚﹂渶瑕佺粫杩?doc.save锛坉oc.save 鍦ㄧ鐩樺彉鏇存椂浼氳Е鍙?VSCode 鍐茬獊鎻愮ず锛?
            let diskContent: string | undefined;
            try {
                diskContent = fs.readFileSync(diff.absolutePath, 'utf8');
            } catch {
                diskContent = undefined;
            }

            const saveNormalized = normalizeToLF(contentToSave);
            const diskNormalized = diskContent !== undefined ? normalizeToLF(diskContent) : undefined;
            const originalNormalized = normalizeToLF(diff.originalContent);

            // 1) 鑻ョ鐩樺唴瀹瑰凡缁忕瓑浜庤淇濆瓨鐨勫唴瀹癸細鏃犻渶淇濆瓨锛岀洿鎺?revert 娓呯悊 dirty锛堥伩鍏嶅啿绐佹彁绀猴級
            if (diskNormalized !== undefined && diskNormalized === saveNormalized) {
                if (doc.isDirty) {
                    await revertOpenDocumentToDisk();
                }
            }
            // 2) 鑻ョ鐩樺唴瀹瑰凡涓嶅悓浜?diff 鍒涘缓鏃剁殑 originalContent锛氳鏄庝腑閫旇澶栭儴鍐欏叆/鍥炴粴锛岀粫杩?doc.save 寮哄埗鍐欏叆鍚庡啀 revert
            else if (diskNormalized !== undefined && diskNormalized !== originalNormalized) {
                fs.writeFileSync(diff.absolutePath, contentToSave, 'utf8');
                await revertOpenDocumentToDisk();
            }
            // 3) 纾佺洏浠嶄负 originalContent锛氳蛋 doc.save 蹇矾寰勶紙淇濈暀 VSCode 鐨勭紪鐮?鎹㈣绛変繚瀛樼瓥鐣ワ級
            else {
                let saved = false;
                try {
                    saved = await doc.save();
                } catch {
                    saved = false;
                }

                if (!saved) {
                    // 濡傛灉 VSCode API 淇濆瓨澶辫触锛屽皾璇曠洿鎺ュ啓鍏ユ枃浠?
                    fs.writeFileSync(diff.absolutePath, contentToSave, 'utf8');
                    await revertOpenDocumentToDisk();
                }
            }

            this.finalizeAcceptedDiff(diff, { partial: !!diff.userEditedContent || this.hasRejectedBlocks(id) });

            try {
                vscode.window.setStatusBarMessage(`$(check) ${t('tools.file.diffManager.savedShort', { filePath: diff.filePath })}`, 3000);
            } catch (error) {
                console.warn(`[DiffManager] Failed to show accepted status for ${diff.filePath}:`, error);
            }

            if (closeTab) {
                try {
                    await this.closeDiffTab(diff.absolutePath);
                } catch (error) {
                    console.warn(`[DiffManager] Failed to close diff tab for ${diff.filePath}:`, error);
                }
            }

            return true;
        } catch (error) {
            const message = t('tools.file.diffManager.saveFailed', { error: error instanceof Error ? error.message : String(error) });
            if (diff) {
                diff.autoSaveError = message;
            }
            vscode.window.showErrorMessage(message);
            return false;
        } finally {
            this.acceptingDiffIds.delete(id);
        }
    }

    /**
     * 鍏抽棴鎸囧畾鏂囦欢鐨?diff 鏍囩椤?
     */
    private async closeDiffTab(filePath: string): Promise<void> {
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof vscode.TabInputTextDiff) {
                    const diffInput = tab.input as vscode.TabInputTextDiff;
                    if (diffInput.modified.fsPath === filePath) {
                        await vscode.window.tabGroups.close(tab);
                        return;
                    }
                }
            }
        }
    }

    /**
     * 鎷掔粷 diff锛堟斁寮冧慨鏀癸級
     */
    public async rejectDiff(id: string): Promise<boolean> {
        return this.runDiffActionSerialized(() => this.rejectDiffUnlocked(id));
    }

    private async rejectDiffUnlocked(id: string): Promise<boolean> {
        const diff = this.pendingDiffs.get(id);
        if (!diff || diff.status !== 'pending' || this.isDiffActionInProgress(id)) {
            return false;
        }

        this.rejectingDiffIds.add(id);

        try {
            // 1. 鎭㈠鏂囦欢鍐呭
            const uri = vscode.Uri.file(diff.absolutePath);
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === diff.absolutePath);

            if (doc) {
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                    doc.positionAt(0),
                    doc.positionAt(doc.getText().length)
                );
                edit.replace(uri, fullRange, diff.originalContent);
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    throw new Error(`Failed to restore original content for ${diff.filePath}`);
                }

                // 濡傛灉鏂囦欢鏇剧粡琚繚瀛樿繃锛堣剰浜嗭級锛岃繖閲屾垜浠笉寮哄埗淇濆瓨锛屽洜涓虹敤鎴锋嫆缁濅簡 AI 鐨勪慨鏀广€?
                // 浣嗗鏋滄枃浠跺湪 AI 淇敼鍓嶅氨鏄共鍑€鐨勶紝AI 淇敼璁╁畠鍙樿剰浜嗭紝鎴戜滑鐜板湪鎭㈠浜嗗師濮嬪唴瀹癸紝瀹冨簲璇ュ彉鍥炲共鍑€锛堟垨鑰呴€氳繃 undo锛夈€?
            } else {
                // 濡傛灉鏂囨。娌℃墦寮€锛岀洿鎺ュ啓鍥炲師濮嬫枃浠跺唴瀹圭‘淇濅竾鏃犱竴澶?
                fs.writeFileSync(diff.absolutePath, diff.originalContent, 'utf8');
            }

            this.finalizeRejectedDiff(diff);

            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch (error) {
                console.warn(`[DiffManager] Failed to close rejected diff tab for ${diff.filePath}:`, error);
            }

            return true;
        } catch (error) {
            console.error('Failed to reject diff:', error);
            return false;
        } finally {
            this.rejectingDiffIds.delete(id);
        }
    }

    /**
     * 鎺ュ彈鎵€鏈夊緟澶勭悊鐨?diff
     */
    public async acceptAll(): Promise<number> {
        let count = 0;
        for (const [id, diff] of this.pendingDiffs.entries()) {
            if (diff.status === 'pending') {
                const success = await this.acceptDiff(id);
                if (success) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * 鎷掔粷鎵€鏈夊緟澶勭悊鐨?diff
     */
    public async rejectAll(): Promise<number> {
        let count = 0;
        for (const [id, diff] of this.pendingDiffs.entries()) {
            if (diff.status === 'pending') {
                const success = await this.rejectDiff(id);
                if (success) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * 娓呯悊璧勬簮
     */
    private cleanup(id: string): void {
        const timer = this.autoSaveTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.autoSaveTimers.delete(id);
        }
        this.diffSessions.get(id)?.clearAutoSave();

        this.contentProvider.removeContent(id);

        // 绉婚櫎 CodeLens 浼氳瘽锛堜細鑷姩瑙﹀彂鐩稿叧 UI 鍒锋柊锛?
        try {
            getDiffCodeLensProvider().removeSession(id);
        } catch (err) {
            console.warn(`[DiffManager] Failed to remove CodeLens session ${id}:`, err);
        }

        const tempDir = path.join(require('os').tmpdir(), 'gemini-diff');
        const diff = this.pendingDiffs.get(id);
        if (diff) {
            const tempFilePath = path.join(tempDir, `${id}-${path.basename(diff.filePath)}`);
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        }
    }

    /**
     * 鑾峰彇鎵€鏈夊緟澶勭悊鐨?diff
     */
    public getPendingDiffs(): PendingDiff[] {
        return Array.from(this.pendingDiffs.values()).filter(d => d.status === 'pending');
    }

    /**
     * 妫€鏌ユ槸鍚︽墍鏈?diff 閮藉凡澶勭悊
     */
    public areAllProcessed(): boolean {
        return this.getPendingDiffs().length === 0;
    }

    /**
     * 绛夊緟鎵€鏈?diff 琚鐞?
     */
    public waitForAllProcessed(): Promise<void> {
        return new Promise((resolve) => {
            if (this.areAllProcessed()) {
                resolve();
                return;
            }

            const listener: StatusChangeListener = (_pending, allProcessed) => {
                if (allProcessed) {
                    this.removeStatusListener(listener);
                    resolve();
                }
            };

            this.addStatusListener(listener);
        });
    }

    /**
     * 绛夊緟鎸囧畾 pending diff 缁撶畻銆?
     * 缁熶竴鐘舵€佺洃鍚€佽疆璇€佺敤鎴蜂腑鏂笌 AbortSignal锛沘bort/user 涓柇閮戒細涓诲姩 reject 褰撳墠 diff 骞舵竻鐞嗚祫婧愶紝
     * 閬垮厤鏂囦欢宸插鐞嗕絾宸ュ叿 Promise 浠嶆偓鎸傘€?
     */
    public waitForDiffResolution(id: string, abortSignal?: AbortSignal): Promise<DiffResolutionReason> {
        return new Promise<DiffResolutionReason>((resolve) => {
            let resolved = false;
            let pollTimer: ReturnType<typeof setTimeout> | undefined;
            let abortHandler: (() => void) | undefined;
            let statusListener: StatusChangeListener | undefined;

            const clearPollTimer = () => {
                if (pollTimer) {
                    clearTimeout(pollTimer);
                    pollTimer = undefined;
                }
            };

            const finish = (reason: DiffResolutionReason) => {
                if (resolved) return;
                resolved = true;
                clearPollTimer();

                if (statusListener) {
                    this.removeStatusListener(statusListener);
                    statusListener = undefined;
                }

                if (abortHandler && abortSignal) {
                    try {
                        abortSignal.removeEventListener('abort', abortHandler);
                    } catch {
                        // ignore
                    }
                }

                resolve(reason);
            };

            const rejectAndFinish = (reason: Exclude<DiffResolutionReason, 'none'>) => {
                this.rejectDiff(id).catch(() => {});
                finish(reason);
            };

            const scheduleNextCheck = () => {
                if (resolved || pollTimer) return;
                pollTimer = setTimeout(() => {
                    pollTimer = undefined;
                    checkStatus();
                }, 100);
            };

            const checkStatus = () => {
                if (resolved) return;

                if (this.isUserInterrupted()) {
                    rejectAndFinish('user');
                    return;
                }

                const diff = this.getDiff(id);
                if (!diff || diff.status !== 'pending') {
                    finish('none');
                    return;
                }

                scheduleNextCheck();
            };

            abortHandler = () => {
                rejectAndFinish('abort');
            };

            if (abortSignal) {
                if (abortSignal.aborted) {
                    abortHandler();
                    return;
                }
                abortSignal.addEventListener('abort', abortHandler, { once: true } as any);
            }

            statusListener = () => {
                checkStatus();
            };
            this.addStatusListener(statusListener);

            // createPendingDiff 鍙兘鍦?autoApplyWithoutDiffView 鎴栧閮ㄥ彇娑堣矾寰勪腑宸插畬鎴愶紝
            // 鎵€浠ユ敞鍐岀洃鍚悗绔嬪埢妫€鏌ヤ竴娆★紝閬垮厤閿欒繃杩斿洖鍓嶅彂鐢熺殑鐘舵€佸彉鍖栥€?
            checkStatus();
        });
    }

    /**
     * 鏍囪鐢ㄦ埛涓柇锛堢敤鎴峰彂閫佷簡鏂版秷鎭級
     * 杩欎細璁╂墍鏈夌瓑寰呬腑鐨勫伐鍏风珛鍗宠繑鍥?
     */
    public markUserInterrupt(): void {
        userInterruptFlag = true;
        // 鍙栨秷鎵€鏈夎嚜鍔ㄤ繚瀛樺畾鏃跺櫒
        for (const timer of this.autoSaveTimers.values()) {
            clearTimeout(timer);
        }
        this.autoSaveTimers.clear();
    }

    /**
     * 閲嶇疆鐢ㄦ埛涓柇鏍囪
     */
    public resetUserInterrupt(): void {
        userInterruptFlag = false;
    }

    /**
     * 妫€鏌ユ槸鍚﹁鐢ㄦ埛涓柇
     */
    public isUserInterrupted(): boolean {
        return userInterruptFlag;
    }

    /**
     * 鍙栨秷鎵€鏈夊緟澶勭悊鐨?diff锛堟爣璁颁负宸插彇娑堬級
     * 鐢ㄤ簬鐢ㄦ埛鍙戦€佹柊娑堟伅鎴栧垹闄ゆ秷鎭椂娓呯悊鏈‘璁ょ殑 diff
     */
    public async cancelAllPending(): Promise<{ cancelled: PendingDiff[] }> {
        const cancelled: PendingDiff[] = [];

        const pendingIds = Array.from(this.pendingDiffs.entries())
            .filter(([, d]) => d.status === 'pending')
            .map(([id]) => id);

        for (const id of pendingIds) {
            const diff = this.pendingDiffs.get(id);
            if (!diff || diff.status !== 'pending') {
                continue;
            }

            // 1. 鏍囪涓哄彇娑堬紙鍏紑 PendingDiff 鐘舵€佷粛鏄犲皠涓?rejected锛屼互淇濇寔鏃㈡湁 API/鍓嶇鍒ゆ柇涓嶅彉锛?
            this.finalizeCancelledDiff(diff);
            cancelled.push({ ...diff });

            // 2. 鍏抽棴 diff 缂栬緫鍣ㄦ爣绛鹃〉
            try {
                await this.closeDiffTab(diff.absolutePath);
            } catch (err) {
                console.warn(`[DiffManager] Failed to close diff tab for ${diff.absolutePath}:`, err);
            }

            // 6. 灏濊瘯鎭㈠鏂囦欢鍒板師濮嬬姸鎬?
            try {
                const uri = vscode.Uri.file(diff.absolutePath);
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === diff.absolutePath);
                if (doc && doc.isDirty) {
                    // 鎭㈠鍒板師濮嬪唴瀹?
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        doc.positionAt(0),
                        doc.positionAt(doc.getText().length)
                    );
                    edit.replace(uri, fullRange, diff.originalContent);
                    await vscode.workspace.applyEdit(edit);
                }
            } catch (err) {
                console.warn(`[DiffManager] Failed to restore file for cancelled diff ${id}:`, err);
            }
        }

        if (cancelled.length > 0) {
            this.notifyStatusChange();
        }

        return { cancelled };
    }

    /**
     * 鑾峰彇鎸囧畾 ID 鐨?diff
     */
    public getDiff(id: string): PendingDiff | undefined {
        return this.pendingDiffs.get(id);
    }

    /**
     * 閿€姣佺鐞嗗櫒
     */
    public dispose(): void {
        for (const timer of this.autoSaveTimers.values()) {
            clearTimeout(timer);
        }
        this.autoSaveTimers.clear();

        for (const listener of this.saveListeners.values()) {
            listener.dispose();
        }
        this.saveListeners.clear();

        for (const listener of this.willSaveListeners.values()) {
            listener.dispose();
        }
        this.willSaveListeners.clear();

        for (const listener of this.closeListeners.values()) {
            listener.dispose();
        }
        this.closeListeners.clear();

        for (const session of this.diffSessions.values()) {
            session.dispose();
        }
        this.diffSessions.clear();

        this.suppressedNonManualSaveDrafts.clear();

        if (this.providerDisposable) {
            this.providerDisposable.dispose();
        }

        DiffManager.instance = null;
    }
}

/**
 * 鍘熷鍐呭鎻愪緵鑰?- 鐢ㄤ簬 diff 瑙嗗浘鏄剧ず鍘熷鏂囦欢鍐呭
 */
class OriginalContentProvider implements vscode.TextDocumentContentProvider {
    private contents: Map<string, string> = new Map();
    private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

    public onDidChange = this.onDidChangeEmitter.event;

    public setContent(id: string, content: string): void {
        this.contents.set(id, content);
    }

    public removeContent(id: string): void {
        this.contents.delete(id);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const path = uri.path;
        const parts = path.split('/').filter(p => p.length > 0);
        const id = parts[0];
        return this.contents.get(id) || '';
    }
}

/**
 * 鑾峰彇 DiffManager 瀹炰緥
 */
export function getDiffManager(): DiffManager {
    return DiffManager.getInstance();
}