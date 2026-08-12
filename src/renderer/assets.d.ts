/**
 * Side-effect asset imports, declared for the compiler.
 *
 * `main.tsx` does `import './app.css'` — a Vite idiom, where the bundler turns
 * the import into a stylesheet link and the module itself has no exports.
 * TypeScript 7 refuses side-effect imports of extensions it has no declaration
 * for (TS2882), where 5.x silently let them through, so the idiom now has to be
 * stated rather than assumed.
 *
 * No `export` on purpose: these modules are empty at runtime, and declaring
 * exports would let `import styles from './app.css'` typecheck while yielding
 * undefined at runtime — the compiler waving through exactly the mistake it
 * exists to catch.
 */
declare module '*.css';
