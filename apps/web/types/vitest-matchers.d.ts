/**
 * jest-dom matcher types for vitest 5.
 *
 * `@testing-library/jest-dom@7` still augments `interface Assertion<T = any>`
 * (see its `types/vitest.d.ts`), but vitest 5 declares
 * `Assertion<R extends void | Promise<void> = void, T = unknown>` — two type
 * parameters. TypeScript only merges declarations whose type parameter lists
 * are identical, so the upstream augmentation silently fails to merge and
 * `toBeInTheDocument` & friends end up untyped. The arity mismatch itself is
 * invisible because `skipLibCheck` suppresses errors inside node_modules.
 *
 * Vitest 5 exposes an empty `Matchers<R, T>` interface as the supported
 * extension point, and `Assertion` extends it — so augmenting `Matchers`
 * types the matchers correctly.
 *
 * The matchers are registered at runtime by the
 * `@testing-library/jest-dom/vitest` import in `vitest.setup.ts`; this file
 * only supplies types. Delete it once jest-dom ships vitest 5 types.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // The empty body and the `any` are both required: declaration merging needs
  // the type parameter list to match vitest's `Matchers` exactly, and the
  // element type jest-dom is matching against is genuinely unconstrained.
  /* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any */
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    T = unknown,
  > extends TestingLibraryMatchers<any, R> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any */
}
