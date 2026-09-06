# @mailwoman/release-mcp

The release-kit registry as an MCP server, for a maintainer's agent session. Private; never published.

Every operation `@mailwoman/release-kit` registers becomes one tool, named after its id (`release.verify-metadata` →
`release_verify_metadata`) and described with the effect the registry declares: `[read]`, `[local-write]` or
`[external-write]`. A writing tool takes a `dry_run` argument. `release_operations` lists the whole registry, including
the operations this server is not exposing, so an absence is visible rather than silent.

**The two publishing operations are off by default.** A session that receives this server must not thereby receive npm
authority. Start the server with `--allow-external-write` to expose `release_publish_workspace` and
`release_bless_package`; they still run the plan → execute contract the operations themselves enforce — a plan file from
`release_plan` whose digest must match on an unmoved, clean HEAD.

```jsonc
// An MCP client's server entry
{ "command": "node", "args": ["packages/release-mcp/lib/cli.ts", "--repo-root", "/path/to/mailwoman"] }
```

This package carries no release logic. What an operation does, and what it refuses, belongs to `@mailwoman/release-kit`
(`packages/release-kit/lib/registry.ts`); the private CLI `mwops` is the other view over the same registry. Record:
`docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md` §4–§5.
