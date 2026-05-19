const globals = require('globals');
const base = require('./index.js');

module.exports = [
  ...base,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
  },
];
