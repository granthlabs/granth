<script setup>
/**
 * Large patterned footer.
 *
 * The default VitePress footer is a single centred line, which on a docs site
 * wastes the one place a reader looks when they did not find what they came for.
 * This one is a real directory: every top-level destination, grouped, plus the
 * install line and the honest status of the project.
 */
const columns = [
  {
    heading: 'Get started',
    links: [
      { text: 'Tutorial', href: '/Tutorial' },
      { text: 'Migrating from Dexie', href: '/MigratingFromDexie' },
      { text: 'Frameworks', href: '/Frameworks' },
      { text: 'State libraries', href: '/StateLibraries' },
      { text: 'Runtimes', href: '/Runtimes' },
    ],
  },
  {
    heading: 'Use cases',
    links: [
      { text: 'Replacing web storage', href: '/ReplacingWebStorage' },
      { text: 'Cache-first apps', href: '/CacheFirstApps' },
      { text: 'Encryption at rest', href: '/Encryption' },
      { text: 'Security & performance', href: '/SecurityAndPerformance' },
    ],
  },
  {
    heading: 'API',
    links: [
      { text: 'Granth', href: '/Granth' },
      { text: 'Table', href: '/Table' },
      { text: 'Collection', href: '/Collection' },
      { text: 'WhereClause', href: '/WhereClause' },
      { text: 'liveQuery', href: '/liveQuery' },
    ],
  },
  {
    heading: 'Project',
    links: [
      { text: 'GitHub', href: 'https://github.com/sundarshahi/granth' },
      { text: 'Issues', href: 'https://github.com/sundarshahi/granth/issues' },
      { text: 'Plugins', href: '/Plugins' },
      { text: 'Storage', href: '/Storage' },
      { text: 'Errors', href: '/Errors' },
    ],
  },
];
</script>

<template>
  <footer class="gfoot">
    <div class="gfoot__pattern" aria-hidden="true" />

    <div class="gfoot__inner">
      <div class="gfoot__top">
        <div class="gfoot__brand">
          <div class="gfoot__mark">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M16 3 L29 9.4 L16 15.8 L3 9.4 Z" fill="currentColor" />
              <path d="M3 15.6 L16 22 L29 15.6" stroke="currentColor" stroke-width="2.6"
                    stroke-linecap="round" stroke-linejoin="round" opacity="0.6" />
              <path d="M3 22.2 L16 28.6 L29 22.2" stroke="currentColor" stroke-width="2.6"
                    stroke-linecap="round" stroke-linejoin="round" opacity="0.28" />
            </svg>
            <span>granthdb</span>
          </div>
          <p class="gfoot__blurb">
            SQLite in the browser with a Dexie-compatible API. Real indexes, a real query
            planner, off the main thread, and safe across tabs.
          </p>
          <code class="gfoot__install">npm i granthdb @sqlite.org/sqlite-wasm</code>
        </div>

        <nav class="gfoot__cols" aria-label="Footer">
          <div v-for="col in columns" :key="col.heading" class="gfoot__col">
            <h3>{{ col.heading }}</h3>
            <ul>
              <li v-for="l in col.links" :key="l.text">
                <a :href="l.href">{{ l.text }}</a>
              </li>
            </ul>
          </div>
        </nav>
      </div>

      <div class="gfoot__bottom">
        <p>MIT licensed. Built by Sundar Shahi Thakuri.</p>
        <p class="gfoot__note">
          An independent project. Not affiliated with Dexie.js — the API is compatible,
          the implementation is not shared.
        </p>
      </div>
    </div>
  </footer>
</template>
