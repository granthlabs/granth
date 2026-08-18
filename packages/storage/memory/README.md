# granth-storage-memory

In-memory storage backend for [granth](https://github.com/granthlabs/granth).

Persists nothing. The point is that it works absolutely everywhere: Node, SSR, unit tests, private
browsing, sandboxed iframes. Use it as the last entry in a storage list so an app degrades to
ephemeral rather than throwing.

## Install

```bash
npm install granth-storage-memory
```

Full documentation: **https://granthlabs.github.io**

## License

MIT
