// SWR cache identities. Server Components provide fallback data under these
// keys and Client Components read the same keys, so the identity is defined
// once and stays free of server-only and client-only imports.
export const resourceKeys = {
  machines: "machines",
  machine: (id: string) => `machine:${id}`,
  machineConfiguration: (id: string) => `machine-config:${id}`,
  machineUpgrades: (id: string) => `machine-upgrades:${id}`,
  users: "admin-users",
};
