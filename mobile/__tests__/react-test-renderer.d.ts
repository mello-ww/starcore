// `react-test-renderer` (a devDependency, used only by
// declarativeScreen.test.tsx) has no bundled or published types this
// project's TypeScript version can find. This is the minimal, standard
// escape hatch `tsc` itself suggests: treat the module as untyped rather
// than pulling in an extra @types package for one test file.
declare module 'react-test-renderer';
