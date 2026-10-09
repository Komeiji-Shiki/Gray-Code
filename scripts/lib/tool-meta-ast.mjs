import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function known(value, details = {}) {
    return { ok: true, value, complete: true, dynamicKeys: new Set(), spreadDynamic: false,
        dynKeysTotal: 0, spreadDynamicTotal: 0, ...details };
}

function unknown() {
    return { ok: false, complete: false };
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExported(node) {
    return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/** 只读取 AST 中的纯数据表达式；导入模块和工具工厂都不会被执行。 */
export class ToolDeclarationReader {
    constructor(root) {
        this.root = root;
        this.modules = new Map();
        this.scopes = new WeakMap();
        this.values = new WeakMap();
        this.evaluating = new Set();
    }

    loadModule(file, source) {
        file = path.resolve(file);
        const cached = this.modules.get(file);
        if (cached) return cached;
        const text = (source ?? fs.readFileSync(file, 'utf8')).replace(/\r\n?/g, '\n');
        const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const scope = { bindings: new Map(), parent: undefined };
        const module = { file, sourceFile, scope, exports: new Map(), exportStars: [] };
        this.modules.set(file, module);
        const additions = [];
        const visit = (node, currentScope) => {
            if (node !== sourceFile && (ts.isBlock(node) || ts.isFunctionLike(node))) {
                currentScope = { bindings: new Map(), parent: currentScope };
            }
            this.scopes.set(node, currentScope);
            if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
                currentScope.bindings.set(node.name.text, { initializer: node.initializer, additions: [] });
            }
            if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
                const { name, namedBindings } = node.importClause;
                const specifier = node.moduleSpecifier.text;
                if (name) currentScope.bindings.set(name.text, { module, specifier, exportedName: 'default' });
                if (namedBindings && ts.isNamedImports(namedBindings)) {
                    for (const element of namedBindings.elements) {
                        if (!element.isTypeOnly) currentScope.bindings.set(element.name.text, {
                            module, specifier, exportedName: (element.propertyName ?? element.name).text,
                        });
                    }
                } else if (namedBindings && ts.isNamespaceImport(namedBindings)) {
                    currentScope.bindings.set(namedBindings.name.text, { module, specifier, namespace: true });
                }
            }
            if (ts.isVariableStatement(node) && isExported(node)) {
                for (const declaration of node.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name)) module.exports.set(declaration.name.text, { localName: declaration.name.text });
                }
            }
            if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
                const specifier = node.moduleSpecifier?.text;
                if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                    for (const element of node.exportClause.elements) {
                        if (!element.isTypeOnly) module.exports.set(element.name.text, specifier
                            ? { specifier, exportedName: (element.propertyName ?? element.name).text }
                            : { localName: (element.propertyName ?? element.name).text });
                    }
                } else if (!node.exportClause && specifier) {
                    module.exportStars.push(specifier);
                }
            }
            if (ts.isExportAssignment(node) && !node.isExportEquals) module.exports.set('default', { initializer: node.expression });
            // 环境分支中的赋值不参与默认元数据；只累加模块或函数体中直接出现的追加。
            if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
                && node.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
                && ts.isIdentifier(node.expression.left)
                && (ts.isSourceFile(node.parent) || (ts.isBlock(node.parent) && ts.isFunctionLike(node.parent.parent)))) {
                additions.push({ scope: currentScope, name: node.expression.left.text, right: node.expression.right });
            }
            ts.forEachChild(node, child => visit(child, currentScope));
        };
        visit(sourceFile, scope);
        for (const addition of additions) {
            this.findBinding(addition.scope, addition.name)?.additions?.push(addition.right);
        }
        return module;
    }

    resolveModule(module, specifier) {
        if (!specifier.startsWith('.')) return undefined;
        const target = path.resolve(path.dirname(module.file), specifier);
        const relative = path.relative(this.root, target);
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return undefined;
        const candidates = path.extname(target)
            ? [target.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts'), target]
            : [`${target}.ts`, `${target}.mts`, path.join(target, 'index.ts')];
        const file = candidates.find(candidate => /\.(?:ts|mts)$/.test(candidate) && fs.existsSync(candidate));
        return file ? this.loadModule(file) : undefined;
    }

    findBinding(scope, name) {
        for (; scope; scope = scope.parent) {
            if (scope.bindings.has(name)) return scope.bindings.get(name);
        }
        return undefined;
    }

    exportedValue(module, name, seen = new Set()) {
        const key = `${module.file}:${name}`;
        if (seen.has(key)) return unknown();
        seen.add(key);
        const binding = module.exports.get(name);
        if (binding?.localName) return this.bindingValue(this.findBinding(module.scope, binding.localName));
        if (binding?.initializer) return this.evaluate(binding.initializer);
        if (binding?.specifier) {
            const imported = this.resolveModule(module, binding.specifier);
            return imported ? this.exportedValue(imported, binding.exportedName, seen) : unknown();
        }
        for (const specifier of module.exportStars) {
            const imported = this.resolveModule(module, specifier);
            if (imported) {
                const result = this.exportedValue(imported, name, new Set(seen));
                if (result.ok) return result;
            }
        }
        return unknown();
    }

    bindingValue(binding) {
        if (!binding || this.evaluating.has(binding)) return unknown();
        if (this.values.has(binding)) return this.values.get(binding);
        this.evaluating.add(binding);
        let result;
        if (binding.specifier) {
            const imported = this.resolveModule(binding.module, binding.specifier);
            result = imported && !binding.namespace ? this.exportedValue(imported, binding.exportedName) : unknown();
        } else {
            result = this.evaluate(binding.initializer);
            for (const addition of binding.additions ?? []) result = this.add(result, this.evaluate(addition));
        }
        this.evaluating.delete(binding);
        this.values.set(binding, result);
        return result;
    }

    add(left, right) {
        if (!left.ok || !right.ok || !left.complete || !right.complete
            || (left.value !== null && typeof left.value === 'object')
            || (right.value !== null && typeof right.value === 'object')) return unknown();
        return known(left.value + right.value);
    }

    propertyName(node) {
        if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
        if (ts.isComputedPropertyName(node)) {
            const result = this.evaluate(node.expression);
            if (result.ok && result.complete && ['string', 'number'].includes(typeof result.value)) return String(result.value);
        }
        return undefined;
    }

    evaluate(node) {
        if (!node) return unknown();
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
            || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return this.evaluate(node.expression);
        if (ts.isStringLiteralLike(node)) return known(node.text);
        if (ts.isNumericLiteral(node)) return known(Number(node.text.replace(/_/g, '')));
        if (node.kind === ts.SyntaxKind.TrueKeyword) return known(true);
        if (node.kind === ts.SyntaxKind.FalseKeyword) return known(false);
        if (node.kind === ts.SyntaxKind.NullKeyword) return known(null);
        if (ts.isIdentifier(node)) return this.bindingValue(this.findBinding(this.scopes.get(node), node.text));
        if (ts.isObjectLiteralExpression(node)) return this.evaluateObject(node);
        if (ts.isArrayLiteralExpression(node)) {
            const values = [];
            for (const element of node.elements) {
                const spread = ts.isSpreadElement(element);
                const result = this.evaluate(spread ? element.expression : element);
                // 不生成动态枚举的已知子集，数组只有完整可确定时才用于元数据。
                if (!result.ok || !result.complete || (spread && !Array.isArray(result.value))) return unknown();
                if (spread) values.push(...result.value);
                else values.push(result.value);
            }
            return known(values);
        }
        if (ts.isTemplateExpression(node)) {
            let value = node.head.text;
            for (const span of node.templateSpans) {
                const result = this.evaluate(span.expression);
                if (!result.ok || !result.complete || (result.value !== null && typeof result.value === 'object')) return unknown();
                value += String(result.value) + span.literal.text;
            }
            return known(value);
        }
        if (ts.isPrefixUnaryExpression(node)) {
            const result = this.evaluate(node.operand);
            if (!result.ok || typeof result.value !== 'number') return unknown();
            if (node.operator === ts.SyntaxKind.MinusToken) return known(-result.value);
            if (node.operator === ts.SyntaxKind.PlusToken) return known(result.value);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            return this.add(this.evaluate(node.left), this.evaluate(node.right));
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            const key = ts.isPropertyAccessExpression(node) ? known(node.name.text) : this.evaluate(node.argumentExpression);
            if (!key.ok || !key.complete) return unknown();
            if (ts.isIdentifier(node.expression)) {
                const binding = this.findBinding(this.scopes.get(node), node.expression.text);
                if (binding?.namespace) {
                    const imported = this.resolveModule(binding.module, binding.specifier);
                    return imported ? this.exportedValue(imported, String(key.value)) : unknown();
                }
            }
            const object = this.evaluate(node.expression);
            if (!object.ok || object.dynamicKeys?.has(String(key.value))
                || object.value === null || typeof object.value !== 'object'
                || !Object.hasOwn(object.value, key.value)) return unknown();
            return object.fields?.get(String(key.value)) ?? known(object.value[key.value]);
        }
        // 函数调用、getter、三元和宿主状态都保留动态标记。
        return unknown();
    }

    evaluateObject(node) {
        const fields = new Map();
        let spreadDynamicTotal = 0;
        for (const property of node.properties) {
            if (ts.isSpreadAssignment(property)) {
                const result = this.evaluate(property.expression);
                if (result.ok && isRecord(result.value)) {
                    const entries = result.fields ?? new Map(Object.entries(result.value).map(([key, value]) => [key, known(value)]));
                    for (const [key, value] of entries) fields.set(key, value);
                    if (result.spreadDynamic) spreadDynamicTotal++;
                } else {
                    spreadDynamicTotal++;
                }
                continue;
            }
            const key = this.propertyName(property.name);
            if (key === undefined) { spreadDynamicTotal++; continue; }
            const value = ts.isPropertyAssignment(property) ? this.evaluate(property.initializer)
                : ts.isShorthandPropertyAssignment(property) ? this.evaluate(property.name) : unknown();
            fields.set(key, value);
        }
        const value = Object.create(null);
        const dynamicKeys = new Set();
        let dynKeysTotal = 0;
        const spreadDynamic = spreadDynamicTotal > 0;
        for (const [key, field] of fields) {
            if (field.ok) {
                value[key] = field.value;
                dynKeysTotal += field.dynKeysTotal;
                spreadDynamicTotal += field.spreadDynamicTotal;
            } else {
                dynamicKeys.add(key);
                dynKeysTotal++;
            }
        }
        return known(value, { fields, dynamicKeys, spreadDynamic, dynKeysTotal, spreadDynamicTotal,
            complete: dynKeysTotal === 0 && spreadDynamicTotal === 0 });
    }

    findCandidates(relPath, source) {
        const module = this.loadModule(path.resolve(this.root, relPath), source);
        const candidates = [];
        const visit = node => {
            if (ts.isObjectLiteralExpression(node)) {
                const keys = node.properties.filter(property => !ts.isSpreadAssignment(property))
                    .map(property => this.propertyName(property.name));
                const hasSpread = node.properties.some(ts.isSpreadAssignment);
                if ((keys.includes('name') && keys.includes('parameters')) || hasSpread) {
                    const result = this.evaluate(node);
                    if (/^[a-z][a-z0-9_]*$/.test(result.value.name ?? '')
                        && (isRecord(result.value.parameters) || result.dynamicKeys.has('parameters'))) {
                        candidates.push({ toolName: result.value.name, source: relPath,
                            start: node.getStart(module.sourceFile), end: node.end, raw: result.value,
                            dynamicKeys: result.dynamicKeys, spreadDynamic: result.spreadDynamic,
                            dynKeysTotal: result.dynKeysTotal, spreadDynamicTotal: result.spreadDynamicTotal });
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(module.sourceFile);
        return candidates;
    }
}

export function findDeclarationCandidates(relPath, source, root = process.cwd()) {
    return new ToolDeclarationReader(root).findCandidates(relPath, source);
}
