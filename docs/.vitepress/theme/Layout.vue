<script setup>
import DefaultTheme from 'vitepress/theme';
const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <!--
      The landing pattern worth copying from the good docs sites: the hero shows
      WORKING CODE next to the pitch, so a reader decides from the API itself
      rather than from adjectives. Marked up by hand instead of run through the
      highlighter because it is chrome, not content — it must not end up in the
      search index competing with the real Tutorial page.
    -->
    <template #home-hero-image>
      <div class="hero-code" aria-hidden="true">
        <div class="hero-code__bar">
          <span class="hero-code__dot" /><span class="hero-code__dot" /><span class="hero-code__dot" />
          <span class="hero-code__file">db.js</span>
        </div>
<pre class="hero-code__body"><code><span class="k">import</span> { Granth } <span class="k">from</span> <span class="s">'granthdb'</span>;

<span class="k">const</span> db = <span class="k">new</span> <span class="t">Granth</span>(<span class="s">'myapp'</span>, {
  worker: () <span class="k">=></span> <span class="k">new</span> <span class="t">Worker</span>(<span class="c">/* … */</span>),
});

db.<span class="f">version</span>(<span class="n">1</span>).<span class="f">stores</span>({
  friends: <span class="s">'++id, name, age, *tags'</span>,
});

<span class="c">// filter on one index, order by another</span>
<span class="k">await</span> db.friends
  .<span class="f">where</span>(<span class="s">'age'</span>).<span class="f">above</span>(<span class="n">18</span>)
  .<span class="f">orderBy</span>(<span class="s">'name'</span>)
  .<span class="f">toArray</span>();</code></pre>
      </div>
    </template>
  </Layout>
</template>
