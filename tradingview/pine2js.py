#!/usr/bin/env python3
"""
把 tradingview/smc-plan.pine 粗略轉成 JavaScript，拿來跟 src/smc/ 的原版引擎比對結果。

只支援這支指標用到的 Pine 語法子集（函式、tuple、陣列、自訂型別、for/while/if、三元運算），
畫圖／表格／警報這些呼叫直接略過。轉出來的 JS 由 tests/tradingview-parity.test.mjs 載入，
用同一批 K 棒分別跑 Pine 版跟原版，逐項比對進場、停損、目標、評分、匯流檢查。
這不是完整的 Pine 編譯器：語法錯誤還是要貼到 TradingView 才抓得到，但邏輯跟原版不一致會在這裡被抓出來。

用法：python3 tradingview/pine2js.py tradingview/smc-plan.pine > out.mjs
"""
import re
import sys

SKIP_PREFIXES = (
    'indicator(', 'box.new(', 'line.new(', 'label.new(', 'table.cell(', 'table.clear(',
    'alert(', 'var table ', 'float htfScore', 'float htfRaw', 'HTF_TF =', 'HTF_MS =',
)
SKIP_FUNCS = {'getWindow', 'htfOf', 'tfName'}
INPUT_RE = re.compile(r'^(\w+)\s*=\s*input\.')


def protect_strings(line):
    strings = []

    def sub(m):
        strings.append(m.group(0))
        return f'__STR{len(strings) - 1}__'
    return re.sub(r'"[^"]*"', sub, line), strings


def restore_strings(line, strings):
    for i, s in enumerate(strings):
        line = line.replace(f'__STR{i}__', s)
    return line


def strip_comment(line):
    code, strings = protect_strings(line)
    idx = code.find('//')
    if idx >= 0:
        code = code[:idx]
    return restore_strings(code.rstrip(), strings)


TYPE_WORDS = r'(?:float|int|bool|string|color|array<\w+>|Struct|Gap|OB|Poi|Pool|Target|table)'
OBJ_TYPES = {'Struct', 'Gap', 'OB', 'Poi', 'Pool', 'Target'}


def expr(code):
    """把一段 Pine 運算式轉成 JS（字串已經保護起來）"""
    code = re.sub(r'\band\b', '&&', code)
    code = re.sub(r'\bor\b', '||', code)
    code = re.sub(r'\bnot\s+', '!', code)
    code = re.sub(r'array\.new<[^>]+>\(\)', '[]', code)
    code = re.sub(r'array\.new<[^>]+>\(', 'newArr(', code)
    code = re.sub(r'array\.from\(', 'arrFrom(', code)
    code = re.sub(r'\b(Struct|Gap|OB|Poi|Pool|Target)\.new\(', r'new \1(', code)
    code = re.sub(r'\bmath\.(max|min|abs|floor)\(', r'Math.\1(', code)
    code = re.sub(r'\bmath\.round\(', 'Math.round(', code)
    code = re.sub(r'\bstr\.tostring\(', 'strToString(', code)
    code = re.sub(r'\bna\(', 'isNa(', code)
    code = re.sub(r'\bna\b', 'NaN', code)
    code = re.sub(r'#([0-9a-fA-F]{6})\b', r'"#\1"', code)
    code = re.sub(r'\b(hour|minute|dayofweek|year|month)\(', r'utc_\1(', code)
    return code


def convert(src):
    lines = src.split('\n')
    out = []
    stack = []  # (indent, kind)
    i = 0
    in_type = None
    skip_indent = None
    func_stack = []  # (indent, name) for functions whose last expression is returned

    def close_blocks(indent):
        while stack and stack[-1][0] >= indent:
            ind, kind = stack.pop()
            if kind == 'class':
                out.append(' ' * ind + '  constructor(...a) { this.__fields.forEach(([k, d], i) => { this[k] = i < a.length ? a[i] : (typeof d === "function" ? d() : d); }); }')
                out.append(' ' * ind + '  copy() { return Object.assign(Object.create(Object.getPrototypeOf(this)), this); }')
                out.append(' ' * ind + '}')
            else:
                out.append(' ' * ind + '}')

    raw_lines = [strip_comment(l) for l in lines]
    # 函式主體最後一行當作回傳值：先標記每個函式主體的最後一個「同層」敘述
    n = len(raw_lines)
    idx = 0
    while idx < n:
        line = raw_lines[idx]
        if not line.strip():
            idx += 1
            continue
        indent = len(line) - len(line.lstrip(' '))
        code = line.strip()

        if skip_indent is not None:
            if indent > skip_indent:
                idx += 1
                continue
            skip_indent = None

        close_blocks(indent)

        if code.startswith('//@version'):
            idx += 1
            continue
        if code.startswith(SKIP_PREFIXES) or INPUT_RE.match(code):
            idx += 1
            continue

        m = re.match(r'^type (\w+)$', code)
        if m:
            out.append(' ' * indent + f'class {m.group(1)} {{')
            out.append(' ' * indent + f'  get __fields() {{ return {m.group(1)}.__f; }}')
            stack.append((indent, 'class'))
            # 收集欄位
            fields = []
            j = idx + 1
            while j < n and (not raw_lines[j].strip() or raw_lines[j].startswith(' ' * (indent + 4))):
                f = raw_lines[j].strip()
                j += 1
                if not f:
                    continue
                fm = re.match(r'^(\S+)\s+(\w+)(?:\s*=\s*(.+))?$', f)
                ftype, fname, fdef = fm.group(1), fm.group(2), fm.group(3)
                if fdef is None:
                    fdef = 'null' if (ftype.startswith('array') or ftype in OBJ_TYPES) else 'NaN'
                    if ftype == 'bool':
                        fdef = 'false'
                    if ftype == 'string':
                        fdef = '""'
                else:
                    fdef = expr(fdef)
                fields.append(f'["{fname}", {fdef}]')
            close_blocks(indent)
            out.append(f'{m.group(1)}.__f = [{", ".join(fields)}];')
            idx = j
            continue

        m = re.match(r'^(\w+)\(([^)]*)\)\s*=>\s*(.*)$', code)
        if m and indent == 0:
            name, params, rest = m.group(1), m.group(2), m.group(3)
            if name in SKIP_FUNCS:
                skip_indent = indent
                idx += 1
                continue
            params = ', '.join(p.strip().split()[-1] for p in params.split(',') if p.strip())
            if rest:
                s, strs = protect_strings(rest)
                out.append(f'function {name}({params}) {{ return {restore_strings(expr(s), strs)}; }}')
                idx += 1
                continue
            out.append(f'function {name}({params}) {{')
            stack.append((indent, 'func'))
            # 找這個函式主體（縮排 4）的最後一個敘述，當作回傳值
            j = idx + 1
            last = None
            while j < n and (not raw_lines[j].strip() or raw_lines[j].startswith('    ')):
                if raw_lines[j].strip() and len(raw_lines[j]) - len(raw_lines[j].lstrip(' ')) == 4:
                    last = j
                j += 1
            raw_lines[last] = '    __RETURN__ ' + raw_lines[last].strip()
            idx += 1
            continue

        s, strs = protect_strings(code)
        js = None
        ret = False
        if s.startswith('__RETURN__ '):
            ret = True
            s = s[len('__RETURN__ '):]

        m = re.match(r'^for (\w+) = (.+) to (.+)$', s)
        mi = re.match(r'^for (\w+) in (.+)$', s)
        if m:
            v, a, b = m.group(1), expr(m.group(2)), expr(m.group(3))
            js = f'for (let {v} = ({a}), __e_{v} = ({b}), __s_{v} = (__e_{v} >= {v} ? 1 : -1); __s_{v} > 0 ? {v} <= __e_{v} : {v} >= __e_{v}; {v} += __s_{v}) {{'
            stack.append((indent, 'block'))
        elif mi:
            js = f'for (const {mi.group(1)} of {expr(mi.group(2))}) {{'
            stack.append((indent, 'block'))
        elif s.startswith('while '):
            js = f'while ({expr(s[6:])}) {{'
            stack.append((indent, 'block'))
        elif s.startswith('if '):
            js = f'if ({expr(s[3:])}) {{'
            stack.append((indent, 'block'))
        elif s.startswith('else if '):
            # 前一個 if 的 } 已經在 close_blocks 輸出；接在後面
            out[-1] = out[-1] + restore_strings(f' else if ({expr(s[8:])}) {{', strs)
            stack.append((indent, 'block'))
            idx += 1
            continue
        elif s == 'else':
            out[-1] = out[-1] + ' else {'
            stack.append((indent, 'block'))
            idx += 1
            continue
        elif s in ('break', 'continue'):
            js = s + ';'
        else:
            s2 = re.sub(r'^var\s+', '', s)
            md = re.match(rf'^({TYPE_WORDS})\s+(\w+)\s*=\s*(.+)$', s2)
            mt = re.match(r'^\[([^\]]+)\]\s*=\s*(.+)$', s2)
            ma = re.match(r'^([\w.]+)\s*:=\s*(.+)$', s2)
            mc = re.match(r'^([\w.]+)\s*(\+=|-=)\s*(.+)$', s2)
            mn = re.match(r'^(\w+)\s*=\s*(.+)$', s2)
            if md:
                val = expr(md.group(3))
                if md.group(1) in OBJ_TYPES and val == 'NaN':
                    val = 'null'
                js = f'let {md.group(2)} = {val};'
            elif mt:
                js = f'let [{mt.group(1)}] = {expr(mt.group(2))};'
            elif ma:
                js = f'{ma.group(1)} = {expr(ma.group(2))};'
            elif mc:
                js = f'{mc.group(1)} {mc.group(2)} {expr(mc.group(3))};'
            elif mn and not ret:
                js = f'let {mn.group(1)} = {expr(mn.group(2))};'
            else:
                js = expr(s2) + ';'
            if ret:
                if mt or md or mn and not ret:
                    pass
                js = 'return ' + (f'[{mt.group(1)}]' if mt else expr(s2)) + ';'
        out.append(' ' * indent + restore_strings(js, strs))
        # `if iShowTable` 之前把主分析的結果交出去給測試比對
        idx += 1

    close_blocks(0)
    return '\n'.join(out)


if __name__ == '__main__':
    src = open(sys.argv[1], encoding='utf-8').read()
    body = convert(src)
    body = body.replace('    if (iShowTable) {', '    __out.result = { n, hasPlan, dirPlan, entry, stop, riskV, targets, scorePlan, gradePlan, validPlan, checks, localScore, noneReason };\n    if (iShowTable) {', 1)
    print(body)
