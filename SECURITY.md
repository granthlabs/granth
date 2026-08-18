# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private reporting: go to the
[Security tab](https://github.com/granthlabs/granth/security/advisories/new) and choose
**Report a vulnerability**. That thread is visible only to you and the maintainer.

If that form is unavailable to you, email **shahithakurisundar@gmail.com** with `granth security`
in the subject.

Please include a reproduction if you can — a schema string and a few lines that trigger the
behaviour is ideal.

### What to expect

granth is maintained by one person, so here are honest timings rather than a corporate SLA:

| | |
|---|---|
| First reply | within 5 working days |
| Assessment of whether it is a vulnerability | within 14 days |
| Fix for a confirmed issue | as fast as I can, prioritised over everything else |

You will be credited in the advisory and the release notes unless you would rather not be. If I
conclude something is **not** a vulnerability, I will explain why rather than closing silently —
and if you disagree, say so, because I would rather re-examine it than be wrong.

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | Yes |
| 0.1.x | No — upgrade; it contains defects fixed in 0.2.1 |

While the project is pre-1.0, fixes land on the newest minor only.

## The threat model, stated plainly

granth runs **entirely inside the user's browser**. There is no server, no multi-tenant boundary
and no privilege separation between your app and the database. That shapes what a vulnerability
in this project can even be.

**In scope** — please report these:

- SQL injection: any input that escapes parameter binding or identifier quoting and changes the
  meaning of a statement. Schema strings, key paths, table names and query values are all trust
  boundaries.
- Cross-tab attacks: one tab reading or corrupting another origin's data through the leader
  election or the worker RPC.
- A flaw in the encryption addon that exposes plaintext where it claims not to — including
  plaintext reaching disk, or a key becoming extractable.
- Prototype pollution, or any path where stored data becomes executable code.
- A dependency vulnerability that is genuinely reachable from granth's code.

**Not vulnerabilities** — these come up often enough to name:

- **The sandbox runs the code you type.** `examples/playground/sandbox.js` uses `new Function` on
  purpose. The code comes from the person typing it, into their own browser, with no privileged
  scope to reach. That is a REPL, not an injection vector — which is also why it is an example
  and not part of the library.
- **XSS on your page defeats everything here.** Script running on your origin can call the
  database API directly. This is true of `localStorage`, IndexedDB and every other browser
  storage. Encryption at rest does not change it, because the key is in the page by then.
- **A user can read their own database.** DevTools, the OPFS file and the sandbox all expose it.
  Data on a device belongs to whoever holds the device.
- **Storage eviction and data loss.** Browsers delete origin storage — Safari after 7 days of no
  visits, users on demand. This is a durability property, not a security one. Treat the local
  database as a cache, never the only copy.
- **Denial of service by writing a lot of data.** Quota limits are the browser's job.

## What encryption at rest does and does not do

The [encryption addon](https://granthlabs.github.io/encryption) encrypts field values
with AES-GCM via the Web Crypto API, using a key derived with PBKDF2 and held **non-extractable**
so it cannot be read back out of the page.

It protects against someone reading the stored file — a shared machine, a forensic copy of the
profile, a backup.

It does **not** protect against script running on your origin, because that script can simply ask
the database for the decrypted value. If an attacker is executing code in the page, encryption at
rest is already bypassed.

Indexed fields cannot be encrypted and still be searchable by range — that is a property of
encryption, not a bug. The docs say which fields you can and cannot cover.

## What is checked automatically

Every commit runs a fuzz suite over the identifier and JSON-path boundaries: hostile schema
strings, key paths and table names, plus a direct test of the quoting function. It asserts no
injection, no canary damage and no quoting leaks.

That suite once passed **while the quoting was deliberately broken**, which proved it was not
reaching the quoting layer at all. It now tests that function directly as well — and that is
what found NUL bytes silently truncating an identifier.

Dependencies are watched by Dependabot. The library's own runtime dependency footprint is
`@sqlite.org/sqlite-wasm` and nothing else.
