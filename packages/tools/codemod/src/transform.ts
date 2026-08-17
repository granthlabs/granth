/**
 * Dexie -> granth source transform.
 *
 * Uses the TypeScript compiler API rather than a regex pass, because the things
 * we rewrite (import clauses, `new X()`, `extends X`) are trivially spoofable in
 * strings and comments. One parser also covers .js/.jsx/.ts/.tsx uniformly.
 *
 * Design rule: rewrite only what can be rewritten SAFELY, and REPORT everything
 * else. A codemod that guesses is worse than one that tells you where to look.
 */

import ts from 'typescript';

export interface Note {
  line: number;
  code: string;
  message: string;
}

export interface TransformResult {
  code: string;
  changed: boolean;
  notes: Note[];
  /** The local identifier Dexie was imported as, if any. */
  dexieLocal: string | null;
}

export interface TransformOptions {
  /** Path used in the generated `new Worker(new URL(...))`. */
  workerPath?: string;
  /** Class name to migrate to. */
  className?: string;
}

/** Things with no safe automatic equivalent. Reported, never rewritten. */
const MANUAL: Array<{ test: RegExp; message: string }> = [
  { test: /\bDexie\.Promise\b/, message: 'Dexie.Promise has no equivalent — granth uses plain promises. Always `await` writes inside a transaction.' },
  { test: /\.\s*use\s*\(|\.\s*unuse\s*\(/, message: 'Dexie middleware (use/unuse) has no equivalent. granth has db.use() for ADDONS — a different contract; see docs/Plugins.md.' },
  { test: /\.\s*backendDB\s*\(|\.\s*idbdb\b/, message: 'backendDB()/idbdb expose the raw IDBDatabase; there is no IndexedDB connection in granth.' },
  { test: /\.\s*upgrade\s*\(/, message: 'upgrade() callbacks cannot cross into the worker. Move the body to startGranthWorker({ upgrades: { <version>: fn } }).' },
  { test: /Dexie\.(?:liveQuery|getDatabaseNames|exists|delete)\b/, message: 'Static Dexie helper — check docs/MigratingFromDexie.md for the granth equivalent.' },
  { test: /\bmapToClass\s*\(/, message: 'mapToClass is supported, but the class prototype is applied on read — verify instance methods still behave as you expect.' },
];

const BINDING_IMPORTS: Record<string, string> = {
  'dexie-react-hooks': 'granth-react',
};

export function transform(
  source: string,
  fileName = 'input.ts',
  { workerPath = './db.worker.js', className = 'Granth' }: TransformOptions = {}
): TransformResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));

  /** [start, end, replacement] — applied back-to-front so offsets stay valid. */
  const edits: Array<[number, number, string]> = [];
  const notes: Note[] = [];
  let dexieLocal: string | null = null;
  let sawConstructor = false;

  const noteAt = (pos: number, message: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(pos);
    notes.push({ line: line + 1, code: sf.text.split('\n')[line]?.trim() ?? '', message });
  };

  // ---- pass 1: imports -----------------------------------------------------
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;

    if (spec === 'dexie') {
      const clause = stmt.importClause;
      if (clause?.name) dexieLocal = clause.name.text; // default import
      // Rewrite the specifier; keep the local name so the rest of the file still
      // reads naturally until we rename the identifier below.
      edits.push([stmt.moduleSpecifier.getStart(sf), stmt.moduleSpecifier.getEnd(), `'granth'`]);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (el.name.text === 'liveQuery') {
            noteAt(el.getStart(sf), 'Dexie exports liveQuery standalone; in granth use db.liveQuery(...) or import { liveQuery } from "granth".');
          }
        }
      }
      continue;
    }

    const mapped = BINDING_IMPORTS[spec];
    if (mapped) {
      edits.push([stmt.moduleSpecifier.getStart(sf), stmt.moduleSpecifier.getEnd(), `'${mapped}'`]);
      noteAt(stmt.getStart(sf), `useLiveQuery from ${mapped} takes the db as its first argument: useLiveQuery(db, () => ..., deps).`);
    }
  }

  // ---- pass 2: identifiers, constructors, class heritage -------------------
  const local = dexieLocal ?? 'Dexie';

  const visit = (node: ts.Node): void => {
    // new Dexie('name')  ->  new Granth('name', { worker: () => new Worker(...) })
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === local) {
      sawConstructor = true;
      edits.push([node.expression.getStart(sf), node.expression.getEnd(), className]);
      const args = node.arguments ?? ts.factory.createNodeArray();
      if (args.length <= 1) {
        const insertAt = args.length === 1 ? args[0]!.getEnd() : node.expression.getEnd() + 1;
        edits.push([
          insertAt,
          insertAt,
          `, {\n  worker: () => new Worker(new URL('${workerPath}', import.meta.url), { type: 'module' }),\n}`,
        ]);
      } else {
        noteAt(node.getStart(sf), 'Constructor already has options — add `worker: () => new Worker(...)` by hand.');
      }
    }

    // class X extends Dexie
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const h of node.heritageClauses ?? []) {
        if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const t of h.types) {
          if (ts.isIdentifier(t.expression) && t.expression.text === local) {
            edits.push([t.expression.getStart(sf), t.expression.getEnd(), className]);
            noteAt(t.expression.getStart(sf), `super('name') must now pass a runtime: super('name', { worker: () => new Worker(new URL('${workerPath}', import.meta.url), { type: 'module' }) }).`);
          }
        }
      }
    }

    // remaining bare references (Dexie.something, instanceof Dexie, type positions)
    if (ts.isIdentifier(node) && node.text === local && !ts.isImportSpecifier(node.parent)) {
      const p = node.parent;
      const alreadyEdited =
        (ts.isNewExpression(p) && p.expression === node) ||
        (ts.isExpressionWithTypeArguments(p) && p.expression === node);
      if (!alreadyEdited && !ts.isImportClause(p)) {
        edits.push([node.getStart(sf), node.getEnd(), className]);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  // the import clause's local name, renamed last so earlier lookups matched
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === 'dexie' &&
      stmt.importClause?.name
    ) {
      const n = stmt.importClause.name;
      edits.push([n.getStart(sf), n.getEnd(), className]);
    }
  }

  // ---- pass 3: things we refuse to guess at --------------------------------
  const lines = source.split('\n');
  for (const [i, text] of lines.entries()) {
    if (text.trim().startsWith('//') || text.trim().startsWith('*')) continue;
    for (const { test, message } of MANUAL) {
      if (test.test(text)) notes.push({ line: i + 1, code: text.trim(), message });
    }
  }

  if (sawConstructor) {
    notes.push({
      line: 0,
      code: '',
      message: `A worker file is required at "${workerPath}" — run with --scaffold to generate one.`,
    });
  }

  // apply back-to-front so earlier offsets stay valid
  let code = source;
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) {
    code = code.slice(0, start) + text + code.slice(end);
  }

  return { code, changed: code !== source, notes, dexieLocal };
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The worker file a migrated project needs. */
export function workerScaffold(filename = '/app.sqlite3'): string {
  return `import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from 'granth-runtime-worker/entry';
import { opfsStorage } from 'granth-storage-opfs';
import { indexeddbStorage } from 'granth-storage-indexeddb';
import { memoryStorage } from 'granth-storage-memory';

startGranthWorker({
  sqlite3InitModule,
  filename: '${filename}',
  // Ordered: the first available backend wins, so this degrades instead of
  // throwing where OPFS does not exist (Safari private browsing).
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
  // Dexie's version(n).upgrade(fn) bodies belong here — a function cannot cross
  // into a worker.
  // upgrades: { 2: (engine) => { /* ... */ } },
});
`;
}
