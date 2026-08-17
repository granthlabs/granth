import DefaultTheme from 'vitepress/theme';
import './custom.css';

// Extends the default theme rather than replacing it: the default already ships
// the accessible focus rings, keyboard-navigable sidebar and skip link. Rebuilding
// that to change colours would be trading working a11y for a fresh coat of paint.
export default DefaultTheme;
