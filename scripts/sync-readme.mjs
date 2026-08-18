/**
 * The README npm shows for `granthdb` is generated from the root README.
 *
 * There used to be two hand-maintained files. They drifted, silently and badly:
 * a full rewrite — clearer instructions, plus Contributing and Security — landed
 * in the root one, so GitHub showed the new document while every npm visitor got
 * a stale one that was months behind. Nothing failed and no test could fail; the
 * only way to notice was to read the copy on the registry.
 *
 * Generating it at `prepack` removes the failure mode rather than documenting
 * it. Relative links have to be absolutised on the way: they resolve on GitHub
 * and 404 on npmjs.com.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLOB = 'https://github.com/granthlabs/granth/blob/main/';

const src = readFileSync(resolve(root, 'README.md'), 'utf8');
const out = src.replace(/\]\(\.\/([^)]+)\)/g, (_, path) => `](${BLOB}${path})`);

writeFileSync(resolve(root, 'packages/core/client/README.md'), out);

const n = (src.match(/\]\(\.\//g) ?? []).length;
console.log(`README -> granthdb (${out.length} bytes, ${n} relative links absolutised)`);
