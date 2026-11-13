// Reader and writer for the Lua that WoW SavedVariables use: assignments of
// plain tables, strings, numbers, booleans and nil. No code, no functions.

export type LuaValue = string | number | boolean | LuaTable;
export interface LuaTable { [key: string]: LuaValue }

/**
 * Parse a SavedVariables file into { GlobalName: value }.
 * Tables become plain objects; positional entries get keys "1", "2", ...
 * A global set to nil comes back as null.
 * T is the shape the caller expects; it isn't checked, so check what you read.
 */
export function parseSavedVariables<T = Record<string, LuaValue | null>>(input: Buffer | string): T {
  // Work on bytes as latin1 so \ddd escapes map to bytes, then decode each
  // string literal as UTF-8 (WoW writes UTF-8).
  const src = Buffer.isBuffer(input) ? input.toString('latin1') : Buffer.from(input, 'utf8').toString('latin1');
  let i = 0;
  const n = src.length;

  const fail = (msg: string): never => {
    const line = src.slice(0, i).split('\n').length;
    throw new SyntaxError(`${msg} at line ${line}`);
  };

  function skip(): void {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === '-' && src[i + 1] === '-') {
        if (src[i + 2] === '[' && src[i + 3] === '[') {
          const end = src.indexOf(']]', i + 4);
          i = end < 0 ? n : end + 2;
        } else {
          while (i < n && src[i] !== '\n') i++;
        }
        continue;
      }
      return;
    }
  }

  function readName(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 256));
    if (!m) return fail('Expected a name');
    i += m[0].length;
    return m[0];
  }

  function readString(): string {
    const quote = src[i++];
    let out = '';
    for (;;) {
      if (i >= n) fail('Unfinished string');
      const c = src[i++];
      if (c === quote) break;
      if (c !== '\\') { out += c; continue; }
      const e = src[i++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '\n': out += '\n'; break;
        case '\\': case '"': case "'": out += e; break;
        default:
          if (/[0-9]/.test(e)) {
            let digits = e;
            while (digits.length < 3 && /[0-9]/.test(src[i])) digits += src[i++];
            out += String.fromCharCode(Number(digits));
          } else {
            out += e;
          }
      }
    }
    return Buffer.from(out, 'latin1').toString('utf8');
  }

  function readNumber(): number {
    const m = /^-?(0x[0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf|nan)/.exec(src.slice(i, i + 64));
    if (!m) return fail('Expected a value');
    i += m[0].length;
    if (m[0].endsWith('inf')) return m[0][0] === '-' ? -Infinity : Infinity;
    if (m[0].endsWith('nan')) return NaN;
    return Number(m[0]);
  }

  function readValue(): LuaValue | null {
    skip();
    const c = src[i];
    if (c === '{') return readTable();
    if (c === '"' || c === "'") return readString();
    if (src.startsWith('true', i)) { i += 4; return true; }
    if (src.startsWith('false', i)) { i += 5; return false; }
    if (src.startsWith('nil', i)) { i += 3; return null; }
    return readNumber();
  }

  function readTable(): LuaTable {
    i++; // {
    const t: LuaTable = {};
    let pos = 1;
    for (;;) {
      skip();
      if (src[i] === '}') { i++; return t; }
      if (src[i] === '[') {
        i++;
        const key = readValue();
        skip();
        if (src[i] !== ']') fail('Expected ]');
        i++;
        skip();
        if (src[i] !== '=') fail('Expected =');
        i++;
        const v = readValue();
        if (v !== null) t[String(key)] = v;
      } else if (/[A-Za-z_]/.test(src[i]) && !/^(true|false|nil)\b/.test(src.slice(i, i + 6)) && /^[A-Za-z_]\w*\s*=/.test(src.slice(i, i + 300))) {
        const key = readName();
        skip();
        i++; // =
        const v = readValue();
        if (v !== null) t[key] = v;
      } else {
        const v = readValue();
        if (v !== null) t[String(pos)] = v;
        pos++;
      }
      skip();
      if (src[i] === ',' || src[i] === ';') i++;
      else if (src[i] !== '}') fail('Expected , or }');
    }
  }

  const result: Record<string, LuaValue | null> = {};
  for (;;) {
    skip();
    if (i >= n) break;
    const name = readName();
    skip();
    if (src[i] !== '=') fail('Expected =');
    i++;
    result[name] = readValue();
  }
  return result as T;
}

/** Quote a string as a Lua string literal. */
export function luaString(s: unknown): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what gets escaped
  return '"' + String(s).replace(/[\\"\x00-\x1f\x7f]/g, (c) => {
    if (c === '\\') return '\\\\';
    if (c === '"') return '\\"';
    if (c === '\n') return '\\n';
    return '\\' + c.charCodeAt(0).toString().padStart(3, '0');
  }) + '"';
}

/** Lua table key: [123] for integer keys, ["text"] otherwise. */
export function luaKey(k: string | number): string {
  return /^-?\d+$/.test(String(k)) ? `[${k}]` : `[${luaString(k)}]`;
}

/** Serialize a JS value as a Lua expression. */
export function toLua(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return luaString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value > 0 ? 'math.huge' : value < 0 ? '-math.huge' : '0';
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  const inner = indent + '  ';
  const parts = Object.entries(value).map(([k, v]) => `${inner}${luaKey(k)} = ${toLua(v, inner)},`);
  return parts.length ? `{\n${parts.join('\n')}\n${indent}}` : '{}';
}
