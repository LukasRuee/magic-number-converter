import * as vscode from 'vscode';
import * as path from 'path';
import { maskSource } from './scanner';

const HEADER_EXTS = ['.h', '.hpp', '.hh', '.hxx', '.h++'];
const CONST_LINE = /^\s*(?:inline\s+|static\s+)*(?:constexpr|const)\b/;

export type NamingStyle = 'UPPER_SNAKE' | 'kPascalCase';
export type TargetKind = 'header' | 'self' | 'anonymous';
export interface Target { uri: vscode.Uri; kind: TargetKind }
export interface Insertion { position: vscode.Position; text: string }

// ---------------------------------------------------------------- target

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

function commonPrefix(a: string, b: string): number {
  const x = a.split(path.sep), y = b.split(path.sep);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/** Header matching foo.cpp -> foo.h/.hpp/...; undefined = none, 'cancel' = user aborted. */
async function findHeader(source: vscode.Uri): Promise<vscode.Uri | undefined | 'cancel'> {
  const dir = path.dirname(source.fsPath);
  const base = path.basename(source.fsPath, path.extname(source.fsPath));
  for (const e of HEADER_EXTS) {
    const u = vscode.Uri.file(path.join(dir, base + e));
    if (await exists(u)) return u;
  }
  const found = await vscode.workspace.findFiles(
    `**/${base}.{h,hpp,hh,hxx}`, '**/{node_modules,build,out,.git}/**', 10);
  if (found.length === 0) return undefined;
  found.sort((a, b) => commonPrefix(b.fsPath, source.fsPath) - commonPrefix(a.fsPath, source.fsPath));
  if (found.length === 1) return found[0];

  const none = '$(circle-slash) No header: use an anonymous namespace in this file';
  const pick = await vscode.window.showQuickPick(
    [...found.map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u as vscode.Uri | undefined })),
     { label: none, uri: undefined }],
    { title: `Which header belongs to ${path.basename(source.fsPath)}?`, ignoreFocusOut: true });
  if (!pick) return 'cancel';
  return pick.uri;
}

export async function resolveTarget(doc: vscode.TextDocument): Promise<Target | undefined> {
  const ext = path.extname(doc.uri.fsPath).toLowerCase();
  if (HEADER_EXTS.includes(ext)) return { uri: doc.uri, kind: 'self' };
  const header = await findHeader(doc.uri);
  if (header === 'cancel') return undefined;
  if (header) return { uri: header, kind: 'header' };
  return { uri: doc.uri, kind: 'anonymous' };
}

// ------------------------------------------------------------------ naming / types

const KEYWORDS = new Set(['return', 'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'sizeof', 'new', 'delete',
  'const', 'constexpr', 'static', 'int', 'long', 'short', 'unsigned', 'signed', 'char', 'float', 'double', 'bool',
  'auto', 'void', 'size_t', 'std', 'throw', 'operator', 'template', 'typename', 'class', 'struct']);

function words(ident: string): string[] {
  return ident.replace(/^m_/, '').replace(/_+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').split('_').filter(Boolean).map(w => w.toLowerCase());
}

export function suggestName(linePrefix: string, literal: string, style: NamingStyle): string {
  const idents = linePrefix.match(/[A-Za-z_]\w*/g) ?? [];
  let ws: string[] = [];
  for (let i = idents.length - 1; i >= 0; i--) {
    if (!KEYWORDS.has(idents[i])) { ws = words(idents[i]); break; }
  }
  if (ws.length === 0) ws = ['magic', literal.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()];
  return style === 'kPascalCase'
    ? 'k' + ws.map(w => w[0].toUpperCase() + w.slice(1)).join('')
    : ws.join('_').toUpperCase();
}

export function inferType(body: string, suffix: string, value: number): string {
  const b = body.toLowerCase();
  const s = suffix.toLowerCase();
  const isFloat = !b.startsWith('0x') && !b.startsWith('0b') && /[.e]/.test(b);
  if (isFloat) return s.includes('f') ? 'float' : s.includes('l') ? 'long double' : 'double';
  const u = s.includes('u');
  if (s.includes('z')) return u ? 'std::size_t' : 'std::ptrdiff_t';
  const longs = (s.match(/l/g) ?? []).length;
  if (longs >= 2) return u ? 'unsigned long long' : 'long long';
  if (longs === 1) return u ? 'unsigned long' : 'long';
  if (value > 0xffffffff) return u ? 'unsigned long long' : 'long long';
  if (value > 0x7fffffff) return b.startsWith('0x') || u ? 'unsigned int' : 'long long';
  return u ? 'unsigned int' : 'int';
}

export function buildDeclaration(name: string, literal: string, type: string, isC: boolean): string {
  return isC ? `static const ${type} ${name} = ${literal};` : `constexpr ${type} ${name} = ${literal};`;
}

// ------------------------------------------------------------------ placement

const eolOf = (doc: vscode.TextDocument) => (doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');

/** Line index after which new declarations go (-1 = top of file). */
export function anchorAfterIncludes(lines: string[]): number {
  const includes: Array<{ line: number; depth: number }> = [];
  let depth = 0;
  lines.forEach((l, i) => {
    if (/^\s*#\s*(?:if|ifdef|ifndef)\b/.test(l)) depth++;
    else if (/^\s*#\s*endif\b/.test(l)) depth--;
    else if (/^\s*#\s*include\b/.test(l)) includes.push({ line: i, depth });
  });
  if (includes.length) {
    // ignore includes nested in #if blocks deeper than the file's base level
    const min = Math.min(...includes.map(x => x.depth));
    return includes.filter(x => x.depth === min).pop()!.line;
  }
  const once = lines.findIndex(l => /^\s*#\s*pragma\s+once\b/.test(l));
  if (once >= 0) return once;
  const g = lines.findIndex((l, i) =>
    /^\s*#\s*ifndef\s+\w+/.test(l) && /^\s*#\s*define\s+\w+\s*$/.test(lines[i + 1] ?? ''));
  return g >= 0 ? g + 1 : -1;
}

function insertBlock(doc: vscode.TextDocument, lines: string[], anchor: number,
                     block: string[], blankBefore: boolean): Insertion {
  const eol = eolOf(doc);
  const text = block.join(eol);
  // extend an existing run of constants that directly follows the anchor
  let i = anchor + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  let j = i;
  while (j < lines.length && CONST_LINE.test(lines[j])) j++;
  if (j > i) {
    if (j >= lines.length) return { position: doc.lineAt(lines.length - 1).range.end, text: eol + text };
    return { position: new vscode.Position(j, 0), text: text + eol };
  }
  const at = anchor + 1;
  if (at >= lines.length) {
    return { position: doc.lineAt(lines.length - 1).range.end, text: eol + (blankBefore ? eol : '') + text + eol };
  }
  const before = anchor >= 0 && blankBefore ? eol : '';
  const after = lines[at].trim() === '' ? '' : eol;
  return { position: new vscode.Position(at, 0), text: before + text + eol + after };
}

/** Offset of the `{` of the first top-level `namespace {` in masked text. */
function findAnonymousNamespace(masked: string): number | undefined {
  const re = /\bnamespace\s*\{/g;
  let depth = 0, pos = 0, m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    for (let i = pos; i < m.index; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') depth--;
    }
    pos = m.index;
    if (depth === 0) return m.index + m[0].length - 1;
  }
  return undefined;
}

/**
 * Where to put `decl` in the target document.
 * @param firstUseOffset offset of the first replaced literal if it lives in the target itself
 */
export function planInsertion(target: vscode.TextDocument, decl: string, kind: TargetKind,
                              isC: boolean, firstUseOffset: number): Insertion {
  const lines = target.getText().split(/\r?\n/);
  if (kind === 'anonymous' && !isC) {
    const open = findAnonymousNamespace(maskSource(target.getText()));
    if (open !== undefined && open < firstUseOffset) {
      return insertBlock(target, lines, target.positionAt(open).line, [decl], false);
    }
    return insertBlock(target, lines, anchorAfterIncludes(lines),
      ['namespace {', decl, '} // namespace'], true);
  }
  return insertBlock(target, lines, anchorAfterIncludes(lines), [decl], true);
}

/** `#include "foo.h"` for the source file if it is not already there. */
export function includeEdit(source: vscode.TextDocument, header: vscode.Uri): Insertion | undefined {
  const base = path.basename(header.fsPath).toLowerCase();
  const re = /^\s*#\s*include\s*[<"]([^">]+)[>"]/gm;
  const text = source.getText();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (path.basename(m[1]).toLowerCase() === base) return undefined;
  }
  const rel = path.relative(path.dirname(source.uri.fsPath), header.fsPath).split(path.sep).join('/');
  const eol = eolOf(source);
  const lines = text.split(/\r?\n/);
  const anchor = anchorAfterIncludes(lines);
  const line = `#include "${rel}"`;
  if (anchor < 0) return { position: new vscode.Position(0, 0), text: line + eol + eol };
  return { position: source.lineAt(anchor).range.end, text: eol + line };
}
