# Release translation sweep

27 October 2026 · Leyla · Hub #6505 · review candidate

The source audit covered the HTML text, accessible names/tooltips/placeholders, and application-generated runtime labels in `public/index.html`; it did not count the coordinator’s estimate as evidence. Existing `hubPure.t` keys were reused wherever possible. Declarative `data-i18n` bindings apply text through `textContent` and attributes through `setAttribute`, including while switching languages. English fallback markup avoids Turkish text flashing before initialization. The initial UI language is English unless the browser already has a saved choice (human #6418/#6429).

Covered: settings identity/appearance/system information, mobile menu, panel resize/close labels, project/message labels, notifications and connection status, file-only messages and pending attachments, rule creator/project/category labels, usage source/window labels and locale-specific percentage placement. Existing category values and mention tokens remain stable for filtering/storage/protocols; built-in category names are translated only for display. Custom categories, project slugs, names, message text and rule text stay literal. Language self-names remain native in the language picker.

The CLI schedule uses a small DOM-independent `schedule-i18n.mjs` formatter for EN/TR/JA/AR/ZH. `--lang` takes precedence over `HUB_LANG`, then English. It covers default/updated/unavailable schedule states and the advisory note, without a timer/configuration mutation. Browser settings retain their existing `hubPure.t` schedule keys. No HTML evaluation or browser runtime is loaded by the CLI.

Remaining Turkish source tokens outside dictionaries are intentional identifiers: the operator-name CSS selectors; stable rule category values and default storage value; legacy quota source/window labels matched for display translation; the Turkish language self-name. Developer comments and actual user content are not translated. There are no new dependencies or live service/configuration changes.

Validation: `node --test test/*.test.mjs` — 81 passed, 0 failed/skipped. Tests cover translation-key and interpolation parity, English/Turkish percentage ordering, CLI language precedence and unsupported language, all five CLI schedule states, and real Chromium language switching for settings/mobile menu/accessibility/RTL with no mobile horizontal overflow. Existing approval, pairing, authorization, CLI and API regressions passed. Browser checks use temporary profiles and mock/test servers; the test harness closes its browser processes. Release screenshots are owned by Marslı and should be refreshed after the reviewed merge.

## Matrix theme follow-up

28 October 2026 · Leyla · Hub #6662

The theme action is state-dependent: Matrix offers “Modern” and Modern offers “Matrix”, including after language changes and a reload with Matrix saved. Its visible text is no longer a static translation binding; the translation pass updates text and tooltip from the active theme together. Toolbar controls retain the normal UI font and sizes in both themes, and the theme button reserves enough width for either action. Matrix colors, borders and monospace chat styling remain.

Validation: 84 tests passed, none failed or skipped. The Chromium regression checks both directions and language changes in all five languages at 1500, 1150, 375 and 320 pixels; visible toolbar control positions and sizes differ by at most one pixel, with no horizontal page overflow. It also reloads a persisted Matrix preference. The same regression fails on the original page because the visible action incorrectly stays “Matrix”. These are temporary-profile browser checks, not a physical-phone acceptance.
