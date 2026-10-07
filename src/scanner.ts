import * as vscode from 'vscode';

export interface MagicNumber {
  /** Literal exactly as written, e.g. `5000u` */
  literal: string;
  /** Numeric part without suffix, e.g. `5000` */
  body: string;
  suffix: string;
  value: number;
  start: number;
  end: number;
  range: vscode.Range;
  line: number;
  /** Code on the same line before the literal (comments/strings blanked) */
  linePrefix: string;
  /** Position-independent identity, used for "keep" decisions */
  key: string;
}

export interface ScanOptions {
  allowed: Set<number>;
}

const isIdent = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * Returns a copy of `text` (same length, same line breaks) in which comments,
 * string/char literals and preprocessor lines are replaced by spaces.
 */
export function maskSource(text: string): string {
  const n = text.length;
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\' && text[j + 1] === '\n') { j += 2; continue; }
        if (text[j] === '\\' && text[j + 1] === '\r' && text[j + 2] === '\n') { j += 3; continue; }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      const j = e < 0 ? n : e + 2;
      blank(i, j); i = j; continue;
    }
    if (c === '#' && lineStart) {
      let j = i;
      while (j < n) {
        if (text[j] === '\n') {
          const prev = text[j - 1] === '\r' ? text[j - 2] : text[j - 1];
          if (prev === '\\') { j++; continue; }
          break;
        }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    lineStart = false;

    if (c === 'R' && d === '"' && (!isIdent(text[i - 1]) || /[LuU8]/.test(text[i - 1]))) {
      const open = text.indexOf('(', i + 2);
      if (open > 0 && open - (i + 2) <= 16) {
        const delim = text.slice(i + 2, open);
        const close = text.indexOf(')' + delim + '"', open);
        const j = close < 0 ? n : close + delim.length + 2;
        blank(i, j); i = j; continue;
      }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      const endIdx = text[j] === c ? j + 1 : j;
      blank(i, endIdx); i = endIdx; continue;
    }
    // Skip whole numeric tokens so digit separators (1'000) are not mistaken for char literals
    if ((isDigit(c) || (c === '.' && isDigit(d))) && !isIdent(text[i - 1])) {
      let j = i + 1;
      while (j < n && (/[\w.']/.test(text[j]) || ((text[j] === '+' || text[j] === '-') && /[eEpP]/.test(text[j - 1])))) j++;
      i = j; continue;
    }
    i++;
  }
  return out.join('');
}

/** Index of the `}` matching the `{` at openIdx (or end of text). */
export function matchingBrace(masked: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return masked.length;
}

export function parseLiteral(body: string): number {
  const s = body.replace(/'/g, '').toLowerCase();
  if (s.startsWith('0x')) return parseInt(s.slice(2), 16);
  if (s.startsWith('0b')) return parseInt(s.slice(2), 2);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
  return parseFloat(s);
}

const NUMBER_SRC =
  String.raw`(?<![\w.'])(0[xX][0-9a-fA-F']+(?:\.[0-9a-fA-F']*)?(?:[pP][+-]?\d+)?|0[bB][01']+|(?:\d[\d']*(?:\.[\d']*)?|\.\d[\d']*)(?:[eE][+-]?\d+)?)([a-zA-Z_]*)`;

// `constexpr int X = 5;`, `static const double Y = 2.5;` ... are already named constants
const CONST_DECL = /\b(?:constexpr|constinit|const)\b[^;(){}=]*=[^;]*$/;

export function findMagicNumbers(doc: vscode.TextDocument, opts: ScanOptions): MagicNumber[] {
  const text = doc.getText();
  const masked = maskSource(text);

  const enums: Array<[number, number]> = [];
  const enumRe = /\benum\b[^;{}()]*\{/g;
  let em: RegExpExecArray | null;
  while ((em = enumRe.exec(masked))) {
    const open = em.index + em[0].length - 1;
    enums.push([open, matchingBrace(masked, open)]);
  }

  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const seen = new Map<string, number>();
  const result: MagicNumber[] = [];
  const re = new RegExp(NUMBER_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const body = m[1];
    const suffix = m[2];
    if (!/^[uUlLfFzZ]*$/.test(suffix)) continue; // user-defined literal such as 10ms
    const value = parseLiteral(body);
    if (Number.isNaN(value) || opts.allowed.has(Math.abs(value))) continue;
    const start = m.index;
    if (enums.some(([a, b]) => start > a && start < b)) continue;

    const startPos = doc.positionAt(start);
    const lineStartOffset = doc.offsetAt(new vscode.Position(startPos.line, 0));
    const linePrefix = masked.slice(lineStartOffset, start);
    if (CONST_DECL.test(linePrefix)) continue;

    const end = start + m[0].length;
    const base = `${rel}|${doc.lineAt(startPos.line).text.trim()}|${m[0]}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);

    result.push({
      literal: m[0], body, suffix, value, start, end,
      range: new vscode.Range(startPos, doc.positionAt(end)),
      line: startPos.line, linePrefix, key: `${base}|${nth}`,
    });
  }
  return result;
}
