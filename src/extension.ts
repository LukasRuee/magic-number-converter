import * as vscode from 'vscode';
import { findMagicNumbers, MagicNumber, ScanOptions } from './scanner';
import {
  resolveTarget, inferType, buildDeclaration, planInsertion, includeEdit, suggestName, NamingStyle,
} from './constants';

const LANGUAGES = ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'];
const DIAG_SOURCE = 'Magic Numbers';

// ------------------------------------------------------------------ state

class IgnoreStore {
  private keys: Set<string>;
  constructor(private memento: vscode.Memento) {
    this.keys = new Set(memento.get<string[]>('ignored', []));
  }
  has(key: string) { return this.keys.has(key); }
  add(key: string) { this.keys.add(key); void this.memento.update('ignored', [...this.keys]); }
  clear() { this.keys.clear(); void this.memento.update('ignored', []); }
}

let store: IgnoreStore;
let diagnostics: vscode.DiagnosticCollection;

function scanOptions(): ScanOptions {
  const cfg = vscode.workspace.getConfiguration('magicNumbers');
  const list = cfg.get<number[]>('allowedNumbers', [0, 1, 2]);
  return { allowed: new Set(list.map(n => Math.abs(Number(n)))) };
}

/** All magic numbers in the document that the user has not marked as "keep". */
function scan(doc: vscode.TextDocument): MagicNumber[] {
  return findMagicNumbers(doc, scanOptions()).filter(m => !store.has(m.key));
}

const isSupported = (doc: vscode.TextDocument) => LANGUAGES.includes(doc.languageId);
const isPlainC = (doc: vscode.TextDocument) => doc.languageId === 'c' || doc.languageId === 'objective-c';

// ------------------------------------------------------------------ diagnostics

const timers = new Map<string, NodeJS.Timeout>();

function refresh(doc: vscode.TextDocument) {
  if (!isSupported(doc)) return;
  const enabled = vscode.workspace.getConfiguration('magicNumbers').get<boolean>('showDiagnostics', true);
  if (!enabled) { diagnostics.delete(doc.uri); return; }
  diagnostics.set(doc.uri, scan(doc).map(m => {
    const d = new vscode.Diagnostic(m.range, `Magic number ${m.literal}`, vscode.DiagnosticSeverity.Information);
    d.source = DIAG_SOURCE;
    d.code = 'magic-number';
    return d;
  }));
}

function refreshDebounced(doc: vscode.TextDocument) {
  const k = doc.uri.toString();
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => { timers.delete(k); refresh(doc); }, 400));
}

class QuickFixes implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _r: vscode.Range, ctx: vscode.CodeActionContext) {
    return ctx.diagnostics.filter(d => d.source === DIAG_SOURCE).flatMap(d => {
      const convert = new vscode.CodeAction('Convert magic number to constant…', vscode.CodeActionKind.QuickFix);
      convert.command = { command: 'magicNumbers.convertAt', title: 'Convert', arguments: [doc.uri, d.range.start] };
      convert.diagnostics = [d];
      convert.isPreferred = true;
      const keep = new vscode.CodeAction('Keep this magic number (stop reporting it)', vscode.CodeActionKind.QuickFix);
      keep.command = { command: 'magicNumbers.keepAt', title: 'Keep', arguments: [doc.uri, d.range.start] };
      keep.diagnostics = [d];
      return [convert, keep];
    });
  }
}

// ------------------------------------------------------------------ conversion

/**
 * Declares a constant and replaces the given occurrences (all in `doc`).
 * Returns true if the edit was applied; false if the user cancelled.
 */
async function convert(doc: vscode.TextDocument, occurrences: MagicNumber[], touched: Set<string>): Promise<boolean> {
  const first = occurrences[0];
  const isC = isPlainC(doc);

  const target = await resolveTarget(doc);
  if (!target) return false;
  const targetDoc = await vscode.workspace.openTextDocument(target.uri);

  const type = inferType(first.body, first.suffix, first.value);
  const style = vscode.workspace.getConfiguration('magicNumbers').get<NamingStyle>('namingStyle', 'UPPER_SNAKE');
  const where = target.kind === 'anonymous'
    ? (isC ? 'the top of this file' : 'an anonymous namespace in this file')
    : vscode.workspace.asRelativePath(target.uri);

  const name = await vscode.window.showInputBox({
    title: `Convert ${first.literal} to a constant`,
    prompt: `Declared as "${type}" in ${where}` +
      (occurrences.length > 1 ? ` — replaces ${occurrences.length} occurrences` : ''),
    value: suggestName(first.linePrefix, first.literal, style),
    ignoreFocusOut: true,
    validateInput: v => {
      if (!/^[A-Za-z_]\w*$/.test(v)) return 'Not a valid C/C++ identifier';
      const re = new RegExp(`\\b${v}\\b`);
      if (re.test(targetDoc.getText()) || re.test(doc.getText())) return `"${v}" is already used`;
      return undefined;
    },
  });
  if (!name) return false;

  const sameFile = targetDoc.uri.toString() === doc.uri.toString();
  const decl = buildDeclaration(name, first.literal, type, isC);
  const plan = planInsertion(targetDoc, decl, target.kind, isC,
    sameFile ? Math.min(...occurrences.map(o => o.start)) : Infinity);

  const edit = new vscode.WorkspaceEdit();
  edit.insert(target.uri, plan.position, plan.text);
  for (const o of occurrences) edit.replace(doc.uri, o.range, name);
  if (target.kind === 'header') {
    const inc = includeEdit(doc, target.uri);
    if (inc) edit.insert(doc.uri, inc.position, inc.text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage('Could not apply the edit.');
    return false;
  }
  touched.add(target.uri.toString());
  vscode.window.setStatusBarMessage(`Added ${name} to ${where}`, 4000);
  return true;
}

// ------------------------------------------------------------------ review session

type Action = 'convert' | 'convertAll' | 'keep' | 'skip' | 'back' | 'stop';
type ActionItem = vscode.QuickPickItem & { action: Action };

async function review(doc: vscode.TextDocument) {
  const skipped: string[] = [];          // keys skipped in this session, in order
  const touched = new Set<string>();     // other files we modified
  let converted = 0, kept = 0;

  for (;;) {
    const all = scan(doc);
    const skippedSet = new Set(skipped);
    const pending = all.filter(m => !skippedSet.has(m.key));
    if (pending.length === 0) break;

    const cur = pending[0];
    const index = all.length - pending.length + 1;
    const same = all.filter(m => m.literal === cur.literal);

    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
    editor.selection = new vscode.Selection(cur.range.start, cur.range.end);
    editor.revealRange(cur.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    const items: ActionItem[] = [
      { label: '$(symbol-constant) Convert to constant…', description: cur.literal, action: 'convert' },
      ...(same.length > 1 ? [{
        label: `$(replace-all) Convert all ${same.length} occurrences of ${cur.literal}…`,
        action: 'convertAll' as Action,
      }] : []),
      { label: '$(check) Keep as is', description: 'never ask about this one again', action: 'keep' },
      { label: '$(arrow-right) Skip', description: 'ask again in the next review', action: 'skip' },
      ...(skipped.length ? [{ label: '$(arrow-left) Back', description: 'previous skipped number', action: 'back' as Action }] : []),
      { label: '$(debug-stop) Stop', action: 'stop' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `Magic number ${cur.literal}  (${index}/${all.length})`,
      placeHolder: doc.lineAt(cur.line).text.trim() || cur.literal,
      ignoreFocusOut: true,
    });
    if (!pick || pick.action === 'stop') break;

    switch (pick.action) {
      case 'convert':
        if (await convert(doc, [cur], touched)) converted++;
        break;
      case 'convertAll': {
        const n = same.length;
        if (await convert(doc, same, touched)) converted += n;
        break;
      }
      case 'keep': store.add(cur.key); kept++; break;
      case 'skip': skipped.push(cur.key); break;
      case 'back': skipped.pop(); break;
    }
  }

  refresh(doc);
  const left = scan(doc).length;
  const msg = `Magic number review: ${converted} converted, ${kept} kept` +
    (left ? `, ${left} still open.` : '. All done!');
  const dirtyOthers = [...touched].filter(u => u !== doc.uri.toString());
  if (dirtyOthers.length) {
    const choice = await vscode.window.showInformationMessage(
      `${msg} Other files were modified.`, 'Save all');
    if (choice === 'Save all') await vscode.workspace.saveAll(false);
  } else {
    void vscode.window.showInformationMessage(msg);
  }
}

// ------------------------------------------------------------------ activation

async function atPosition(uri: vscode.Uri, pos: vscode.Position) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const m = scan(doc).find(x => x.range.start.isEqual(pos));
  return { doc, m };
}

export function activate(ctx: vscode.ExtensionContext) {
  store = new IgnoreStore(ctx.workspaceState);
  diagnostics = vscode.languages.createDiagnosticCollection('magicNumbers');

  ctx.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand('magicNumbers.review', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !isSupported(doc)) {
        void vscode.window.showWarningMessage('Open a C or C++ file to review its magic numbers.');
        return;
      }
      if (scan(doc).length === 0) {
        void vscode.window.showInformationMessage('No magic numbers found in this file.');
        return;
      }
      await review(doc);
    }),
    vscode.commands.registerCommand('magicNumbers.clearIgnored', () => {
      store.clear();
      vscode.workspace.textDocuments.forEach(refresh);
      void vscode.window.showInformationMessage('Cleared all "keep" decisions.');
    }),
    vscode.commands.registerCommand('magicNumbers.convertAt', async (uri: vscode.Uri, pos: vscode.Position) => {
      const { doc, m } = await atPosition(uri, pos);
      if (!m) return;
      const touched = new Set<string>();
      if (await convert(doc, [m], touched)) {
        refresh(doc);
        if ([...touched].some(u => u !== doc.uri.toString())) {
          const c = await vscode.window.showInformationMessage('Constant added to another file.', 'Save all');
          if (c === 'Save all') await vscode.workspace.saveAll(false);
        }
      }
    }),
    vscode.commands.registerCommand('magicNumbers.keepAt', async (uri: vscode.Uri, pos: vscode.Position) => {
      const { doc, m } = await atPosition(uri, pos);
      if (m) { store.add(m.key); refresh(doc); }
    }),
    vscode.languages.registerCodeActionsProvider(
      LANGUAGES.map(language => ({ language })), new QuickFixes(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument(e => refreshDebounced(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => diagnostics.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('magicNumbers')) vscode.workspace.textDocuments.forEach(refresh);
    }),
  );
  vscode.workspace.textDocuments.forEach(refresh);
}

export function deactivate() {
  timers.forEach(t => clearTimeout(t));
}
