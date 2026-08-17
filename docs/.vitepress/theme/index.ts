import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import './custom.css';

// Extends the default theme rather than replacing it: the default already ships
// accessible focus rings, a keyboard-navigable sidebar and a skip link.
// Rebuilding that to change colours would trade working a11y for a coat of paint.
// The custom Layout only fills a slot; it does not reimplement the chrome.
export default {
  extends: DefaultTheme,
  Layout,
};
