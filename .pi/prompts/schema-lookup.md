---
description: Look up a ComponentTag definition from the canonical schema and trace its usage
argument-hint: "<tag-name>"
---

Look up the Mailwoman ComponentTag `$1` in the canonical schema and trace its usage across the codebase.

## 1. Schema definition

```bash
cat docs/articles/plan/reference/SCHEMA.mdx
```

Find the tag `$1` and report: phase, description, locale scope (universal vs. locale-specific), example.

## 2. BIO label derivation

Every tag `T` yields two BIO labels: `B-T` and `I-T`. Confirm these are used in labeling code.

## 3. Usage in classifiers

```bash
rg -n "$1" classifiers/ --type-add 'src:*.ts' -t src | head -20
```

## 4. Usage in core

```bash
rg -n "$1" core/ --type-add 'src:*.ts' -t src | head -20
```

## 5. Usage in corpus / eval labels

```bash
rg -n "B-$1|I-$1" corpus/ --type-add 'src:*.ts' -t src | head -20
```

## 6. Usage in neural decoder

```bash
rg -n "$1" neural/ --type-add 'src:*.ts' -t src | head -20
```

## 7. Gate floor (if any)

```bash
rg -n "$1" gates/ 2>/dev/null || echo "No gate config references $1"
```

## 8. Recent scorecard performance

```bash
rg -n "$1" docs/articles/evals/competitive-parity/parity-scorecard-*.md | tail -5
```

Report the most recent measured F1 for this tag.
