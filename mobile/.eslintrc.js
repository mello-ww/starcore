module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {'react-native/react-native': true, jest: true},
  parserOptions: {ecmaVersion: 2020, sourceType: 'module'},
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
