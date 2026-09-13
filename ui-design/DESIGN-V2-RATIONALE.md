# oneTeam — UI v2 Design Rationale

**Companion to:** `DESIGN.md` v1.1 (the token contract) · `ui-audit/` (the evidence base)
**Deliverable:** `oneTeam-Redesign-Prototype.html` — clickable, self-contained, no build step
**Scope:** Supervisor web portal (`web/`) first, iOS field client (`mobile/`) second
**Approach chosen:** *evolve the current system*, not replace it

---

## 1. What "aligns with user habits" means here

oneTeam is not a consumer app. Its users are FMCG supervisors and field merchandisers who
open it many times a day, often standing up, often in a store aisle. That produces four
hard constraints which drive every decision below:

| User reality | Design consequence |
|---|---|
| Used repeatedly all day, not explored | **Recognition over recall.** Nothing moves between sessions. No onboarding, no entrance animation. |
| The job is *triage*, not browsing | The pending queue is the loudest thing on the dashboard, and it is one tap from action. |
| Read in bright store light, on cheap phones | Status is **never colour-only** — colour + dot + text label, always. Minimum readable type 11px. |
| Long Azerbaijani compounds | Labels truncate or wrap deliberately; nothing relies on a fixed-width box. |

The existing v1 system already encodes the first three as *intent* in `DESIGN.md` §2. The
audit showed several of them were not actually implemented. v2 closes that gap rather than
introducing a new visual language users would have to relearn.

---

## 2. The eight changes

### 2.1 The responsive shell — the single highest-impact fix

**Problem (measured).** At 390px the `w-64` sidebar does not collapse. It consumed 256px
of a 390px viewport — **66% of the screen** — leaving 134px for content. The header inflated
from 45px to 165px as the title and action button wrapped. The app root carries
`overflow-hidden`, so the clipped content could not even be scrolled to.
Evidence: `ui-audit/shots/11-mobile-390-dashboard.png`, `12-mobile-320-dashboard.png`.

**Solution — three tiers, one shell.**

| Width | Behaviour |
|---|---|
| ≥ 1280px | Full 260px sidebar with labels |
| 768–1279px | 74px icon-only rail, labels hidden, **hover tooltips** restore the label |
| < 768px | Off-canvas drawer: hidden by default, hamburger in the header, `rgba(2,6,23,.5)` scrim, Escape closes |

**Why the rail instead of jumping straight to a drawer at tablet size.** A 1024px iPad in a
store back-office has room for 74px of navigation and the icon-only rail keeps the nav
*visible* — which matters for the recognition-over-recall rule. A drawer would hide
navigation behind a tap on a device with space to spare.

**Verified.** Sidebar offset `-262px` (fully off-canvas) when closed, header locked at 68px
in all three modes, zero horizontal overflow.

### 2.2 Content reflows with the shell, not with the browser

A subtle trap the first build hit: collapsing the *shell* is not enough. Because the
prototype renders a 430px-wide app inside a 1600px browser window, `@media` rules never
fired and the KPI grid stayed 4-up and cramped inside the narrow frame.

v2 therefore drives layout from **container state**, not viewport width. In production these
become ordinary `md:` / `lg:` breakpoints; the prototype just makes the relationship visible.

### 2.3 The submissions table becomes a card list below `md`

An 8-column table is not scannable on a phone. Rather than duplicate markup, the same `<tr>`
is re-laid out as a card with CSS grid:

```
┌──────────────────────────────────────────┐
│ [photo]  Title…………………              (95)  │   row 1
│ ──────────────────────────────────────── │
│ Bravo Supermarket — 28 Mall              │   row 2
│ BRAVO_28MAY_01                           │
│ (EM) Eldar Mammadov            09-12     │   row 3
│                                19:32     │
│ ● Təsdiqləndi              [Müqayisə]    │   row 4
└──────────────────────────────────────────┘
```

One data source, two presentations. The desktop table also gained `table-layout: fixed` with
per-column widths so all eight columns fit without horizontal scroll — text truncates rather
than pushing the table wide.

**Density trade-off.** In the desktop table the submitter collapses to an **avatar only**;
the full name, role and telemetry are one click away in the comparison modal. Mobile cards
show the full name, because there the card is tall and narrow and there is room. This buys
~80px for the planogram title, which is the column a supervisor actually scans.

### 2.4 Elevation — a layer that did not exist

`DESIGN.md` §7 specifies `shadow-subtle` for all content cards. It was **never defined in
`tailwind.config.js`** — 8 occurrences across 4 files silently rendered nothing. Every card
was flat, and the universal "this is interactive" hover signal was dead.

v2 defines three real levels and uses them consistently:

```js
boxShadow: {
  card:  '0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06)',
  hover: '0 4px 12px -2px rgba(15,23,42,.10), 0 2px 6px -2px rgba(15,23,42,.06)',
  pop:   '0 24px 60px -20px rgba(15,23,42,.30), 0 8px 20px -8px rgba(15,23,42,.12)',
}
```

Rule preserved from §7: **cards that are not clickable must not gain a hover shadow.**

### 2.5 A fixed 68px header

`h-18` is not a valid Tailwind v3 class, so the header height was content-driven and changed
per tab (measured 45px on desktop, 165px on mobile). v2 locks it to 68px, truncates the title
to one line, hides the subtitle below `md`, and collapses the primary action to icon-only.
Vertical rhythm no longer jumps when switching tabs.

### 2.6 Numbers align

KPI values, scores and time cells now use `tabular-nums`. Proportional figures made columns
jitter as values changed — a real cost when the whole job is comparing numbers down a column.

### 2.7 Status is redundant by design

v1 badges were pastel background + text. In bright store light, and for the ~8% of men with
red-green colour-vision deficiency, that is not enough — especially because
`approved`/`medium`/`low` share the emerald and amber families (§11 of `DESIGN.md`).

Every status now carries **colour + a solid dot + a text label**, so removing colour still
leaves two independent cues. This is the one place v2 is deliberately more verbose.

### 2.8 States that were never defined

`DESIGN.md` §14 items #11 and #12: no empty state, no error state, no loading skeleton.
Empty tables and failed Supabase loads rendered as blank regions — indistinguishable from
"still loading" and from "broken".

v2 adds three patterns, all in the prototype:

- **Empty** — icon tile, one-line explanation, one action. ("Hələ heç bir rəf fotosu yoxdur")
- **Loading** — skeletons matching the KPI and card geometry exactly, so nothing shifts on load.
- **Image fallback** — broken images previously leaked raw `alt` text ("Rəf Şəkl") into the
  table. Now a brand-toned gradient tile with a camera glyph.

### 2.9 Keyboard focus

`DESIGN.md` §13 requires a visible focus ring; the audit found none app-wide. A global
`:focus-visible { outline: 2px solid #F40009; outline-offset: 2px }` fixes it. Try pressing
Tab in the prototype.

---

## 3. Deliberately unchanged

Restraint is part of the design. These were **kept**, and changing them would cost users
more than it gains:

- **Coca-Cola red as accent only.** Never a large surface. `coke-500` stays reserved for one
  primary action per view plus the active nav item.
- **Azerbaijani-first copy**, formal-imperative tone, `Asia/Baku` time.
- **Emoji in status labels** (`✅ Təsdiqləndi`). `DESIGN.md` §8 defends these as a redundant
  non-colour cue; v2 keeps them and pairs them with the dot.
- **Dense information.** This is an operational tool. v2 does not add whitespace for elegance
  at the cost of density.
- **The 11px readable-type floor**, with 10px confined to non-interactive chips.
- **No decorative motion.** No entrance animations, no parallax, no scroll effects.

---

## 4. Mobile field client

Same tokens, same status language, three screens designed:

1. **Task list** — geofence status is permanently visible (the anti-fraud rule is the single
   most important thing on this screen), planogram specs as scannable facts (`3 facing`,
   `≤ 4°C`, deadline), one large primary CTA per task.
2. **Smart camera** — ghost planogram overlay, live telemetry stamps (GPS ± accuracy, store
   code + distance, timestamp + device), shutter sized for gloved hands.
3. **Offline queue** — explicit "will send automatically when network returns" reassurance,
   per-item sync state, completed items marked with the same `✅` language as the portal.

Targets are ≥ 44px throughout, above the 40px floor, because field use is one-handed.

---

## 5. Token changes to adopt

Merge into `tailwind.config.js` (root, re-exported from `web/`) — this closes `DESIGN.md`
§14 items #1–#4 and #7:

```js
boxShadow: {
  xs:     '0 1px 2px 0 rgb(0 0 0 / 0.05)',            // §14 #2 — was a v4 utility on v3
  subtle: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',  // §14 #1
  card:   '0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06)',
  hover:  '0 4px 12px -2px rgba(15,23,42,.10), 0 2px 6px -2px rgba(15,23,42,.06)',
  pop:    '0 24px 60px -20px rgba(15,23,42,.30), 0 8px 20px -8px rgba(15,23,42,.12)',
},
spacing: { 18: '4.5rem' },                              // §14 #4 — h-18
```

Also required, and still open from the v1 audit:

- Replace `backdrop-blur-xs` (v4) with `backdrop-blur-sm` — 7 occurrences (§14 #3)
- Remove `bg-zinc-50 text-zinc-900` from `web/index.html` — `slate` is canonical (§14 #5)
- Drop the duplicated font-family Tailwind class; keep the `index.css` declaration (§14 #6)
- Extract `StatusBadge` / `PriorityBadge` / `ScenarioChip` / `KpiCard` into
  `web/src/components/ui/` — 14+ inline re-typings of the same badge today (§14 #8)

---

## 6. Verification

The prototype was rendered headless and measured, not eyeballed:

| Check | Result |
|---|---|
| Console errors / page exceptions | **0** |
| Header height, all three modes | **68px** constant |
| Sidebar, desktop / tablet / mobile | **260px / 74px / off-canvas (−262px)** |
| Mobile table layout | `display: grid` (card mode), `thead` hidden |
| Horizontal overflow at 390px | **none** |

Reproduce with `node ui-design/verify.mjs` (requires Chrome on CDP port 9223; see the header
comment in the file). Screenshots land in `ui-design/verify-shots/`.

---

## 7. Suggested next steps

1. Adopt the `tailwind.config.js` block above — it alone fixes the flat-card problem
   everywhere at once, with no component edits.
2. Implement the responsive shell in `Sidebar.tsx` / `App.tsx` (`DESIGN.md` §14 #10). This is
   the highest-value single change.
3. Extract the shared `ui/` primitives (§14 #8), then the badges cannot drift again.
4. Add `EmptyState` / `Skeleton` / image-fallback (§14 #11, #12) and apply them to every list.
5. Extend `ui-audit/shoot.mjs` to cover the new tablet-rail and mobile-drawer states so the
   responsive behaviour has a visual regression baseline (`DESIGN.md` §16.6).
