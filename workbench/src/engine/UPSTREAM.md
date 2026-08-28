# Upstream source

The image comparison and spatial grouping heuristics in this directory were
adapted under direct authorization that the user reports obtaining from the
upstream author. The reported authorization covers copying, modification, and
redistribution of the code from:

- Repository: `https://github.com/SemineChen/yangao`
- Fixed commit: `beac836ba3c81b9a1d40bac8fe75af08444ab742`
- Original implementation: `assets/app/index.html`

The fixed upstream commit did not contain a public license. This record does
not represent the upstream project as publicly licensed, does not infer any
broader grant or sublicensing terms, and is not independent verification of
the reported authorization. See
[`THIRD_PARTY_NOTICES.md`](../../skill-package/THIRD_PARTY_NOTICES.md) for the
corresponding distribution notice.

Only the comparison profile, pixel-difference analysis, issue classification,
and spatial grouping logic were ported. The upstream interface, drawing code,
export functions, and duplicate presentation helpers were not copied into the
engine.

The pure local entry point is `yangaoEngine.js`, which exports `analyzeImages`.
The application entry point is `yangaoWorkerClient.js`, which decodes image
files, transfers the resulting `ImageBitmap` objects to `yangao.worker.js`, and
exports `analyzeImagesInWorker`.

The following reliability controls are workbench-specific additions rather
than upstream behavior: max-width-only normalization, the input-comparability
gate in `comparability.js`, alpha-aware missing-region handling, conservative
role/classification thresholds, neutral localized-content labels, and the
human-review policy that suppresses findings for low-comparability inputs.
