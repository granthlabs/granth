import { defineConfig } from 'vitepress';

// The site is built directly from the docs/ folder, so the published site and
// the docs you read on GitHub cannot drift apart.
export default defineConfig({
  title: 'granth',
  description: 'SQLite in the browser with a Dexie-compatible API. OPFS-backed, runs in a Web Worker, safe across tabs.',
  lang: 'en-GB',
  cleanUrls: true,
  lastUpdated: true,
  base: '/granth/',
  head: [
    ['meta', { name: 'theme-color', content: '#3b5b7a' }],
    ['meta', { property: 'og:title', content: 'granth — SQLite in the browser' }],
    ['meta', { property: 'og:description', content: 'A Dexie-compatible API over SQLite/WASM on OPFS. Real indexes, a real query planner, off the main thread.' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/Tutorial' },
      { text: 'API', link: '/Granth' },
      { text: 'Migrate', link: '/MigratingFromDexie' },
      { text: 'GitHub', link: 'https://github.com/sundarshahi/granth' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Tutorial', link: '/Tutorial' },
          { text: 'Migrating from Dexie', link: '/MigratingFromDexie' },
          { text: 'Frameworks', link: '/Frameworks' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Storage', link: '/Storage' },
          { text: 'Runtimes', link: '/Runtimes' },
          { text: 'Plugins', link: '/Plugins' },
          { text: 'Security & performance', link: '/SecurityAndPerformance' },
        ],
      },
      {
        text: 'API reference',
        items: [
          { text: 'Granth', link: '/Granth' },
          { text: 'Table', link: '/Table' },
          { text: 'Collection', link: '/Collection' },
          { text: 'WhereClause', link: '/WhereClause' },
          { text: 'Transaction', link: '/Transaction' },
          { text: 'liveQuery', link: '/liveQuery' },
          { text: 'Errors', link: '/Errors' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/sundarshahi/granth' }],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/sundarshahi/granth/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: { message: 'MIT licensed', copyright: '© 2026 sundarshahi' },
  },
});
