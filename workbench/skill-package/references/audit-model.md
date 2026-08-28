# UI audit decision model

Use this model when converting visual-difference candidates into an issue list.

## Separate the fields

Do not collapse these concepts into one score:

- **Evidence level**: measured, visually observed, or contextual.
- **Confidence**: how likely the candidate is a real mismatch after alignment checks.
- **Severity**: the consequence for readability, comprehension, interaction, accessibility, or brand consistency.
- **Priority**: when the team should act, considering severity, reach, release risk, dependencies, and fix cost.
- **Review status**: pending, confirmed, ignored, or dismissed.

A large pixel delta can be low priority, while a subtle focus-state or contrast mismatch can be high severity.

## Candidate review

Before reading candidates, check the input-comparability result:

- **Low**: stop. The workbench intentionally returns an empty issue list because widely distributed visual or structural changes make local defect labels unreliable. Fix the route, state, content, viewport, or capture range and rerun.
- **Medium**: continue only as an assisted review. Localized media, dynamic content, or unmatched height may explain a meaningful share of the differences.
- **High**: the raster evidence is suitable for local comparison, but this still does not prove product intent or make candidates confirmed defects.

The score behind this gate is an uncalibrated heuristic, not a probability. Never use it as severity, priority, or proof that one source is correct.

Before confirming a candidate, check:

1. The design and implementation show the same route, UI state, content, locale, and data.
2. Viewport size, device-pixel ratio, browser zoom, and scroll position are compatible.
3. Fonts and images have finished loading.
4. The difference is not caused only by anti-aliasing, subpixel rendering, animation timing, dynamic content, or a deliberate responsive rule.
5. The intended design is current and authoritative.

Classification must stay within the evidence. A one-sided transparent region means that one source has visible content where the other does not; it does not prove color, typography, icon, border, or size defects. A localized photo or media-content change may be reported neutrally as content difference, but the raster engine cannot infer why the content differs.

Candidate boxes and location values use the normalized comparison canvas, not necessarily either source file's original pixel coordinates. Use the displayed target width and scale factors when translating a reviewed location back to an original asset.

## Suggested priority rubric

- **P0**: blocks a critical task or creates a severe accessibility/compliance failure; release should stop.
- **P1**: materially harms a primary flow, comprehension, or interaction for many users; fix before release.
- **P2**: clear fidelity defect with limited functional impact; schedule in the current iteration when practical.
- **P3**: minor polish or low-reach inconsistency; batch with related cleanup.

Priority is a delivery decision, not a synonym for severity.

## Status rules

- **Pending**: not yet reviewed by a person.
- **Confirmed**: verified against the intended design and relevant runtime state.
- **Ignored**: real difference that the team intentionally accepts; require a reason.
- **Dismissed**: false positive, stale design, invalid comparison, or duplicate; require a reason.

Mark a result stale and block normal export when either source, viewport, page state, or comparison settings change after review.

## Export contract

Default exports contain confirmed items only. Each exported item should include:

- Stable issue identifier
- Page and state
- Location or component
- Concise problem statement
- Priority and severity
- Evidence type and quantitative delta when available
- Design and implementation references
- Reviewer status and notes

Include pending, ignored, or dismissed candidates only if the user asks for a full audit trail. Preserve reasons for ignored and dismissed items.
