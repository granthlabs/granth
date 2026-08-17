<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import DefaultTheme from 'vitepress/theme';
import { withBase } from 'vitepress';
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
    icon: 'layers',
    title: 'Local-first storage',
    body: 'SQLite compiled to WebAssembly, kept in OPFS — the fastest storage the browser offers, with no COOP/COEP headers required.',
    points: ['Works fully offline', 'Megabytes, not a 5 MB cap', 'Falls back when OPFS is absent'],
  },
  {
    icon: 'bolt',
    title: 'A real query planner',
    body: 'Filter on one index and order by another in a single statement. A cursor-based store walks one index per query and sorts the rest in JavaScript.',
    points: ['Compound and multiEntry indexes', 'count() without iterating', 'bulkGet in one round trip'],
  },
  {
    icon: 'chip',
    title: 'Off the main thread',
    body: 'SQL executes in a dedicated Worker, so a slow scan cannot drop a frame. localStorage is synchronous and blocks on every read.',
    points: ['No jank on large reads', 'Inline runtime for strict CSP', 'Streams results back by message'],
  },
  {
    icon: 'tabs',
    title: 'Safe across tabs',
    body: 'One tab is elected writer through Web Locks and every other tab routes to it. Two tabs writing one file is how browser databases corrupt.',
    points: ['Single-writer election', 'Failover tested by killing the writer', 'Cross-tab transactions'],
  },
  {
    icon: 'shield',
    title: 'Encrypted at rest, honestly',
    body: 'Browser storage is plaintext on disk, OPFS included. A field-level AES-GCM addon seals values before they reach SQLite.',
    points: ['AES-GCM, fresh IV per value', 'Proven by grepping the raw file', 'Clear about what it cannot stop'],
  },
  {
    icon: 'puzzle',
    title: 'Any framework, no adapter',
    body: 'A live query is already an observable and already a Svelte store, so most ecosystems need no glue at all.',
    points: ['React, Vue, Angular, Svelte', 'RxJS, Zustand, TanStack Query', 'Storage and runtime are plugins'],
  },
];

/* Outline icons, 28px, stroke-based so they read as a set. Inline rather than an
   icon package: six shapes are not worth a dependency, and these inherit colour. */
const icons = {
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 21 7.5 12 12 3 7.5z"/><path d="M3 12.5 12 17l9-4.5"/><path d="M3 17 12 21.5 21 17"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/></svg>',
  tabs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M8 6V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 20 5.5v6c0 5-3.4 8.9-8 10.5-4.6-1.6-8-5.5-8-10.5v-6z"/><path d="M9 12l2 2 4-4"/></svg>',
  puzzle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3h4a1 1 0 0 1 1 1v2a2 2 0 1 0 4 0V4h1a1 1 0 0 1 1 1v4h-2a2 2 0 1 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 1 0-4 0v2H5a1 1 0 0 1-1-1v-4h2a2 2 0 1 0 0-4H4V5a1 1 0 0 1 1-1h5z"/></svg>',
};

/* The final headline line cycles. Each is a real capability with a page behind
   it — a rotator that names things the library does not do would be a lie that
   moves. */
const rotating = ['Offline storage', 'Multi-tab safety', 'Encryption at rest', 'Instant queries'];
const rotIndex = ref(0);
let rotTimer = null;
onMounted(() => {
  // Respect reduced motion: a headline that changes under you is exactly the
  // kind of movement that setting exists to stop.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  rotTimer = setInterval(() => { rotIndex.value = (rotIndex.value + 1) % rotating.length; }, 2600);
});
onUnmounted(() => { if (rotTimer) clearInterval(rotTimer); });

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
    <!--
      Custom hero. VitePress's own VPHero is hidden in CSS rather than removed,
      because the rest of the home layout — the feature grid, and our slots after
      it — still comes from that component.

      Links go through withBase(): the site is served under /granth/, so a bare
      /Tutorial href 404s in production while working fine on a root-served dev
      server. That asymmetry is exactly how broken links reach a deploy.
    -->
    <template #home-hero-before>
      <section class="ghero">
        <div class="ghero__bg" aria-hidden="true" />

        <div class="ghero__inner">
          <div class="ghero__copy">
            <p class="ghero__eyebrow">Zero config &amp; no backend required</p>

            <h1 class="ghero__title">
              <span class="ghero__line">Build fast, stay local.</span>
              <span class="ghero__line">granthdb handles</span>
              <span class="ghero__rot" aria-live="polite">{{ rotating[rotIndex] }}</span>
            </h1>

            <p class="ghero__lede">
              SQLite in the browser with a Dexie-compatible API. Real indexes and a real
              query planner, running off your main thread and safe across every open tab —
              with no server to maintain.
            </p>

            <div class="ghero__actions">
              <a class="ghero__cta" :href="withBase('/Tutorial')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" />
                </svg>
                Get started
              </a>
              <a class="ghero__secondary" :href="withBase('/play/sandbox.html')">
                <span class="ghero__play" aria-hidden="true" />
                Try it in your browser
              </a>
            </div>
          </div>

          <div class="ghero__panel">
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
          </div>
        </div>
      </section>
    </template>

    <!-- Benefits, after the feature grid: why this, over what you have now. -->
    <template #home-features-after>
      <section class="benefits">
        <div class="benefits__pattern" aria-hidden="true" />
        <div class="benefits__inner">
          <!-- Heading sits in its own column so the grid reads as one block
               rather than a headline stranded above six loose items. -->
          <header class="benefits__head">
            <p class="benefits__eyebrow">Primary benefits</p>
            <h2 class="benefits__title">Why granthdb?</h2>
            <span class="benefits__rule" aria-hidden="true" />
          </header>

          <div class="benefits__grid">
            <article v-for="b in benefits" :key="b.title" class="benefit">
              <span class="benefit__icon" aria-hidden="true" v-html="icons[b.icon]" />
              <h3 class="benefit__title">{{ b.title }}</h3>
              <p class="benefit__body">{{ b.body }}</p>
              <ul class="benefit__points">
                <li v-for="pt in b.points" :key="pt">{{ pt }}</li>
              </ul>
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
