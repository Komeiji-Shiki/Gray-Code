export interface DefinitionDocument { lineCount: number; lineAt(index: number): { text: string }; }

export function findBlockEnd(doc: DefinitionDocument, startLine: number): number {
    const lexicalEnd = findBlockEndWithLexicalState(doc, startLine);
    if (lexicalEnd > startLine) {
        return lexicalEnd;
    }
    // 词法扫描未找到平衡括号（代码不平衡或含无法解析的语法如正则字面量），
    // 回退原逻辑，尽量保持旧行为兜底。
    return findBlockEndNaive(doc, startLine);
}

function findBlockEndWithLexicalState(doc: DefinitionDocument, startLine: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;
    const totalLines = doc.lineCount;

    // 最小化词法状态
    let inBlockComment = false;  // /* ... */
    let inSingleQuote = false;   // '...'（支持 \\ 转义）
    let inDoubleQuote = false;   // "..."（支持 \\ 转义）
    let inTemplate = false;      // `...`（整体不透明）
    let escaped = false;         // 字符串/模板内的反斜杠转义

    for (let i = startLine; i < totalLines; i++) {
        const lineText = doc.lineAt(i).text;
        // 行注释只到行尾，每行重新判定
        let inLineComment = false;

        for (let j = 0; j < lineText.length; j++) {
            const char = lineText[j];
            const next = j + 1 < lineText.length ? lineText[j + 1] : '';

            // 代码区才能开始注释；字符串/模板/块注释内不判定注释起始
            if (!inBlockComment && !inSingleQuote && !inDoubleQuote && !inTemplate) {
                if (char === '/' && next === '/') {
                    inLineComment = true;
                    break; // 行注释直到行尾
                }
                if (char === '/' && next === '*') {
                    inBlockComment = true;
                    j++; // 跳过 '*'
                    continue;
                }
            }

            if (inBlockComment) {
                if (char === '*' && next === '/') {
                    inBlockComment = false;
                    j++; // 跳过 '/'
                }
                continue;
            }

            if (inLineComment) {
                break;
            }

            // 字符串/模板内的转义：下一个字符不参与判定
            if (escaped) {
                escaped = false;
                continue;
            }
            if ((inSingleQuote || inDoubleQuote || inTemplate) && char === '\\') {
                escaped = true;
                continue;
            }

            // 进入/退出字符串或模板字面量
            if (!inSingleQuote && !inDoubleQuote && !inTemplate && char === "'") {
                inSingleQuote = true;
                continue;
            }
            if (!inSingleQuote && !inDoubleQuote && !inTemplate && char === '"') {
                inDoubleQuote = true;
                continue;
            }
            if (!inSingleQuote && !inDoubleQuote && !inTemplate && char === '`') {
                inTemplate = true;
                continue;
            }
            if (inSingleQuote && char === "'") {
                inSingleQuote = false;
                continue;
            }
            if (inDoubleQuote && char === '"') {
                inDoubleQuote = false;
                continue;
            }
            if (inTemplate && char === '`') {
                inTemplate = false;
                continue;
            }

            // 代码区：括号计数
            if (char === '{') {
                braceCount++;
                // 仅当计数由非正转正时才视为“块开始”，避免起始行在块外时
                // “先见 } 后见 {”回升到 0 被误判为匹配
                if (!foundOpenBrace && braceCount > 0) {
                    foundOpenBrace = true;
                }
            } else if (char === '}') {
                braceCount--;
                if (foundOpenBrace && braceCount === 0) {
                    return i;
                }
                // 已见开括号却计数为负：起始行不在块内或代码不平衡，
                // 返回 -1 交给调用方回退朴素逻辑
                if (foundOpenBrace && braceCount < 0) {
                    return -1;
                }
            }
        }

        // 防止无限循环，最多查找 500 行
        if (i - startLine > 500) {
            break;
        }
    }

    // 没找到匹配的括号
    return -1;
}

function findBlockEndNaive(doc: DefinitionDocument, startLine: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;
    const totalLines = doc.lineCount;
    
    for (let i = startLine; i < totalLines; i++) {
        const lineText = doc.lineAt(i).text;
        
        for (const char of lineText) {
            if (char === '{') {
                braceCount++;
                foundOpenBrace = true;
            } else if (char === '}') {
                braceCount--;
                if (foundOpenBrace && braceCount === 0) {
                    return i;
                }
            }
        }
        
        // 防止无限循环，最多查找 500 行
        if (i - startLine > 500) {
            break;
        }
    }
    
    // 如果没找到匹配的括号，返回起始行
    return startLine;
}
