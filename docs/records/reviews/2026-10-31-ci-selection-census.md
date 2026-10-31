# CI test selection census for issue #2883

The replay covers 300 first-parent commits ending at `47b2a1498`.
Both comparison arms use the current tracked file population.
The baseline calls `readCIWorkspaces` and `selectCIScope` from `2be22445d`.
The candidate uses Vitest's related-test selection and runtime-reader detection.
The import graph comes from the current checkout rather than each historical tree.

| Measurement                                            |  Baseline | Candidate |
| ------------------------------------------------------ | --------: | --------: |
| Full selections / all commits                          | 139 / 300 | 110 / 300 |
| Scoped selections / all commits                        | 161 / 300 | 190 / 300 |
| Median selected fast files, all 300 commits            |       909 |       497 |
| Median selected fast files, scoped commits in each arm |       687 |       371 |

The scoped medians describe different commit populations: 161 baseline commits and 190 candidate commits.
The all-commit medians use the same 300 commits.
The candidate also includes root tool tests that the baseline's fast configuration excluded.
These results measure selected file counts. The replay did not measure execution time or runner charges.
The baseline differs from the original issue's reported 159 full selections because this replay uses the selector at `2be22445d` and the current file population.

Tests that import filesystem, module-path, SQLite, or subprocess access retain all of their owner's transitive workspace inputs.
They remain selected when those inputs change, even when an import edge is absent.
Other tests use the Vitest import graph for source changes.
Fixture and data changes retain workspace-level selection.
This policy does not infer individual fixture paths from arbitrary runtime expressions.

`readCIWorkspaces` detects runtime access from test-file syntax each time CI selects tests.
An unreadable source file raises an error instead of producing an empty selection.
