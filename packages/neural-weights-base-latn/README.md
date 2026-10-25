# @mailwoman/neural-weights-base-latn

This workspace reserves a shared Latin-script model package. Its release integration is deferred, and its manifest marks it private.

Do not add this package to `release.config.json` locales or depend on it from a published package until release integration and CI validation are complete.

## Current status

This is a development workspace for sharing Latin-script model artifacts between
locale packages. Its manifest sets `private: true`, and it has no root library
entry. The `./*` export exposes individual files when those files are present.

The workspace's version is independent of whether any local model files have
been materialized. Its presence in the monorepo does not establish that a model
has been evaluated or published.

## Expected artifacts

| File                              | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `model.onnx`                      | Shared model weights.                      |
| `tokenizer.model`                 | The corresponding SentencePiece tokenizer. |
| `model-card.json`                 | Model metadata.                            |
| `calibration.json`                | Confidence calibration.                    |
| `calibration-per-locale.json`     | Locale-specific confidence calibration.    |
| `anchor-lexicon-v1.json`          | Geographic anchor vocabulary.              |
| `country-surface-lexicon-v1.json` | Country-name vocabulary.                   |

The manifest lists these files as intended package contents. They may be absent
in a checkout. This README does not imply that they were generated or verified.

## Materialize development files

The development linker uses the same model and tokenizer source as the
`neural-weights-en-us` workspace. It also attempts to link shared metadata from
that workspace and lexicons from the shared artifact sources.

After making the intended local model artifacts available, run from the
repository root:

```bash
node packages/neural-weights-base-latn/scripts/link-dev-weights.ts
```

`MAILWOMAN_DEV_MODEL` and `MAILWOMAN_DEV_TOKENIZER` override the model and
tokenizer sources. The command changes local artifact links. The linker warns
when optional metadata is absent and can leave calibration or metadata unavailable.

See [the linker](scripts/link-dev-weights.ts) for the exact inputs.
These development files do not constitute a release.

## Release prerequisites

The manifest requires release integration and CI validation before a published
package can depend on this workspace. Model evaluation and publication must
follow [the model contribution procedure](../../docs/engineering/CONTRIBUTING_MODEL_WORK.mdx)
and [the release procedure](../../RELEASING.md).

The existing [US English weights package](../neural-weights-en-us) remains the
reference for the development linker's shared model inputs.

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`.
