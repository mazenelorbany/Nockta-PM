import globals from 'globals';
import base from './index.mjs';

export default [
  ...base,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
  },
];
