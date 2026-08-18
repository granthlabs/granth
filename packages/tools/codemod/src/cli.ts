#!/usr/bin/env node
/**
 * npx granth-codemod ./src
 *
 * Rewrites what is safe, reports what is not. Defaults to writing; pass --dry to
 * preview. Never touches node_modules, dist or build output.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, dirname, extname, relative, resolve } from 'node:path';
import { transform, workerScaffold } from './transform.js';
import type { Note } from './transform.js';

const EXTS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', 'out']);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) await walk(full, out);
    else if (EXTS.has(extname(full))) out.push(full);
  }
  return out;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export async function run(argv: string[]): Promise<number> {
  const args = argv.filter((a) => !a.startsWith('-'));
  const dry = argv.includes('--dry') || argv.includes('-n');
  const scaffold = argv.includes('--scaffold');
  const target = resolve(args[0] ?? 'src');
  const workerPath = flag(argv, '--worker') ?? './db.worker.js';

  if (!existsSync(target)) {
    console.error(`granth-codemod: no such path "${target}"`);
    return 1;
  }

  const st = await stat(target);
  const files = st.isDirectory() ? await walk(target) : [target];

  let changedCount = 0;
  let needsWorker = false;
  const allNotes: Array<{ file: string; note: Note }> = [];

  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    if (!/\bdexie\b/i.test(before)) continue; // cheap prefilter

    const { code, changed, notes } = transform(before, file, { workerPath });
    for (const note of notes) {
      if (note.message.includes('worker file is required')) { needsWorker = true; continue; }
      allNotes.push({ file, note });
    }
    if (!changed) continue;

    changedCount++;
    const rel = relative(process.cwd(), file);
    console.log(`${dry ? C.yellow('would update') : C.green('updated')}  ${rel}`);
    if (!dry) writeFileSync(file, code);
  }

  if (needsWorker) {
    const workerFile = resolve(st.isDirectory() ? target : dirname(target), workerPath);
    if (existsSync(workerFile)) {
      console.log(C.dim(`\nworker file already present: ${relative(process.cwd(), workerFile)}`));
    } else if (scaffold && !dry) {
      mkdirSync(dirname(workerFile), { recursive: true });
      writeFileSync(workerFile, workerScaffold());
      console.log(`${C.green('created')}  ${relative(process.cwd(), workerFile)}`);
    } else {
      console.log(
        `\n${C.cyan('next:')} create ${relative(process.cwd(), workerFile)} — re-run with ${C.bold('--scaffold')} to generate it.`
      );
    }
  }

  if (allNotes.length) {
    console.log(`\n${C.bold('Needs a human')} ${C.dim('(not rewritten — a codemod that guesses is worse than one that tells you)')}`);
    const byFile = new Map<string, Note[]>();
    for (const { file, note } of allNotes) {
      const rel = relative(process.cwd(), file);
      byFile.set(rel, [...(byFile.get(rel) ?? []), note]);
    }
    for (const [file, notes] of byFile) {
      console.log(`\n  ${C.bold(file)}`);
      for (const n of notes) {
        console.log(`    ${C.dim(`${n.line}:`)} ${n.message}`);
        if (n.code) console.log(`      ${C.dim(n.code.slice(0, 90))}`);
      }
    }
  }

  console.log(
    `\n${C.bold('Summary')}  ${changedCount} file${changedCount === 1 ? '' : 's'} ${dry ? 'would change' : 'changed'}` +
      `, ${allNotes.length} item${allNotes.length === 1 ? '' : 's'} need review` +
      (dry ? C.dim('  (dry run — nothing written)') : '')
  );
  if (changedCount) {
    console.log(C.dim('Then bring your data across: https://github.com/granthlabs/granthlabs.github.io/blob/main/docs/MigratingFromDexie.md'));
  }
  return 0;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Only run when invoked as a binary, so the module stays importable in tests.
if (process.argv[1] && /codemod/.test(process.argv[1])) {
  run(process.argv.slice(2)).then((c) => process.exit(c));
}
