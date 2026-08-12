# -*- coding: utf-8 -*-
"""
第五阶段：三方对比 FILE1(1818) / FAILED(1820) / FILE2(1821)。
1. 1820 失败记录的 error 详情
2. 1820 的 130 条 vs FILE1 的 121 条：新增了哪些（应包含 FILE1 响应+工具结果）
3. FILE2 的 121 条 vs 1820 的 130 条：被删了哪些
"""
import json
import sys
import re


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def msg_text(m):
    out = []
    if isinstance(m.get('content'), str):
        out.append(m['content'])
    for p in m.get('parts') or []:
        if isinstance(p, dict):
            if isinstance(p.get('text'), str):
                out.append(p['text'])
            if p.get('functionCall'):
                fc = p['functionCall']
                out.append('[FC]' + json.dumps({'name': fc.get('name'), 'id': fc.get('id')}, ensure_ascii=False))
            if p.get('functionResponse'):
                fr = p['functionResponse']
                out.append('[FR]' + json.dumps({'name': fr.get('name'), 'id': fr.get('id')}, ensure_ascii=False))
    return '\n'.join(out)


def lcs_match(a, b):
    """a 中每条消息在 b 中的 LCS 匹配索引；未匹配=-1。"""
    n, m = len(a), len(b)
    ta = [msg_text(x) for x in a]
    tb = [msg_text(x) for x in b]
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if ta[i] and ta[i] == tb[j]:
                dp[i][j] = dp[i + 1][j + 1] + 1
            else:
                dp[i][j] = max(dp[i + 1][j], dp[i][j + 1])
    match = [-1] * n
    i = j = 0
    while i < n and j < m:
        if ta[i] and ta[i] == tb[j]:
            match[i] = j
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return match


def head(m, n=130):
    return re.sub(r'\s+', ' ', msg_text(m))[:n]


def main():
    f1, ff, f2 = sys.argv[1], sys.argv[2], sys.argv[3]
    d1, df, d2 = load(f1), load(ff), load(f2)
    m1, mf, m2 = d1['request_messages'], df['request_messages'], d2['request_messages']

    # 1. 1820 失败详情
    print('=== 1820 (FAILED) meta ===')
    for k in ('type', 'status', 'error', 'stream', 'endpoint_path', 'model'):
        v = df.get(k)
        if isinstance(v, (dict, list)):
            print(f'  {k} = {json.dumps(v, ensure_ascii=False)[:500]}')
        else:
            print(f'  {k} = {v}')

    # 2. FILE1 → 1820 新增
    print(f'\n=== FILE1({len(m1)}) -> 1820({len(mf)}) ===')
    match_1f = lcs_match(m1, mf)
    added_in_f = sorted(set(range(len(mf))) - set(j for j in match_1f if j >= 0))
    print(f'FILE1 保留 {sum(1 for j in match_1f if j>=0)} 条；1820 新增 {len(added_in_f)} 条:')
    for j in added_in_f:
        print(f'  1820[{j:3}] role={mf[j].get("role"):9} :: {head(mf[j])}')

    # 3. 1820 → FILE2 被删
    print(f'\n=== 1820({len(mf)}) -> FILE2({len(m2)}) ===')
    match_f2 = lcs_match(mf, m2)
    deleted = [i for i, j in enumerate(match_f2) if j < 0]
    print(f'1820 保留 {sum(1 for j in match_f2 if j>=0)} 条；被删 {len(deleted)} 条:')
    lost_bytes = 0
    for i in deleted:
        t = msg_text(mf[i])
        lost_bytes += len(t)
        print(f'  1820[{i:3}] role={mf[i].get("role"):9} len={len(t):7} :: {head(mf[i])}')
    print(f'  被删文本总长={lost_bytes} 字符')

    # 4. FILE2 相对 1820 新增（可能是总结/占位/新轮次内容）
    added_in_2 = sorted(set(range(len(m2))) - set(j for j in match_f2 if j >= 0))
    print(f'\nFILE2 相对 1820 新增 {len(added_in_2)} 条:')
    for j in added_in_2:
        flag = ''
        t = msg_text(m2[j])
        if 'temporarily omitted' in t:
            flag = ' <<< OMITTED'
        if 'Preserved' in t:
            flag = ' <<< PRESERVED'
        print(f'  FILE2[{j:3}] role={m2[j].get("role"):9} :: {head(m2[j])}{flag}')

    # 5. 占位检查
    print('\n=== omitted/preserved markers per file ===')
    for tag, msgs in (('FILE1', m1), ('1820', mf), ('FILE2', m2)):
        for i, m in enumerate(msgs):
            t = msg_text(m)
            if 'temporarily omitted' in t or 'Preserved user inputs' in t:
                print(f'  {tag}[{i}] role={m.get("role")} :: {head(m, 200)}')


if __name__ == '__main__':
    main()
