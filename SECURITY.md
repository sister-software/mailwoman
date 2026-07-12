# Security Policy

## Reporting a vulnerability

If you find a security issue in Mailwoman, please report it privately — **do not
open a public GitHub issue** for anything that could be exploited.

Email **teffen@sister.software** with:

- a description of the issue and the impact you think it has,
- the steps (or a proof of concept) to reproduce it,
- the version or commit you found it on.

You'll get an acknowledgement as soon as we can, and we'll keep you in the loop
while we work on a fix. We're a small team, so we won't promise a same-day
turnaround — but a real vulnerability jumps the queue.

Please give us a reasonable window to ship a fix before disclosing publicly.
We're happy to credit you in the release notes if you'd like.

## Supported versions

Mailwoman is pre-1.0 in spirit even though the npm version is 5.x — the public
API is still settling. Security fixes land on the **latest published minor**
(`5.x`). We don't backport to older minors; upgrading forward is the supported
path.

## Scope

What's in scope: the published npm packages (`mailwoman`, `@mailwoman/*`), the
CLI, and the resolver/server code in this repository.

What's out of scope: third-party data we bundle or attribute (libpostal,
libaddressinput, Who's on First, GeoNames — see
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)), and issues that require a
malicious local data file you supplied yourself. The model is a statistical
parser — a wrong parse is a quality bug, not a security one; please file those
as normal issues.
