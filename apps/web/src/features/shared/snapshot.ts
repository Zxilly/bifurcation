export type Snapshot<T> = { value: T; updatedAt: number };

// Server Components hand SWR a pending snapshot: only the component reading
// that key suspends, and a failed read surfaces through the error boundary.
export async function snapshot<T>(read: () => T | Promise<T>): Promise<Snapshot<T>> {
  return { value: await read(), updatedAt: Date.now() };
}
