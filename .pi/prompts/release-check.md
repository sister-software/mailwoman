---
description: Run the release pre-flight checklist — workspace sync, weights, gate, changelog
argument-hint: "[version]"
---
Run the Mailwoman release pre-flight for ${1:-the pending version}. Use the checklist below.

## 1. Dependency closure audit

Verify `.release-it.json` workspaces list matches the runtime closure:

```bash
cat .release-it.json | jq '.plugins."@release-it-plugins/workspaces".workspaces'
```

If `mailwoman` gained a new `@mailwoman/*` runtime dependency, add that workspace dir to the array.

## 2. Weights artifact check

```bash
cat release.config.json | jq '.weights'
```

Confirm the paths point to real binaries. If running locally without `/mnt/playpen/`, set:

```bash
export MAILWOMAN_PUBLISH_MODEL=/path/to/model.onnx
export MAILWOMAN_PUBLISH_TOKENIZER=/path/to/tokenizer.model
```

Confirm the tokenizer version matches the model card's `training.tokenizer_version`.

## 3. Parity gate (if model version is changing)

```bash
ls docs/articles/evals/parity-scorecard-*.md | tail -1 | xargs cat | head -60
```

Every floored tag must clear its bar. Regressions must be characterized in the gate doc with a root cause. Unfloored regressions must carry a documented reason (e.g., FR region).

## 4. Changelog / release notes

```bash
git log --pretty=format:'* %s (%h)' $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~10)...HEAD --no-merges
```

Scrub for: breaking changes that need migration notes; new workspace dirs that need first-publish bootstrapping (see RELEASING.md § "Adding a NEW package").

## 5. Dry run

```bash
yarn release --dry-run
```

If the dry run passes, the CI workflow at `.github/workflows/publish.yml` can publish code-only from OIDC. Model artifacts go to Hugging Face first (`scripts/publish-release-to-hf.mjs`).

## 6. Demo assets (if model is changing)

Stage the same artifact set to R2 via `scripts/publish-demo-assets-to-r2.py`. A release is done when both HF and R2 backends agree on `releases.json`.
