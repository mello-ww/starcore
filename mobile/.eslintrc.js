module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  // 'react-native/react-native' needs eslint-plugin-react-native, which this
  // project doesn't install; es2020 plus React Native's own __DEV__ global
  // covers what the source uses (tsc checks the rest of the globals).
  env: {es2020: true, jest: true},
  globals: {__DEV__: 'readonly'},
  parserOptions: {ecmaVersion: 2020, sourceType: 'module'},
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
  overrides: [
    {
      // jest.mock() factories and jest.isolateModules() can only load
      // modules with require(), so it is allowed in tests (not in src/)
      files: ['__tests__/**/*.ts', '__tests__/**/*.tsx'],
      rules: {'@typescript-eslint/no-var-requires': 'off'},
    },
  ],
};
