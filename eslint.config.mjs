// Flat config for a Tampermonkey userscript.
// No plugin dependencies, so `npx eslint .` works against a bare install.

const browser = {
  window: 'readonly', document: 'readonly', location: 'readonly',
  localStorage: 'readonly', console: 'readonly', navigator: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  IntersectionObserver: 'readonly', MutationObserver: 'readonly',
  Element: 'readonly', HTMLElement: 'readonly', Image: 'readonly',
  getComputedStyle: 'readonly', fetch: 'readonly', URL: 'readonly',
  DOMParser: 'readonly',
};

// Injected by the userscript manager, and only when @grant asks for them —
// hence the typeof guards in the source.
const greasemonkey = {
  GM_addStyle: 'readonly',
  GM_getValue: 'readonly',
  GM_setValue: 'readonly',
  GM_info: 'readonly',
  unsafeWindow: 'readonly',
};

export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browser, ...greasemonkey },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-shadow': 'warn',
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-implicit-globals': 'error',
      'consistent-return': 'warn',
    },
  },
  {
    // The config file itself is ESM, not a userscript.
    files: ['eslint.config.mjs'],
    languageOptions: { sourceType: 'module' },
  },
];
