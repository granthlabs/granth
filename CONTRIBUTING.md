# Contributing to granth

Thanks for looking. Bug reports with a reproduction are as valuable as patches — a database that
loses a row is worth more attention than a missing feature.

## Getting set up

You need **Node 22 or newer** (the test suites use the built-in `node:sqlite`).

```bash
git clone https://github.com/granthlabs/granth
cd granth
npm install
npm test
```

`npm test` builds every package and then runs the Node suites. It should be green on a fresh
clone; if it is not, that is a bug worth reporting on its own.

To see your changes in a browser:

```bash
npm run dev        # then open /sandbox, /demos/ or / (the verification suite)
```

## How the repo is laid out

```
packages/core/protocol    plugin contracts — types only, no runtime code
packages/core/engine      schema parsing, query planning, SQL compilation, value codec
packages/core/client      the Dexie-shaped API you import as `granthdb`
packages/storage/*        where the bytes live: opfs, indexeddb, memory
packages/runtime/*        where SQL executes: worker, inline
packages/bindings/*       react, vue
packages/opfs-leader      multi-tab leader election, published standalone
docs/                     the documentation site, built straight from these files
examples/playground       the sandbox, framework demos and every browser test
```

The engine is deliberately environment-agnostic: hand it an adapter with `{all, exec, run}` and
it works against `node:sqlite` in a test or `sqlite-wasm` in a browser. That is what makes real
SQL testable offline.

## How this is tested, and why in layers

Each layer catches something the one below it cannot.

| Command | What it proves |
|---|---|
| `npm test` | Engine and client behaviour against **real SQLite** via `node:sqlite` |
| `node examples/playground/browser-test.mjs` | The platform layer: real OPFS, sqlite-wasm, durability across a full reload |
| `node examples/playground/twotab-test.mjs` | Failover when the writer tab dies |
| `npm test -w opfs-leader` | Election, failover, and that an abandoned call cannot run late |
| `node examples/playground/concurrency-test.mjs` | Many tabs, one writer, no lost or duplicated writes |
| `node examples/playground/hosted-play-test.mjs` | The **built** site, as a static host serves it |
| `node examples/playground/flash-probe.mjs` | Pages paint the right background before CSS loads |

Two of those exist because of specific bugs that a green suite missed:

- **`test-dexie-parity.mjs`** runs the same script against the real `dexie` package and against
  granth and diffs the answers. The older audit only checked that methods *existed*, so a method
  that returned the wrong thing passed — including one that deleted a row. Expectations you write
  yourself share the blind spot with the bug; Dexie does not.
- **`hosted-play-test.mjs`** drives the built bundle rather than the dev server. Vite resolves
  modules live in dev, so a worker that is missing from the production build looks fine locally.

Browser suites need Playwright's Chromium once:

```bash
npx playwright install --with-deps chromium
```

## What a change needs before it can be merged

**1. A guard, verified by breaking it.** Any bug fix leaves behind one test that fails when the
fix is reverted. A test that passes both ways is not a test. Revert your fix, watch it go red,
put it back.

**2. Real SQL, not a mock.** Behaviour is asserted against SQLite actually executing, because
the interesting failures are affinity, ordering, triggers and transactions — precisely what a
mock cannot have.

**3. Dexie parity, or a written reason.** If your change touches query behaviour, add a case to
`test-dexie-parity.mjs`. If granth must differ, mark the case `allow:` with the reason. A stale
`allow:` — one that no longer differs — fails the run, so exemptions cannot quietly rot.

**4. Comments that say why, not what.** The codebase explains the reasoning behind
non-obvious choices, usually the bug that forced them. Prefer "the correlated form scans the
base table, measured 295 ms vs 2.4 ms" over "use an IN subquery".

**5. Documentation, if you changed the API.** `test-docs-coverage.mjs` fails the build when a
public member is not mentioned anywhere in `docs/`.

## Touching the UI or the docs site

The site and the hosted sandbox share one token file,
`docs/.vitepress/theme/tokens.css`. Take colours, spacing, type sizes and radii from there —
nothing should hardcode a value at the call site. That file exists because there used to be
three copies of the design and two were always drifting.

Anything user-facing also needs its empty, loading and error states, keyboard operation, and a
check at phone width. `flash-probe.mjs` and `link-check.mjs` cover the traps that are invisible
locally: a white flash before CSS loads, and links that work on a root-served dev server but
404 under the site's `/granth/` base.

## Reporting a bug

The most useful report is one someone else can run. Please include:

- What you expected and what happened instead.
- Your schema string — most query bugs turn on the exact index declaration.
- Browser and version, and whether it reproduces in a normal window as well as a private one
  (Safari private browsing has no OPFS at all, which changes the storage backend).
- Whether it reproduces in the [sandbox](https://granthlabs.github.io/play/sandbox) —
  if it does, that is a complete reproduction on its own.

If it is a **security** issue, do not open a public issue — see [SECURITY.md](./SECURITY.md).

## Commit and PR style

Explain the *why* in the commit body, especially the failure mode a change prevents. State
plainly what you verified and what you did not; "browser suites not run" is more useful than
silence.

## Licence

Contributions are accepted under the [MIT licence](./LICENSE) that covers the project.
