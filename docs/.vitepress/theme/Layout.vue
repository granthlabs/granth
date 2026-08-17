<script setup>
import { ref, computed } from 'vue';
import DefaultTheme from 'vitepress/theme';
import Footer from './Footer.vue';

const { Layout } = DefaultTheme;

/**
 * Tabbed hero showcase.
 *
 * The landing page shows WORKING CODE next to the pitch so a reader judges the
 * API itself instead of adjectives. Tabs let four different jobs share one
 * panel — schema, query, reactivity, extension — which is far more convincing
 * than one snippet, and cheaper than four screenshots that go stale.
 *
 * `hl` marks the lines that carry the point of each tab, so the eye lands on
 * the two lines that matter rather than scanning twenty.
 */
const tabs = [
  {
    id: 'database',
    label: 'Database',
    file: 'db.js',
    // The schema is the point of this tab, so that is what is highlighted — not
    // the closing brace above it. Lines are kept under ~62 characters because
    // the panel does not wrap and a longer line just disappears off the edge.
    hl: [[6, 8]],
    code: `import { Granth } from 'granthdb';

const worker = () => new Worker('./db.worker.js');
export const db = new Granth('myapp', { worker });

db.version(1).stores({
  friends: '++id, name, age, *tags, [name+age]',
});`,
  },
  {
    id: 'query',
    label: 'Query',
    file: 'friends.js',
    hl: [[3, 5]],
    code: `// Filter on one index, order by ANOTHER.
// A cursor-based store cannot: SQL has no such limit.
const grownups = await db.friends
  .where('age').between(18, 65)
  .orderBy('name')
  .toArray();

// One round trip, not 500.
const some = await db.friends.bulkGet(ids);`,
  },
  {
    id: 'liveQuery',
    label: 'liveQuery',
    file: 'FriendList.jsx',
    hl: [[5, 7]],
    code: `import { useLiveQuery } from 'granth-react';

export function FriendList() {
  // Re-runs on change — including writes from ANOTHER TAB.
  const friends = useLiveQuery(db, () =>
    db.friends.where('age').above(18).toArray()
  );

  return <ul>{friends?.map((f) => (
    <li key={f.id}>{f.name}, {f.age}</li>
  ))}</ul>;
}`,
  },
  {
    id: 'plugins',
    label: 'Plugins',
    file: 'encrypt.js',
    hl: [[4, 6]],
    code: `// Storage, runtime and addons are all swappable.
db.use({
  name: 'encrypted-fields',
  setup(ctx) {
    ctx.before(async (call) => seal(call));      // on write
    ctx.after(async (call, rows) => open(rows)); // on read
  },
});`,
  },
];

const active = ref('database');
const current = computed(() => tabs.find((t) => t.id === active.value) ?? tabs[0]);
const currentLines = computed(() => current.value.code.split('\n'));

const isHighlighted = (n) => current.value.hl?.some(([a, b]) => n >= a && n <= b) ?? false;

const benefits = [
  {
    title: 'Queries that stay fast as data grows',
    body: "SQLite's planner picks the index. Filter on one field and sort by another in a single statement, instead of pulling the table into JavaScript and sorting it there.",
    href: '/Collection', linkText: 'Query API',
  },
  {
    title: 'Never blocks your interface',
    body: 'SQL runs in a dedicated Worker. localStorage is synchronous and janks the main thread on every read; a slow scan here cannot drop a frame, because it is not on your thread.',
    href: '/Runtimes', linkText: 'Runtimes',
  },
  {
    title: 'Correct with many tabs open',
    body: 'One tab is elected writer through Web Locks and the rest route to it. Two tabs writing one file is how browser databases corrupt — so the test suite kills the writer mid-write.',
    href: '/Runtimes', linkText: 'How election works',
  },
  {
    title: 'Your data survives the round trip',
    body: 'Date, NaN, Infinity, BigInt and null come back as themselves. Plain JSON destroys all five silently, which is a data-loss bug wearing a serialisation costume.',
    href: '/Granth', linkText: 'Value handling',
  },
  {
    title: 'Encrypt what matters, at rest',
    body: 'Browser storage is plaintext on disk — OPFS included. A field-level AES-GCM addon seals sensitive values before they reach SQLite, with a test that greps the raw file to prove it.',
    href: '/Encryption', linkText: 'Encryption',
  },
  {
    title: 'Migrate without a rewrite',
    body: 'A codemod rewrites what is safe and reports what is not. Then import your existing IndexedDB data, schema inference included, and delete the old blob.',
    href: '/MigratingFromDexie', linkText: 'Migration guide',
  },
];

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(current.value.code);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1600);
  } catch { /* clipboard blocked; the code is selectable anyway */ }
}
</script>

<template>
  <Layout>
    <!-- Short claims above the pitch: what you get, in three beats. -->
    <template #home-hero-info-before>
      <ul class="hero-claims">
        <li>No backend required</li>
        <li>Works offline, syncs when you say so</li>
        <li>One API across every framework</li>
      </ul>
    </template>

    <template #home-hero-image>
      <div class="showcase">
        <div class="showcase__pattern" aria-hidden="true" />

        <div class="showcase__tabs" role="tablist" aria-label="granthdb examples">
          <button
            v-for="t in tabs"
            :key="t.id"
            role="tab"
            :aria-selected="active === t.id"
            :class="['showcase__tab', { 'is-active': active === t.id }]"
            @click="active = t.id"
          >{{ t.label }}</button>
        </div>

        <div class="showcase__panel">
          <div class="showcase__bar">
            <span class="showcase__file">{{ current.file }}</span>
            <button class="showcase__copy" type="button" @click="copy">
              {{ copied ? 'Copied' : 'Copy' }}
            </button>
          </div>

          <div class="showcase__code">
            <div
              v-for="(line, i) in currentLines"
              :key="i"
              :class="['showcase__line', { 'is-hl': isHighlighted(i + 1) }]"
            >
              <span class="showcase__num" aria-hidden="true">{{ i + 1 }}</span>
              <code class="showcase__text">{{ line || ' ' }}</code>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Benefits, after the feature grid: why this, over what you have now. -->
    <template #home-features-after>
      <section class="benefits">
        <div class="benefits__pattern" aria-hidden="true" />
        <div class="benefits__inner">
          <p class="benefits__eyebrow">Primary benefits</p>
          <h2 class="benefits__title">Why granthdb?</h2>
          <p class="benefits__lede">
            IndexedDB's model with a real query engine underneath — off your main thread,
            correct when the user has three tabs open, and reachable through the API you
            already know.
          </p>

          <div class="benefits__grid">
            <article v-for="(b, i) in benefits" :key="b.title" class="benefit">
              <span class="benefit__num" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span>
              <h3 class="benefit__title">{{ b.title }}</h3>
              <p class="benefit__body">{{ b.body }}</p>
              <a v-if="b.href" class="benefit__link" :href="b.href">{{ b.linkText }} &rarr;</a>
            </article>
          </div>
        </div>
      </section>
    </template>

    <template #layout-bottom>
      <Footer />
    </template>

  </Layout>
</template>
