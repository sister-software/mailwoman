# Template: reference

A `reference` page describes a surface so a reader can look one fact up and leave. It is the one role that
runs the controlled register: declarative sentences, no contractions, no humor, tables in place of prose.
Register rules are in [`../writing-system.md`](../writing-system.md) under Register by role.

## Frontmatter skeleton

Copy this to the top of the new page. `source-of-truth` is required for this role and names the files the
page describes, so a reader can check the page against the code.

```yaml
---
title: HTTP API (/v1)
description: The native Mailwoman wire contract — endpoints, bodies, statuses, and the error envelope.
role: reference
source-of-truth: api/routes.ts, api/schema.ts, api/app.ts
---
```

## Section order

1. `# Title` — the surface, named as it is named in code.
2. **Scope.** One paragraph: what this surface is and what it is not.
3. **Contract.** The tables. Endpoints, parameters, return shapes, defaults.
4. **Errors.** One closed table: stable code, one-line meaning, next step.
5. **Examples.** Full request and full literal response, together.
6. **Rationale.** Why the contract has this shape. Last, never first.
7. **See also.**

## Opening move

Name the surface and state what it is in one declarative sentence. No welcome, no scenario, no promise.

## Exemplar paragraph

> `@mailwoman/api` serves the native `/v1` surface: `parse`, `geocode`, `batch`, `resolve`, and `format`,
> plus `/health`, `/metrics`, and an emitted `/openapi.json`. Request bodies are strict and
> validator-enforced. The package takes an engine object in which every method is optional, and an absent
> method answers a status rather than an exception: `/v1/parse` answers `501`, and `/v1/geocode`,
> `/v1/batch`, `/v1/resolve`, and `/v1/reload` answer `503`. `/v1/format` is the exception. It is wired
> in-package from `@mailwoman/formatter` and is available with no engine method at all.

Errors take one closed table. Each row carries a stable code a caller can match on, one line of meaning, and
the next step. An entry that restates its own name is not documentation.

| Status | Body                                                 | Meaning                                                          | Next step                                                               |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `501`  | `{ "error": "not implemented" }`                     | The engine has no `parse` method.                                | Wire `parse` on the engine object.                                      |
| `503`  | `{ "error": "unavailable" }`                         | The engine method exists in the type but not in this deployment. | Check the data root and the resolver database path.                     |
| `400`  | `{ "error": "invalid request body", "detail": "…" }` | The body failed validation.                                      | Read `detail` for the field; the raw validator shape is never returned. |

<!-- illustrative -->

```bash
curl -sS localhost:3000/v1/parse -H 'content-type: application/json' \
  -d '{"address":"221B Baker St, London NW1 6XE"}'
```

## Checks before commit

- Every example was generated or executed. Nothing on this page was typed from memory.
- Request and response appear together, both complete.
- On HTTP surfaces, curl comes first, then language tabs, every tab hitting the identical endpoint.
- On library surfaces, examples are full files with their output, not fragments.
- Placeholders use `<CAPS_PLACEHOLDER>` with an inline replace-me comment.
- Facts precede rationale, and `source-of-truth:` names the files a reader can check against.
- The audit checklist in [`../writing-system.md`](../writing-system.md) has been run over the draft.
