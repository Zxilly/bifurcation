export type Snapshot<T> = { value: T; updatedAt: number };

// Server Components hand SWR a resolved snapshot. Reads are synchronous, and a
// pending Promise would make `use()` suspend inside SWR, whose memoized
// snapshot closure then survives React's replay uninitialized.
export function snapshot<T>(read: () => T): Snapshot<T> {
  return { value: read(), updatedAt: Date.now() };
}
