# granth-codemod

Automated Dexie → [granth](https://github.com/granthlabs/granthlabs.github.io) source migration.

```bash
npx granth-codemod ./src --dry      # preview
npx granth-codemod ./src --scaffold # write, and generate the worker file
```

Uses the TypeScript compiler API rather than regex, because the constructs it rewrites are
trivially spoofable inside strings and comments.

It rewrites imports, `new Dexie(...)`, `extends Dexie` and `dexie-react-hooks`; scaffolds a worker
file; and **reports** what it refuses to touch — `upgrade()` callbacks, Dexie middleware,
`Dexie.Promise`, `backendDB()`. A codemod that guesses is worse than one that tells you where to
look.

## Install

```bash
npm install granth-codemod
```

Full documentation: **https://granthlabs.github.io**

## License

MIT
