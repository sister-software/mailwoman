# release-kit

The registry defines operations for preflight, preparation, packing, verification, staging, publishing, copying
weights and generating the software bill of materials. Each operation declares an ID, an effect
(`read`, `local-write` or `external-write`), typed input and output, and a `run` function.

No file here is executed directly. The private `mwops` CLI and the release MCP server are
views over `lib/registry.ts`. CI calls `mwops release <operation>`. Before publishing, `release.plan` returns a
digest of HEAD, the version, the packages, the artifacts and their destinations. `release.publish` recomputes the
digest and refuses to publish if the working tree is dirty, HEAD has moved or the digest differs.

Admission rule: an operation participates in the construction, verification, staging, or publication of a release
artifact. Other content doesn't belong here.
