# Arcadia projects

daddyloop registers the source mount as a named project. The project's relative subdirectory becomes the starting directory inside each managed workspace. Native review and submitted work stay pinned to full commit hashes.

## One-time setup

Install and authenticate the company `arc` CLI and configure `arcadia-mount-lease` with a shared object store and the permitted mount range. Use the helper's own configuration rather than copying another machine's paths.

```bash
daddy arcadia setup --lease-helper /absolute/path/to/arcadia-mount-lease
daddy arcadia mounts
daddy projects add ~/arcadia2 --name Work --base trunk
```

For a project whose agents should start in a subdirectory:

```bash
daddy projects add ~/arcadia2/alice --name Alice --base trunk
```

Only mounts that use the configured shared object store can be registered. Source folders of registered Arcadia projects are excluded from the writer/review allocation pool. The service checks leases before using an existing workspace; unverified branches, dirty work and mismatched stores are preserved.

## Allocation and capacity

Each active writer gets a separately leased working copy. daddy and the native reviewer use read-only project/revision snapshots. Allocation within the service is serialized; the helper provides machine-level lease coordination.

If another free slot is needed, daddyloop may mount an unmounted, unreserved slot within the helper's configured range. It does not commandeer busy slots or expand the configured range. At least one eligible working copy stays available for daddy/review, so writers cannot consume all review capacity.

When capacity is temporarily unavailable, jobs remain queued and retry after a delay. The configured writer pool is an upper limit; actual concurrency also depends on free mounts and host resources.

A clean author workspace can be released after its exact commit is confirmed in the native PR. Later corrections get another task-owned branch and push normally to the existing PR branch. Unsubmitted, diverging or dirty author work retains its lease. Read-only snapshots restore their original branch before release.

## Resource hygiene

The service checks configured disk and memory thresholds before starting work and before creating additional mounts. `daddy cache status` inspects eligible application-owned caches. Use the ordinary Arc GC command exposed by the CLI when appropriate; truncating GC is never used automatically.

Mounts, stores and source checkouts belong to the host setup. Their size alone does not make them disposable. Inspect leases and preserve user changes before manual maintenance.
