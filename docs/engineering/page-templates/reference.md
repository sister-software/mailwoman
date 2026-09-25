# Template: reference

A `reference` page describes a surface so a reader can look one fact up and leave. It is the only role that
uses the controlled register: declarative sentences and tables in place of prose, without contractions or
humor.
Register rules are in [`../writing-system.md`](../writing-system.md) under Register by role.

## Frontmatter skeleton

Copy this to the top of the new page. `source-of-truth` is required for this role and lists the files the
page describes, so a reader can check the page against the code.

```yaml
---
title: HTTP API (/v1)
description: The native Mailwoman wire interface — endpoints, bodies, statuses, and the error envelope.
role: reference
source-of-truth: api/routes.ts, api/schema.ts, api/app.ts
---
```

## Section order

1. `# Title`: the surface, named as it is named in code.
2. **Scope.** One paragraph: what this surface is and what it is not.
3. **Interface.** The tables. Endpoints, parameters, return shapes, defaults.
4. **Errors.** One closed table: stable code, one-line meaning, next step.
5. **Examples.** Full request and full literal response, together.
6. **Rationale.** Why the interface has this shape. Last, never first.
7. **See also.**

## Opening move

Identify the surface and state what it is in one declarative sentence. Leave out any welcome, scenario, or
promise.

## Exemplar paragraph

> `@mailwoman/api` serves the native `/v1` surface: `parse`, `geocode`, `batch`, `resolve`, and `format`,
> plus `/health`, `/metrics`, and an emitted `/openapi.json`. Request bodies are strict and
> validator-enforced. The package takes an engine object in which every method is optional. When a method is
> absent, the endpoint returns a status code instead of throwing: `/v1/parse` returns `501`, and
> `/v1/geocode`, `/v1/batch`, `/v1/resolve`, and `/v1/reload` return `503`. `/v1/format` is the exception.
> It is wired in-package from `@mailwoman/codex/address-format` and works without any engine method.

Errors go in one closed table. Each row carries a stable code a caller can match on, one line of meaning, and
the next step. A meaning that only restates the code's name gives the reader nothing.

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

- Every example was generated or executed rather than typed from memory.
- Request and response appear together, both complete.
- On HTTP surfaces, curl comes first, then language tabs, every tab hitting the identical endpoint.
- On library surfaces, examples are full files with their output rather than fragments.
- Placeholders use `<CAPS_PLACEHOLDER>` with an inline replace-me comment.
- Facts precede rationale, and `source-of-truth:` lists the files a reader can check against.
- The audit checklist in [`../writing-system.md`](../writing-system.md) has been run over the draft.
