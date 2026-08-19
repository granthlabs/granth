# granth-mcp

An MCP server for [granthdb](https://granthlabs.github.io). It gives a coding
assistant two things it cannot get by reading: a database to run your query
against, and the API surface read off the live objects.

```bash
claude mcp add granth -- npx -y granth-mcp
```

Node 22.5+ (the scratch database is `node:sqlite`). No browser, no OPFS, no build.

## Why, when the docs are already machine-readable

Every page is published as
[`llms-full.txt`](https://granthlabs.github.io/llms-full.txt) in one request, so
a server that only served documentation would add an install step and hand back
what a URL hands back for free.

What a fetch cannot do is run the code. granthdb is Dexie-compatible, so an
assistant writes granthdb by pattern-matching Dexie — and eight Dexie members are
deliberately not implemented, with one more that shares a name and not a
contract. Reading does not prevent that; the code failing does.

## Tools

**`granth_run`** — executes a snippet against a real, throwaway granthdb and
returns what it produced. Fresh database per call. Errors come back verbatim,
because for this tool the error is the product as often as the value is.

**`granth_api`** — the methods that exist on `Granth`, `Table`, `Collection` and
`WhereClause` by prototype walk, plus `DEXIE_WAIVERS` and `DEXIE_DIVERGENCES` —
the same constants the parity audit asserts in CI, so the server cannot drift
from the library.

## It is not a sandbox

The snippet runs in a worker thread of this process. That is a **termination**
boundary, not a security one: a runaway snippet gets killed at 15 seconds, but
`node:fs` and `process` are still reachable from inside it. Run it locally,
against code you asked it to run.

The worker is there because the alternative does not work — racing against a
timer on the main thread cannot interrupt a synchronous loop, so the server
wedges and every later call hangs with nothing to explain it.

Full documentation: <https://granthlabs.github.io/mcp>

MIT
