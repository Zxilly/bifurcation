---
version: 1
slug: "apps-web-src-features-machines-machines-tsx"
primary_target: "apps/web/src/features/machines/machines.tsx"
related_targets: ["apps/web/src/features/machines/resources.tsx","apps/web/src/features/machines/upgrades.tsx"]
---

# Machine workspace
Mode: Operate. Scope: machine list and details, preserving the existing Kumo system and every authorized operation. User chose four tabs: overview, usage, activity, access and maintenance.

## Direction contract
THESIS: A compact machine workspace: inspect health first, enter maintenance deliberately.
OWN-WORLD: Existing Kumo semantic surfaces, Inter/Noto Sans SC, restrained state colors, native Table/Tabs/Button/Meter.
STORY: Find a node by name, address, region or tag; assess current health and configuration; inspect usage or tasks; maintain the installation with its explicit constraints.
FIRST VIEWPORT: Name/status and address/tags header, primary configuration action, four underline tabs, one four-column resource strip, two adjacent definition lists for machine and configuration. Maintenance uses two columns for versions and access; destructive actions follow with visible consequences.
FORM: User-selected tabbed workspace; surface seed 760a9810. Code-led within the established Kumo identity; no new visual-world or raster assets. Tabs preserve URL state; active tasks remain visible across tabs.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

References: Cockpit official overview screenshot https://cockpit-project.org/images/screenshot/overview.webp and https://cockpit-project.org/blog/pcp-grafana.html ; Tailscale machine/device organization https://tailscale.com/docs/features/access-control/device-management/how-to/set-up and https://tailscale.com/docs/features/tags . These are composition references, not new product behavior.
