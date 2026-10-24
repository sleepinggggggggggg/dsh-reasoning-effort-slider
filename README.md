# dsh-reasoning-effort-slider

English | [中文](README.zh.md)

Turns the **Effort row** of DeepSeek Harness's model menu into a **Codex-style reasoning-effort slider**:

```
┌────────────────────────────────────────┐
│ Model       DeepSeek-V4.1-Flash 1017 › │
├────────────────────────────────────────┤
│ Effort                        Max    › │   ← native row; its value text is tinted by level
│ ●━━━━━━━━━━━━━━━━━━━━━━━━━◯           │   ← injected: 28px track + white knob
│ ·           ·           ·          ·   │   ← level ticks (reached ones brighten)
│                   Max                  │   ← current level name (live while dragging)
└────────────────────────────────────────┘
```

Nothing is added to the composer tool row. The collapsed model seat keeps the native
`model · effort ⌄` typography; only that effort text is tinted.

## Interaction

| Action | Behaviour |
| --- | --- |
| Press on the track | Jumps to the pressed cell |
| Drag | The knob **follows the pointer**: knob and fill track the cursor, while the level name, ticks and writes use the nearest level; on release it snaps onto the cell in 80 ms, without bounce |
| Release | Commits immediately (resting the pointer for ~160 ms also commits) |
| `←` `→` `↑` `↓` | One level per press, committed immediately |
| `Home` / `End` | Lowest / highest level |
| Hover | Tooltip with the current level and “further right costs more tokens” |

Writes are deduplicated and coalesced: a drag commits at most a few times, and picking the level
already in effect writes **nothing**. A failure shows its reason under the track and clears after 4 s.

## Colour and effects (driven by level position, independent of level count)

| Position | Fill right end | Starfield | Level text |
| --- | --- | --- | --- |
| First level | blue `#4d93f8` | none | native (an `Off` level is never tinted) |
| Middle | blue → violet `#9333ea` | none | blue → indigo |
| Highest | deep violet `#4c1d95` | 26 staggered stars + violet nova layer | violet `#8b5cf6` |

- The fill is `linear-gradient(90deg, blue → colour at the current position)`: always blue on the
  left, deepening to the right.
- The nova layer and the starfield are **clipped to the filled part**, so nothing glows to the
  right of the knob.
- The knob is a white circle as tall as the track (28 px) whose centre is inset by 14 px, so it
  stays a full circle at both ends.

## Why it cannot break the native menu

- It only adds a `data-dres-row` attribute to the native effort row (taller, wrapping). Native
  classes, copy and chevron are untouched.
- Anything unexpected is **fail-open**: no `aria-controls` on the trigger, a menu that is not the
  model/effort pair, or a row outside this composer card means “do not inject” — the native menu
  keeps working.
- Growing that row triggers the menu's own `ResizeObserver`, which re-measures and clamps the panel
  back on screen.
- On close or unload the container is removed, the attribute dropped, and every tinted text colour
  restored.

## Data path (native public surface only)

| Purpose | API |
| --- | --- |
| Read levels | `session.modelCatalog()` → `groups[].models[].reasoning.efforts` |
| Read current value | the `modelSelection` session projection (`useProjection`), falling back to the catalog default |
| Write level | `session.selectModel({ sessionId, provider, model, reasoningEffort })` — the same entry the native menu uses |

## Install

From GitHub:

```
dsh plugin --profile <profile> add github:sleepinggggggggggg/dsh-reasoning-effort-slider
```

From a local directory:

```
dsh plugin --profile <profile> add <absolute path to this directory>
```

On desktop, use **Settings → Plugins → Add plugin** with the same value, then reload the page (or
restart the app).

## Compatibility

The supported host range is declared in `package.json` as `engines.dsh`:
**DSH `>=0.2.0-rc.2 <0.3.0-0`**, verified against `0.2.1-rc.2`.

DSH checks that range before loading a plugin. A host release outside it is refused with an
explicit incompatibility message instead of leaving a slider that silently never appears.

## Known limits

- **Depends on the native menu's semantic structure** (`aria-haspopup` / `aria-expanded` /
  `aria-controls`, two root rows with `role="menuitem"`). If a host release changes it, the plugin
  silently does nothing — it never breaks the menu — and needs a follow-up.
- The model menu has to be open to change the level; nothing is shown in the composer tool row.
- A model that advertises a single level (for example with thinking disabled) renders no control,
  and the native row keeps its original height (`setActive` drops the growth).
- The model catalog is cached for the page lifetime (a reconnect refetches it). Providers or models
  added in Settings need one page reload.
- The selection applies to the **next request**; a running step keeps the level it started with
  (same as the native menu).

## Acknowledgements

The design decisions come from reading three sibling implementations. No code was copied; this
repository is an independent implementation.

- [HanaAyane/dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort) — the white
  knob + track + ticks + level-name visual language, and the `modelSelection` projection +
  `session.selectModel` data path.
- [Microqian2th/dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider) —
  the DOM anchor strategy for injecting into the native Effort row (`aria-haspopup` /
  `aria-expanded` / `aria-controls` / `role="menuitem"`), plus the blue → violet → deep violet
  palette and the starfield position curve.
- [Bai-2008/a-better-dsh-codex-effort-slider](https://github.com/Bai-2008/a-better-dsh-codex-effort-slider)
  — the trade-offs of taking over the model seat entirely, a route this plugin does not take.

## Feedback

- **Bugs and feature requests** — [open an issue](https://github.com/sleepinggggggggggg/dsh-reasoning-effort-slider/issues). The template asks for the
  plugin and DSH versions; that pair is usually the whole diagnosis.
- **Setup help, custom model profiles, "does this work with X"** — email
  **nupotecrosstvo@gmail.com**.
- **Security** — email the same address instead of opening a public issue; see
  [SECURITY.md](SECURITY.md).

## Licence

MIT — see [LICENSE](LICENSE).

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Host half: empty `apply()`, only there so the bundle enters the profile |
| `client.js` | Everything: DOM bridge, portaled slider, colour/starfield logic, dictionaries |
| `cordis.patch.yml` | Inserts the bundle row |
| `locale/{zh,en}.json` | Plugin-manager copy and control strings |
| `icon.svg` | Icon shown in the plugin manager |
