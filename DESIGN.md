# oneTeam — Design System

**Product:** oneTeam Retail Shelf Monitoring Platform (FMCG / Coca-Cola distribution)
**Scope:** Supervisor & Admin Web Portal (`web/`), Telegram Bot surfaces (`src/bot/`), iOS Field Client (`mobile/`)
**Status:** Living document — describes the system **as implemented today**, plus the gaps that need closing
**Version:** 1.1 · Last reviewed: 2026-09-12

> **How to read this document.** Every component spec is tagged:
> - **✅ Shipped** — matches the code as it exists today. Verify before changing.
> - **🎯 Target** — agreed design intent that is **not yet built**. Do not assume it works.
>
> v1.1 corrected 7 spec↔code mismatches, resolved 2 internal contradictions, and flagged an
> implementation trap in §15. See §17 for the change log.

---

## 1. Purpose

This document is the single source of truth for how oneTeam looks, feels, and behaves. It exists so that:

1. Any new screen or component ships visually consistent with the existing portal **without** a designer in the loop.
2. The tokens below are treated as the contract — not the 800+ ad-hoc Tailwind classes currently scattered across components.
3. Known token debt (§14) is fixed deliberately rather than silently propagated.

**Reading order for implementers:** §3 (Color) → §4 (Typography) → §5 (Layout) → §10 (Components) → §15 (Config to adopt).

---

## 2. Brand Foundation

oneTeam is a **B2B operational tool** used in stores, warehouses, and on phones in the field. The design language is therefore:

| Principle | What it means in practice |
|---|---|
| **Utility first** | Dense information, fast scanning. KPI numbers and status are the loudest things on screen. |
| **Brand-anchored, not brand-drowned** | Coca-Cola red is an *accent and action* color, never a surface color for large areas. |
| **Status is never ambiguous** | Pending / Approved / Rejected must be readable at a glance from color, icon, **and** label — never color alone. |
| **Field-grade legibility** | Readable content never drops below **11px**. Micro-type (10px / 9px / 8px) is confined to a narrow, explicitly enumerated set of non-interactive badges and photo overlays — see §4.2. Tappable targets ≥ 40px on mobile is a **🎯 target**, not yet met (§13). |
| **Azerbaijani-first** | All UI copy is Azerbaijani. Layout must survive long Azerbaijani compounds (see §12). |

### 2.1 Brand assets

| Asset | Path | Usage |
|---|---|---|
| Logo | `logo.jpg` (repo root) → served as `/logo.jpg` | Sidebar brand block, favicon |
| Favicon | `<link rel="icon" type="image/jpeg" href="/logo.jpg">` | `web/index.html` |
| Partner mark | `Coca-Cola` text chip | Sidebar brand block, next to wordmark |

The logo sits inside a 40×40 rounded container with a red (`coke-500`) background. If the image fails to load, the container degrades to a solid red tile via `onError` — keep this fallback.

---

## 3. Color System

### 3.1 Brand — Coca-Cola Red

The brand ramp is defined in `tailwind.config.js` as the `coke` scale, with two semantic aliases.

| Token | Hex | Role |
|---|---|---|
| `brand.red` | `#F40009` | Canonical Coca-Cola red. Alias of `coke-500`. |
| `brand.dark` | `#111827` | Brand ink. Alias of Tailwind `gray-900`. |
| `coke-50` | `#fff1f1` | Tinted backgrounds (selected cards) |
| `coke-100` | `#ffdfdf` | Tinted chips |
| `coke-200` | `#ffc5c5` | Tinted borders |
| `coke-300` | `#ff9d9d` | Decorative |
| `coke-400` | `#ff6464` | Text on dark surfaces (badge text in sidebar) |
| **`coke-500`** | **`#F40009`** | **Primary action, active nav, brand marks** |
| `coke-600` | `#D80008` | Hover state for primary actions |
| `coke-700` | `#B50007` | Active/pressed |
| `coke-800` | `#940006` | Dark accents |
| `coke-900` | `#7A0005` | Darkest |

**Rules**
- `coke-500` is reserved for **one primary action per view** plus the active navigation item. Do not use it for decorative borders or large fills.
- Never place body text directly on `coke-500`; use `white` at `font-bold` or heavier.
- Hover always steps to `coke-600`; active/pressed steps to `coke-700` (or `active:scale-95`).

### 3.2 Neutrals

The neutral ramp is **Tailwind `slate`**, not a custom scale.

| Token | Hex | Role |
|---|---|---|
| Canvas | `#f8fafc` (`slate-50`) | App background (set in `web/src/index.css`) |
| Surface | `#ffffff` | Cards, header, modals |
| Border (default) | `slate-200` `#e2e8f0` | Card and divider borders |
| Border (subtle) | `slate-100` `#f1f5f9` | Inner dividers |
| Border (strong) | `slate-300` `#cbd5e1` | Input borders |
| Text (primary) | `#0f172a` (`slate-900`) | Headings, KPI values |
| Text (secondary) | `slate-700` `#334155` | Body |
| Text (muted) | `slate-500` `#64748b` | Subtitles, metadata |
| Text (disabled) | `slate-400` `#94a3b8` | Labels on dark, placeholders |
| Sidebar surface | `slate-900` `#0f172a` | Navigation rail |
| Sidebar border | `slate-800` `#1e293b` | Rail dividers |
| Sidebar footer | `slate-950/60` | Account block |

> **Conflict to resolve.** `web/index.html` sets `<body class="bg-zinc-50 text-zinc-900">` while `web/src/index.css` sets `background-color:#f8fafc; color:#0f172a`. These are *different* palettes (`zinc` vs `slate`) and `index.css` wins. **Decision: `slate` is canonical.** Remove the `zinc-*` classes from `index.html` (§14).

### 3.3 Semantic status colors

Three status families, each with a **soft** (light surface) and **solid** (overlay) form.

| Semantic | Family | Soft surface | Soft text | Soft border | Solid (on image/overlay) |
|---|---|---|---|---|---|
| **Approved / Success / Low priority** | `emerald` | `bg-emerald-50` · `bg-emerald-100` | `text-emerald-700` · `text-emerald-800` | `border-emerald-200` · `border-emerald-300` | `bg-emerald-600/90` |
| **Pending / Warning / Medium priority** | `amber` | `bg-amber-50` · `bg-amber-100` | `text-amber-700` · `text-amber-800` | `border-amber-200` · `border-amber-300` | `bg-amber-500/90` |
| **Rejected / Danger / Urgent** | `rose` | `bg-rose-50` · `bg-rose-100` | `text-rose-700` · `text-rose-800` | `border-rose-200` · `border-rose-300` | `bg-rose-600/90` |
| **Evidence marker (Before & After)** | `indigo` | `bg-indigo-50` · `bg-indigo-100` | `text-indigo-700` · `text-indigo-800` | `border-indigo-200` | `bg-indigo-600/90` |

> **Correction (v1.1).** `indigo` was previously documented as the "AI" family. That was wrong — in the
> shipped code `indigo` appears in **three** places, all of them the Before & After evidence marker
> (`TaskManager.tsx` L261, L445; `AuditReviewCenter.tsx` L243). The AI auto-approve action is **`coke-500`
> (brand red)**, not indigo. See §10.15.

**Choice of `-50` vs `-100`:** use `-50` surfaces for **table rows and cards** (calmer at density); use `-100` surfaces for **badges, chips, and modal headers** (needs to pop). Both are already in use — this is the rule that reconciles them.

### 3.4 Accent / category colors

| Family | Usage |
|---|---|
| `blue` | "Stores" KPI, checklist item surfaces (`border-blue-100`) |
| `indigo` | Before & After evidence markers only — never AI (§3.3, §10.15) |
| `orange` | High priority, gradient banner terminus |
| `coke` | "Active Tasks" KPI, primary actions |

### 3.5 Gradients

Exactly **one** gradient is sanctioned — the pending-work alert banner:

```
bg-gradient-to-r from-amber-500 to-orange-500
```

with `text-white`, `rounded-xl`, `p-4`, `shadow-sm`. Do not introduce new gradients without adding them here first.

### 3.6 Category accent map (KPI cards)

| KPI | Icon color | Surface | Border |
|---|---|---|---|
| Tərəfdaş Mağazalar | `text-blue-600` | `bg-blue-50` | `border-blue-100` |
| Aktiv Planogramlar | `text-coke-500` | `bg-red-50` | `border-red-100` |
| Yoxlama Gözləyən | `text-amber-600` | `bg-amber-50` | `border-amber-100` |
| Planogram Uyğunluğu | `text-emerald-600` | `bg-emerald-50` | `border-emerald-100` |

A KPI card in an **attention state** (e.g. pending reviews > 0) adds `border-amber-300 ring-2 ring-amber-400/20`.

---

## 4. Typography

### 4.1 Typeface

**Plus Jakarta Sans** (Google Fonts, weights 300–800), loaded via `<link>` in `web/index.html`.

```css
font-family: 'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont,
             'Segoe UI', Roboto, sans-serif;
```

- Applied globally in `web/src/index.css` (`html, body`) **and** duplicated as a Tailwind arbitrary class on `<body>`. Prefer the CSS declaration; drop the duplicated class.
- `-webkit-font-smoothing: antialiased` is set globally — keep it, it matters for the dense small type.
- **Monospace** (`font-mono`) is reserved for the live Baku clock and any numeric telemetry (GPS coords, timestamps in code-like contexts).

### 4.2 Scale

| Role | Class | Size / Weight | Usage |
|---|---|---|---|
| Display metric | `text-2xl font-extrabold tracking-tight` | 24px / 800 | KPI values |
| Page title | `text-lg font-bold tracking-tight` | 18px / 700 | Header H2 |
| Section title | `text-sm font-bold` | 14px / 700 | Card headers |
| Body | `text-xs` | 12px / 400–500 | Table cells, descriptions |
| Label / eyebrow | `text-xs font-bold uppercase tracking-wider` | 12px / 700 | KPI labels, nav group headers |
| Metadata | `text-[11px]` | 11px | Subtitles, timestamps, helper text |
| Micro badge | `text-[10px] font-extrabold` | 10px / 800 | Status chips, scenario tags, nav badges |
| Nano badge | `text-[9px]` / `text-[8px]` | 9–8px | Overlay stamps only |

**Weight discipline:** 400 body · 500 medium · 600 semibold (buttons) · 700 bold (titles) · 800 extrabold (metrics + micro badges).

**Legibility floor — resolved in v1.1.** v1.0 contradicted itself: §2 said "no thin fonts below 11px in meaningful content", while §4.2 sanctioned `text-[10px]` for badges and `text-[9px]` for overlays. The resolved rule:

| Tier | Size | Permitted for |
|---|---|---|
| **Readable content** | **≥ 11px** | Body copy, table cells, buttons, form labels, status and priority labels, helper text — anything the user must read in order to act |
| **Micro badge** | `text-[10px]` | Non-interactive chips **only** — status, scenario, priority and count badges — where the chip's own label carries the full meaning and no interaction depends on it |
| **Overlay stamp** | `text-[9px]` / `text-[8px]` | Photo-stamped telemetry and AI bounding-box labels drawn on top of an image |

**Never** place an interactive label (button, tab, filter chip, link) below 11px.

> ⚠️ **Current state — not yet compliant.** 70 occurrences of 9–11px type exist in `web/src`. The §10.4
> status badges and §10.6 scenario chips fall inside the micro-badge tier and are acceptable. Every other
> 9–10px usage must be audited against the table above; any that carries actionable text is a defect.
> Tracked as gap #13 in §14.

### 4.3 Azerbaijani copy considerations

Azerbaijani compounds are long and often capitalised — `"Planogram Uyğunluğu"`, `"Yoxlama Gözləyən"`. Therefore:

- Always pair `uppercase` labels with `tracking-wider` or `tracking-wide`.
- Never rely on fixed-width containers for labels; use `truncate` + `min-w-0` (as the sidebar already does) or allow wrapping.
- Avoid `text-center` on multi-line Azerbaijani labels — ragged edges read poorly; prefer `text-left`.
- Dates use `az-AZ` locale; time is pinned to `Asia/Baku` (§12).

---

## 5. Layout, Spacing & Grid

### 5.1 App shell

```
┌────────────┬──────────────────────────────────────────────┐
│            │  Header  (bg-white, border-b slate-200/80)   │
│  Sidebar   ├──────────────────────────────────────────────┤
│  w-64      │  main  · overflow-y-auto · p-6 sm:p-8        │
│  slate-900 │    └── div.max-w-7xl.mx-auto                 │
│            │         (active tab content)                 │
│  [footer]  │                                              │
└────────────┴──────────────────────────────────────────────┘
```

- Root container: `flex` full-height, sidebar is `flex-shrink-0`, content column is `flex-1 min-w-0 overflow-hidden`.
- **Sidebar width: `w-64` (256px)**, fixed. **✅ Shipped** (and the source of the §5.4 responsive gap).
- **Content max-width: `max-w-7xl` (1280px)**, centred. **✅ Shipped**
- **Content padding: `p-6` → `sm:p-8`** (24px → 32px). **✅ Shipped**
- Header horizontal padding: `px-8`. **✅ Shipped**
- Header height: **🎯 Target 72px (`h-18`)** — **not applied**, because `h-18` is not a valid Tailwind v3 class (§14 #4). Measured live height is **45px** and it is content-driven, so it changes per tab. On a 390px viewport it inflates to **165px** as the title and action button wrap (§5.4).

### 5.2 Spacing scale

Standard Tailwind 4px base. The values actually used, in order of frequency:

| Step | Value | Usage |
|---|---|---|
| `1` / `1.5` | 4 / 6px | Icon-to-text gaps |
| `2` | 8px | Inline chip padding (`py-0.5`–`py-1`), tight stacks |
| `2.5` / `3` | 10 / 12px | Badge padding, small gaps |
| `3.5` / `4` | 14 / 16px | Header action gaps, card padding (compact) |
| `5` | 20px | Card padding (standard) |
| `6` | 24px | Section stack (`space-y-6`), mobile content padding |
| `8` | 32px | Desktop content padding, header padding |

**Section rhythm:** top-level sections stack with `space-y-6`. Grids use `gap-4`.

### 5.3 Grid

| Context | Classes |
|---|---|
| KPI row | `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4` |
| Task card gallery | `grid` with responsive 1→2→3 columns |
| Audit review gallery | 1→2→3→4 columns |
| Toolbar / filter bar | `flex flex-col md:flex-row items-center justify-between gap-4` |

**Breakpoints (Tailwind defaults):** `sm` 640 · `md` 768 · `lg` 1024 · `xl` 1280.

### 5.4 Responsive behaviour — 🎯 Target, not implemented

**✅ Shipped (the problem):** at 390px and 320px the `w-64` sidebar **does not collapse**. Measured live at 390px: sidebar `256px`, viewport `390px` (66% consumed), leaving **134px** of content width; the header inflates from 45px to **165px**. The app root carries `overflow-hidden`, so there is not even a horizontal scroll to reach the clipped content. Evidence: `ui-audit/shots/11-mobile-390-dashboard.png`, `12-mobile-320-dashboard.png`.

**🎯 Target (documented as design intent):**
- `< md` (768px): sidebar becomes an off-canvas drawer — hidden by default, opened by a hamburger in the header, with a `slate-950/60` scrim.
- Alternatively, `< md`: collapse to a 64px icon-only rail (`w-16`), labels hidden, tooltips on hover.
- Primary actions (`Yeni Təlimat Yarat`) collapse to icon-only below `sm`.

This is the **highest-priority responsive item** in the system.

---

## 6. Corner Radius

| Token | Value | Usage |
|---|---|---|
| `rounded-md` | 6px | Micro chips, overlay stamps |
| `rounded-lg` | 8px | Small buttons, icon tiles (`w-9 h-9`), checklist items |
| **`rounded-xl`** | **12px** | **Cards, panels, primary buttons, inputs — the default** |
| `rounded-2xl` | 16px | Modals, large sheets |
| `rounded-full` | 9999px | Status pills, badges, avatars, filter chips, progress tracks |

**Rule:** when unsure, use `rounded-xl`. Buttons and their containers should not mix radii inside the same visual group.

---

## 7. Elevation

| Level | Class | Usage |
|---|---|---|
| Flat | *(none)* | Table rows, inline content |
| Raised | `shadow-sm` | Gradient alert banner, subtle lift |
| Card | `shadow-subtle` *(intended)* | All content cards — **currently undefined, see §14** |
| Hover | `hover:shadow-md` | Card hover affordance (paired with `transition-all`) |
| Brand glow | `shadow-sm shadow-coke-500/20` | Primary buttons and active nav items |
| Overlay | `shadow-2xl` | Modals, drawers |

**Interaction rule:** every card uses `shadow-subtle … transition-all hover:shadow-md`. Hover lift is the universal "this is interactive" signal. Cards that are *not* clickable must not gain a hover shadow.

---

## 8. Iconography

- **Library:** `lucide-react` (already a dependency).
- **Stroke:** library default (2px), never restyled.
- **Sizes:** `w-3 h-3` (inline metadata, e.g. the `ShieldCheck` role marker) · `w-3.5 h-3.5` (chip icons, clock) · `w-4 h-4` (nav items, buttons, KPI icons).
- **Color:** icons inherit their context — `text-slate-400` on inactive nav, `text-white` on active, semantic color inside KPI tiles.
- **Emoji are part of the content layer, not the icon layer.** Status labels use emoji prefixes (`✅ Təsdiqləndi`, `⏳ Gözləyir`, `❌ İmtina edildi`, `🔴 Təcili`) and priority chips use colored circles (`🟠 Yüksək`). This is deliberate — it gives a **redundant, non-color cue** for status, which matters for field users in bright sunlight and for color-vision deficiency. Keep the emoji.

---

## 9. Motion

Minimal and functional. No decorative animation.

| Interaction | Classes | Duration |
|---|---|---|
| Card hover | `transition-all hover:shadow-md` | 150ms (Tailwind default) |
| Button hover | `transition-all hover:bg-coke-600` | 150ms |
| Button press | `active:scale-95` | 150ms |
| Nav item | `transition-all` | 150ms |
| Toast | auto-dismiss after **3500ms** | — |

Do not add entrance animations, parallax, or scroll effects to the portal — it is an operational tool used repeatedly all day.

---

## 10. Components

Each spec below is tagged **✅ Shipped** (matches code today) or **🎯 Target** (intent, not built). Class
recipes marked ✅ were read directly from the component source on 2026-09-12; if you change a component,
update its recipe here in the same commit.

### 10.1 Sidebar — ✅ Shipped

| Property | Spec |
|---|---|
| Container | `w-64 bg-slate-900 text-white flex flex-col flex-shrink-0 border-r border-slate-800 select-none` |
| Brand block | `p-5 border-b border-slate-800`, 40×40 logo tile (`rounded-xl bg-coke-500 shadow-md shadow-coke-500/20`), wordmark `font-extrabold text-base tracking-tight` |
| Partner chip | `text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-coke-500/25 text-coke-400 border border-coke-500/30` |
| Group label | `px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400` |
| Nav list | `flex-1 px-3 py-5 space-y-1` |
| Nav item | `w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all` |
| Nav item — active | `bg-coke-500 text-white shadow-sm shadow-coke-500/25` |
| Nav item — idle | `text-slate-300 hover:bg-slate-800 hover:text-white` |
| Nav icon | `w-4 h-4` — `text-white` active, `text-slate-400` idle |
| Badge (count) | `text-[10px] px-2 py-0.5 rounded-full font-bold` · default `bg-slate-700 text-slate-200` · attention `bg-amber-500 text-white` |
| Account footer | `p-4 border-t border-slate-800 bg-slate-950/60`, 36px avatar (`rounded-full bg-slate-800 border border-slate-700`), initials `text-xs font-bold` |

**Navigation items:** `İcmal & Statistika` · `Rəf Auditi (Yoxlama)` · `Planogram Tapşırıqları` · `Mağazalar Şəbəkəsi`.

### 10.2 Header — ✅ Shipped (with two broken utilities)

| Property | Spec |
|---|---|
| Container | `h-18 bg-white border-b border-slate-200/80 px-8 flex items-center justify-between flex-shrink-0 shadow-xs` *(both `h-18` and `shadow-xs` are invalid — §14)* |
| Title | `text-lg font-bold text-slate-900 tracking-tight` |
| Subtitle | `text-xs text-slate-500` |
| Clock chip | `hidden md:flex items-center space-x-2 bg-slate-100 px-3.5 py-1.5 rounded-full border border-slate-200 text-xs font-medium text-slate-700`; time value `font-mono font-semibold text-slate-900` |
| Primary action | `flex items-center space-x-2 bg-coke-500 hover:bg-coke-600 active:scale-95 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-sm shadow-coke-500/20 transition-all` |

Every tab has a title + subtitle pair; both are required (§12 for the copy map).

### 10.3 KPI Card — ✅ Shipped

```
bg-white rounded-xl p-5 border border-slate-200 shadow-subtle transition-all hover:shadow-md
├── flex items-center justify-between
│   ├── span.text-xs.font-bold.text-slate-500.uppercase.tracking-wider   (label)
│   └── div.w-9.h-9.rounded-lg.border.flex.items-center.justify-center   (icon tile, category colors)
└── mt-3
    ├── div.text-2xl.font-extrabold.text-slate-900.tracking-tight        (value)
    └── p.text-xs.text-slate-500.mt-0.5                                  (subtitle)
```

Attention variant: `border-amber-300 ring-2 ring-amber-400/20`.

### 10.4 Status Badge (canonical) — ✅ Shipped

**Table/card density** — `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold`:

| Status | Classes | Label |
|---|---|---|
| `pending_review` | `bg-amber-50 text-amber-700 border border-amber-200` | `⏳ Gözləyir` |
| `approved` | `bg-emerald-50 text-emerald-700 border border-emerald-200` | `✅ Təsdiqləndi` |
| `rejected` | `bg-rose-50 text-rose-700 border border-rose-200` | `❌ İmtina edildi` |

**Modal/overlay density** — `inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-extrabold`, using `bg-{family}-100 text-{family}-800 border border-{family}-300`.

**On-image overlay** — `px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-{family}-{600|500}/90 text-white backdrop-blur-xs`.

### 10.5 Priority Badge — ✅ Shipped

| Value | Classes | Label |
|---|---|---|
| `urgent` | `bg-rose-100 text-rose-800` | `🔴 Təcili` |
| `high` | `bg-orange-100 text-orange-800` | `🟠 Yüksək` |
| `medium` | `bg-amber-100 text-amber-800` | `🟡 Orta` |
| `low` | `bg-emerald-100 text-emerald-800` | `🟢 Aşağı` |

Shape: `px-2.5 py-0.5 rounded-full text-xs font-bold`. In `<select>` options the format is `{emoji} {Azerbaijani} ({English})`, e.g. `🟠 Yüksək (High)`.

### 10.6 Scenario Chip (AI classification) — ✅ Shipped

`inline-block text-[10px] font-extrabold px-1.5 py-0.5 rounded border`:

| Scenario | Classes | Label |
|---|---|---|
| `scenario_a_compliant` | `bg-emerald-100 text-emerald-800 border-emerald-200` | `⭐ Ssenari A` |
| `scenario_b_gap` | `bg-amber-100 text-amber-800 border-amber-200` | `⚠️ Ssenari B` |
| `scenario_c_missing_sprite` | `bg-rose-100 text-rose-800 border-rose-200` | `❌ Ssenari C` |

The numeric AI score appears in two shapes, both **✅ Shipped**:

- **List/card chip** — `px-2 py-0.5 rounded-full text-[10px] font-extrabold` with a `🤖` prefix, e.g. `🤖 95%`.
- **Modal score tile** — `w-14 h-14 rounded-xl`, stacked value + `AI BAL` eyebrow, `text-white`.

**Score bands (canonical):** **≥ 80** → emerald · **60–79** → amber · **< 60** → rose. The same 80/60
thresholds gate the auto-approve affordance: the "Bir Kliklə AI Təsdiqi" button renders only when
`ai_score >= 80` **and** `status === 'pending_review'`.

### 10.7 Buttons — ✅ Shipped

| Variant | Spec |
|---|---|
| **Primary** | `bg-coke-500 hover:bg-coke-600 text-white rounded-xl px-4 py-2 text-xs font-bold shadow-sm shadow-coke-500/20 transition-all active:scale-95` |
| **Success** | `bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-5 py-2 text-xs font-bold shadow-xs transition-all` |
| **Neutral / Dark** | `bg-slate-900 text-white rounded-lg px-4 py-2 text-xs font-bold` |
| **Ghost / Filter** | idle `bg-white border border-slate-200 text-slate-600`; active `bg-slate-900 text-white`; `rounded-lg text-xs font-semibold` |
| **Destructive** | `bg-rose-600 hover:bg-rose-700 text-white` |

All interactive elements carry `cursor-pointer`. Buttons are `flex items-center justify-center space-x-1.5` when icon + label, and `flex-1 sm:flex-none` inside mobile action rows.

### 10.8 Filter Chips (segmented control) — ✅ Shipped

Container `bg-white rounded-xl p-4 border border-slate-200 shadow-subtle flex flex-col md:flex-row items-center justify-between gap-4`.
Chip: `px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer`.
Active chip `bg-slate-900 text-white shadow-xs`; idle `bg-slate-100 text-slate-600 hover:bg-slate-200`.

Labels (`AuditReviewCenter.tsx` L151–154): `Bütün Fotolar` · `⏳ Gözləyən` · `✅ Təsdiqlənmiş` · `❌ İmtina Edilmiş`.

> **v1.1 fix:** v1.0 wrote the first label as "Bütün **Fətolar**". The code says "Bütün **Fotolar**". The
> chip classes were also documented as `font-semibold`; the shipped weight is `font-bold`.

### 10.9 Search Input — ✅ Shipped

Wrapper `relative w-full md:w-72`. Leading icon `absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`.

Field: `w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-coke-500/20 focus:border-coke-500`

Placeholders: `"Mağaza və ya tapşırıq axtar..."` (review center) · `"Filial adı və ya kod ilə axtar..."` (store directory).

> **v1.1 fix:** v1.0 documented this as `bg-white … rounded-xl px-4`. Shipped values are `bg-slate-50`,
> `rounded-lg`, and `pl-9 pr-4` (the left padding clears the icon).

### 10.10 Alert / Action Banner — ✅ Shipped

`bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl p-4 text-white shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3`, with a leading `w-9 h-9 rounded-lg bg-white/20 backdrop-blur-sm` icon tile and a trailing white pill CTA.

CTA: `bg-white text-slate-900 hover:bg-slate-50 font-bold text-xs px-4 py-2 rounded-lg transition-all shadow-xs whitespace-nowrap`.

> **v1.1 fix:** v1.0 documented the CTA text as `text-amber-700`; the shipped colour is `text-slate-900`.

Reserved for **pending work that requires supervisor action**. Do not use for confirmations.

### 10.11 Data Table — ✅ Shipped

- Table: `w-full text-left text-xs` — so **header cells inherit 12px**, not 10px.
- `thead`: `bg-slate-50 border-b border-slate-100 text-slate-500 font-bold uppercase tracking-wider`.
- Header cell: `py-3 px-5`. Body cell: `py-2.5 px-5`.
- `tbody`: `divide-y divide-slate-100`; row hover `hover:bg-slate-50/80 transition-colors`.
- Row composition: a **44×44** thumbnail (`w-11 h-11 rounded-lg bg-slate-100 border border-slate-200 object-cover`), primary + secondary stacked text, a monospace time cell (`font-mono text-[11px]`), an AI score chip, a status badge, and a right-aligned action button.

> **v1.1 fix:** v1.0 documented header cells as `text-[10px]` and the thumbnail as 40×40. Neither matches the
> shipped code — the header inherits `text-xs` and the thumbnail is `w-11 h-11` (44px).

### 10.12 Progress Bar — ✅ Shipped (thresholds are 80 / 50)

Track `w-24 h-2 rounded-full bg-slate-200 overflow-hidden`; fill `h-full rounded-full` with inline `style={{ width: 'NN%' }}`; label `font-bold font-mono text-[11px] text-slate-800` to the right.

**Canonical thresholds (as shipped):** **≥ 80%** → `bg-emerald-500` · **50–79%** → `bg-amber-500` · **< 50%** → `bg-rose-500`. Stores with zero audits render **100%**.

> **v1.1 fix:** v1.0 described the amber/rose shift as "recommended addition, not yet implemented" and gave
> 50/25 as the thresholds. It **is** implemented, with thresholds of **80 / 50**.

### 10.13 Modal / Drawer — ✅ Shipped shell · 🎯 Target behaviour

**✅ Shipped (measured from code, 2026-09-12):**

| Part | Audit Review Center | Task Manager (bulk + create) |
|---|---|---|
| Backdrop | `fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm` | `fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm` |
| Scrim padding | `p-4 sm:p-6 overflow-y-auto` | `p-4 sm:p-6 overflow-y-auto` |
| Panel | `bg-white w-full max-w-5xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-auto flex flex-col` | `bg-white w-full max-w-2xl` / `max-w-xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-auto` |
| Max height | `max-h-[92vh]` | *(none set — backdrop scrolls instead)* |
| Header | `p-5 border-b border-slate-200 bg-slate-50` | bulk: `bg-slate-900 text-white`; create: `bg-slate-50` |
| Footer | `p-4 bg-white border-t border-slate-200` | `pt-4 border-t border-slate-200` |

> **v1.1 fixes.** v1.0 declared a single backdrop of `bg-slate-950/60` and a `90vh` max height. **Neither
> value exists in the code** — the real values are `/75` and `/80`, and `92vh`. A canonical scrim opacity is
> still undecided; `/75` is the majority (2 of 3 modals) and is the proposed default.

**🎯 Target behaviour — NOT implemented. Do not assume any of this works today:**

- **Escape closes the modal** — ❌ not wired up. Verified by live test: pressing `Esc` does nothing.
- **Focus is trapped inside the modal** — ❌ not implemented.
- **First field is auto-focused** — ❌ not implemented.
- **Clicking the backdrop closes the modal** — ❌ not implemented.
- **Focus returns to the trigger element on close** — ❌ not implemented.

The only ways to dismiss a modal today are the `X` button and the `Ləğv Et` button. This is tracked as gap #14 in §14 and is the single largest accessibility defect in the portal.

> v1.0 stated these behaviours in the present tense with no marker, which made unbuilt functionality look
> shipped. That is exactly the failure mode the ✅/🎯 tags now prevent.

### 10.14 Toast — ✅ Shipped

Shipped container: `fixed top-5 right-5 z-50 bg-slate-900 text-white px-4 py-2.5 rounded-xl shadow-lg border border-slate-800 text-xs font-bold flex items-center space-x-2 transition-all`.

Auto-dismiss **3500ms**. Message format is `{emoji} {Azerbaijani sentence}` — five messages ship today:

- `✅ Rəf auditi uğurla təsdiqləndi!`
- `⚡ Rəf auditi AI təhlili əsasında avtomatik təsdiqləndi!`
- `❌ İmtina qərarı və təlimat supervayzer tərəfindən qeydə alındı.`
- `📌 Yeni planogram təlimatı mağazalara uğurla göndərildi!`
- `🚀 Kütləvi Təlimat: {N} hədəf mağazaya və sahə merchandiser-lərinə uğurla göndərildi!`

> **v1.1 fixes.** v1.0 documented **bottom**-right, `py-3`, `font-semibold`, `shadow-2xl`, and listed only four
> messages. The shipped toast is **top**-right, `py-2.5`, `font-bold`, `shadow-lg`, and has five messages.

**🎯 Target:** move to **bottom-right** so the toast never overlaps the header's primary action, and add
`aria-live="polite"` to the container so screen readers announce it (gap #15, §14).

### 10.15 Comparison Modal (core feature) — ✅ Shipped

Body is `grid grid-cols-1 md:grid-cols-2 gap-5` on `bg-slate-100/60`, each pane a card
`bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col` — **no divider line**; the gap and
the tinted body separate them.

- **Left pane = reference planogram** — blue dot marker, `Standart Planogram (İdeal Rəf Düzülüşü)`, `Referans Nümunə` chip, then the instruction block (`line-clamp-3`).
- **Right pane = field photo** — red dot marker, `Mağazadan Yüklənən Rəf Fotosu`, with the Before/After toggle and the AI-box toggle in the header.
- **Stamped overlays** — `absolute top-2.5 left-2.5 px-2.5 py-1 rounded-md text-[10px] font-extrabold bg-slate-950/80 backdrop-blur-xs text-white border border-white/20 shadow-xs`.
- **Checklist items** — `p-2.5 bg-white rounded-lg border border-blue-100 shadow-xs` inside a `bg-blue-50/80 border-blue-200` block.

**Actions:**

| Action | Colour | Condition |
|---|---|---|
| `✅ Təsdiq Et` | `bg-emerald-600 hover:bg-emerald-700` | always |
| `❌ İmtina Et` (opens feedback drawer) | `bg-rose-50 border-rose-200 text-rose-700` | always |
| `⚡ Bir Kliklə AI Təsdiqi` | **`bg-coke-500 hover:bg-coke-600`** — brand red | `ai_score >= 80` **and** `status === 'pending_review'` |

> **v1.1 fix:** v1.0 documented the AI auto-approve button as **indigo**. It is **brand red (`coke-500`)** in
> the shipped code. `indigo` is reserved for the Before & After evidence marker (§3.3) and is not used for AI
> anywhere in the portal. The AI action renders in **two** places — the summary banner and the footer — with
> identical styling and the same guard condition.

> ⚠️ **Known defect — this core feature is broken in the demo data.** `sub-002.photo_url` and
> `sub-001.before_photo_url` both point at an Unsplash asset that returns **404**, and no `<img>` in the
> portal has an `onError` fallback. Result: one gallery card and the entire "İLKİN RƏF" view render as a
> broken-image glyph. See gap #16 in §14.

---

## 11. Status → Visual Mapping (canonical reference)

This is the authoritative table. If a component disagrees with it, the component is wrong.

| Domain value | Color family | Emoji | Azerbaijani label | Applies to |
|---|---|---|---|---|
| `approved` | emerald | ✅ | Təsdiqləndi | submissions |
| `pending_review` | amber | ⏳ | Gözləyir | submissions |
| `rejected` | rose | ❌ | İmtina edildi | submissions |
| `urgent` | rose | 🔴 | Təcili | task priority |
| `high` | orange | 🟠 | Yüksək | task priority |
| `medium` | amber | 🟡 | Orta | task priority |
| `low` | emerald | 🟢 | Aşağı | task priority |
| `draft` | slate | — | Qaralama | task status |
| `published` / `active` | emerald | — | Aktiv | task status |
| `completed` | slate | — | Tamamlandı | task status |
| `archived` | slate | — | Arxivlənmiş | task status |
| `scenario_a_compliant` | emerald | ⭐ | Ssenari A | AI classification |
| `scenario_b_gap` | amber | ⚠️ | Ssenari B | AI classification |
| `scenario_c_missing_sprite` | rose | ❌ | Ssenari C | AI classification |

**Note:** `medium`/`low` priority and `approved` share the emerald/amber families. They are distinguishable by emoji and label — always render both.

---

## 12. Content, Localization & Formatting

- **Language:** Azerbaijani (`az`) is the UI language. `<html lang="az">`. Domain enums stay in English in the data layer (`pending_review`) and are mapped to Azerbaijani at render time.
- **Tone:** formal-imperative, addressed to a supervisor. `"Yeni Təlimat Yarat"`, `"Yoxlama Mərkəzinə Keç"`.
- **Mixed-language labels** are acceptable only where the English term is the domain term: `"Təcili (Urgent)"`.
- **Time zone:** all times render in `Asia/Baku`. Use `toLocaleTimeString('az-AZ', { timeZone: 'Asia/Baku', … })`.
- **Dates:** `YYYY-MM-DD` in tables and cards; `DD.MM.YY HH:mm` in compact cells.
- **Numbers:** percentage as `NN%` with no space. Distances as `NNm`.
- **Tab titles** (title + subtitle pairs) are defined in `Header.tsx` and must be updated there — do not hardcode titles in page components.

---

## 13. Accessibility

Measured live on 2026-09-12 at 1600×1000. `✅` = met, `⚠️` = partial, `🎯` = target, not met.

| Requirement | Standard | State | Evidence |
|---|---|---|---|
| **Contrast** | Body text ≥ 4.5:1. `slate-500` on white = 4.76:1. `slate-400` on white = 3.0:1 → **metadata only, never body copy**. | ⚠️ | Rule is respected in the shipped type scale, but `slate-400` is used for 11px helper text in several places — audit against §4.2. |
| **Status never colour-only** | Always colour **+** emoji **+** text label (§8, §11). | ✅ | Every status/priority chip carries an emoji prefix and an Azerbaijani label. Keep it. |
| **Visible focus ring** | `focus-visible:ring-2 focus-visible:ring-coke-500 focus-visible:ring-offset-2` | 🎯 | **Zero** `focus-visible` rules exist in the compiled stylesheet (counted: `0`). Keyboard users cannot see focus anywhere. |
| **Touch targets ≥ 40×40px** | Applies to every tappable control on touch. | 🎯 | **Not met.** Measured heights: filter chip **28px** · header CTA **32px** · card CTA **32px** · sidebar nav item **36px**. Only the 44×44 table thumbnail meets it. |
| **Semantics** | Sidebar nav = `<nav>` + `aria-current="page"`; icon-only buttons need `aria-label`; modals need `role="dialog" aria-modal="true"`. | 🎯 | **Not met.** `aria-*` and `role=` occurrences across all six components: **0**. |
| **Modal keyboard behaviour** | Escape closes, focus trapped, focus returns to trigger. | 🎯 | **Not met.** See §10.13. |
| **Motion** | No parallax or auto-animation, so `prefers-reduced-motion` needs no special handling today. | ✅ | Holds — only 150ms hover/press transitions. |
| **Images** | Field photos and planograms need descriptive `alt` text (store + task), not filenames. | ⚠️ | All `<img>` have `alt`, but they are generic (`"Shelf Audit"`, `"Planogram Reference"`). No `onError` fallback on any image except the sidebar logo. |
| **Live regions** | Async results announced to screen readers. | 🎯 | The toast has no `aria-live` (§10.14). |

> **Summary:** the portal is currently unusable by keyboard-only and screen-reader users. Fixing focus rings,
> modal semantics and `aria-label`s on icon buttons is the highest-value accessibility work and is mostly
> mechanical — see the fix order in §17.

---

## 14. Token Debt & Known Gaps

**Active defects.** Items #1–#7 are *token debt*: the code references utilities that do not exist in Tailwind
v3.4.19, so they silently render nothing. Items #8–#21 are *design-system gaps* — behaviour and patterns that
were never built. Severity: **P0** = blocks production use · **P1** = degrades the experience · **P2** = polish.

### 14.1 Token debt

| # | Sev | Issue | Occurrences | Impact | Fix |
|---|---|---|---|---|---|
| 1 | **P1** | `shadow-subtle` — never defined in `tailwind.config.js` | **8** (4 files) | Every content card is flat; the intended "card elevation" level does not exist (measured `boxShadow: none`) | Define `subtle: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)'` in `boxShadow` — **but read the §15 trap first** |
| 2 | **P1** | `shadow-xs` — Tailwind **v4** utility, project is on **v3** | **23** | Buttons, badges and overlays lose their lift | Add `xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)'` to `boxShadow` |
| 3 | **P1** | `backdrop-blur-xs` — Tailwind v4 utility | **7** | On-image overlay chips have no blur → text can be unreadable over busy photos | Replace with `backdrop-blur-sm` |
| 4 | **P1** | `h-18` — not in the v3 spacing scale | **1** | Header has no fixed height (measured **45px**); sizing is content-driven and shifts per tab | Replace with `h-[72px]` or add `18: '4.5rem'` to `spacing` |
| 5 | **P2** | `index.html` uses `zinc-*` while `index.css` uses `slate-*` | 2 | Two neutral palettes declared; `index.css` wins silently | Remove `bg-zinc-50 text-zinc-900` from `<body>` |
| 6 | **P2** | Font family declared twice (CSS + arbitrary Tailwind class) | 2 | Maintenance hazard | Keep the CSS declaration only |
| 7 | **P2** | `tailwind.config.js` duplicated at repo root and in `web/` | 2 files | Token drift risk — and a live trap (§15) | Make root the source and have `web/` extend/re-export it |

### 14.2 Missing patterns & unbuilt behaviour

| # | Sev | Issue | Impact | Fix |
|---|---|---|---|---|
| 8 | P1 | No shared token/component module | Status colours re-typed inline in every component (14+ variants of the same badge) | Extract `StatusBadge`, `PriorityBadge`, `ScenarioChip`, `KpiCard` into `web/src/components/ui/` |
| 9 | P1 | No `focus-visible` ring anywhere | Keyboard users cannot see focus — measured **0** such rules in the compiled CSS | Add a global focus style (§13) |
| 10 | **P0** | Sidebar does not collapse below `md` | Portal unusable on phones; measured 134px of content width at 390px (§5.4) | Off-canvas drawer or `w-16` icon rail |
| 11 | P1 | No 404 / empty / error states defined | Empty tables and failed Supabase loads render blank. Only `AuditReviewCenter` has an empty state | Define `EmptyState` and `ErrorState` patterns |
| 12 | P1 | No loading skeleton pattern | Data fetches show zeros and a wrong 50% compliance figure, then jump | Define skeleton cards matching KPI/card geometry |
| 13 | P1 | Legibility floor never enforced | 70 occurrences of 9–11px type; the §4.2 tier rule was only written in v1.1, so nothing is triaged yet | Audit every 9–10px usage against §4.2; anything carrying actionable text is a defect |
| 14 | P1 | Modal keyboard behaviour not implemented | `Esc` does nothing, focus is not trapped, no auto-focus, backdrop click does not close (§10.13) | Wire up all four behaviours in a shared `Modal` primitive |
| 15 | P1 | Toast has no `aria-live` | Screen readers never announce success/error feedback | Add `aria-live="polite"` to the toast container |
| 16 | **P0** | Broken demo image + no `onError` fallback | `photo-1581093458791-9f3c3900df4b` returns **404**; it is `sub-002.photo_url` and `sub-001.before_photo_url`. One gallery card and the whole "İLKİN RƏF" view render as a broken-image glyph. No `<img>` except the sidebar logo has a fallback | Replace the URL; add `onError` to every `<img>`; move reference images into Supabase Storage |
| 17 | P2 | Buttons wrap to two lines — no `whitespace-nowrap` | Measured: the dashboard row action renders as "Müqayisə / Et" at **46px** instead of 28px, doubling row height; "Ləğv Et" wraps the same way in the bulk-dispatch modal | Add `whitespace-nowrap` to button recipes in §10.7 |
| 18 | **P0** | No authentication anywhere in the portal | `web/src` contains no login, session or role check. The sidebar identity ("Supervayzer Admin / SA") is hardcoded. Anyone who can reach the URL can approve or reject audits | Build a Supabase Auth login screen and enforce role-based permissions (only `supervisor`/`admin` may approve or reject) |
| 19 | P1 | `alert()` used for form validation | 3 call sites. Blocking, off-system, and suppressed by some mobile browsers; the message does not identify which field is wrong | Replace with inline field-level validation |
| 20 | P1 | Status labels are hardcoded | `StoreDirectory` prints `● Aktiv` for every store regardless of `is_active`; `TaskManager` prints `Aktiv` for every task regardless of `status` (`draft`/`archived` would also read "Aktiv") | Derive both from the data (§11) |
| 21 | P1 | 5 clickable `<div>`s | Store and template selectors in `TaskManager` are not focusable, not operable by keyboard, and not announced as controls | Replace with `<button>` or `<input type="checkbox">` |

> **Priority order:** #10 and #18 are the two P0 items that block real deployment — see §17.

---

## 15. Tailwind Configuration to Adopt

Merge this into `tailwind.config.js` (root, then re-export from `web/`) to close items #1–#4 and #7.

> ### ⚠️ TRAP — read before editing any Tailwind config
>
> **`web/vite.config.ts` loads `web/tailwind.config.js` explicitly**, by absolute path:
>
> ```ts
> tailwindcss({ config: path.resolve(__dirname, 'tailwind.config.js') })
> ```
>
> `__dirname` here is `web/`. So the config that actually styles the portal is **`web/tailwind.config.js`**,
> *not* the root file. Editing only the root config produces **no visible change and no error** — you will
> believe the fix worked when it did not.
>
> **Required sequence — do not skip step 2:**
>
> 1. Put the canonical tokens in the **root** `tailwind.config.js` (single source of truth).
> 2. Replace `web/tailwind.config.js` with a re-export so it inherits them:
>    ```js
>    export { default } from '../tailwind.config.js';
>    ```
>    If the `web/` config needs additions, import and spread instead of re-declaring:
>    ```js
>    import root from '../tailwind.config.js';
>    export default { ...root, theme: { ...root.theme, extend: { ...root.theme.extend } } };
>    ```
> 3. **Verify the fix actually landed** — restart the dev server and check a card in DevTools:
>    - Card `box-shadow` must no longer be `none` (gap #1).
>    - `<header>` computed height must be `72px` (gap #4).
>    - A `[class*="backdrop-blur"]` chip must report a non-`none` `backdrop-filter` (gap #3).
>
>    A silent no-op here is the single easiest way to "close" gaps #1–#4 without changing anything.

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./web/index.html",
    "./web/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          red: '#F40009',
          dark: '#111827',
        },
        coke: {
          50: '#fff1f1',  100: '#ffdfdf', 200: '#ffc5c5', 300: '#ff9d9d',
          400: '#ff6464', 500: '#F40009', 600: '#D80008', 700: '#B50007',
          800: '#940006', 900: '#7A0005',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system',
               'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        xs:     '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        subtle: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
      },
      spacing: {
        18: '4.5rem', // 72px header
      },
      borderRadius: {
        '2xl': '1rem',
      },
    },
  },
  plugins: [],
}
```

---

## 16. Governance

1. **No new raw hex values in components.** Add the token to `tailwind.config.js` first, then use it.
2. **No new status color.** Extend the table in §11 and the `StatusBadge` component.
3. **New component?** Document it in §10 with its exact class recipe before merging.
4. **New page?** It must supply a title/subtitle pair in `Header.tsx` and an empty + loading state.
5. **Review cadence:** revisit this document when a new platform surface ships (e.g. the mobile client gaining its own UI) or when the Tailwind major version changes — items #2 and #3 in §14 exist purely because v4 utilities were used on a v3 project.
6. **Visual regression:** `ui-audit/` contains a scripted screenshot harness (`shoot.mjs`, `probe.mjs`, `probe3.mjs`). Extend it to cover any new screen so the design system has a visual baseline.
7. **Tag every spec.** Every §10 entry carries **✅ Shipped** or **🎯 Target**. Never describe unbuilt behaviour in the present tense — v1.0 did this for modal keyboard handling (§10.13) and it made unbuilt functionality look shipped.
8. **Verify in the running app, not just the source.** Before marking a §14 gap closed, confirm the change in the browser. The §15 trap means a config edit can look correct in the diff and have zero effect at runtime.
9. **Keep §10 in sync.** If you change a component's classes, update its recipe in §10 in the same commit. v1.1 corrected seven recipes that had drifted from the code.

---

## 17. Change Log

### v1.1 — 2026-09-12

Corrections made after a live render + measurement pass against the running portal.

**Spec ↔ code mismatches fixed (7):**

| § | Was documented | Corrected to |
|---|---|---|
| 10.8 | Chip label `Bütün Fətolar`; chips `font-semibold` | `Bütün Fotolar`; `font-bold` |
| 10.9 | Search input `bg-white`, `rounded-xl`, `px-4` | `bg-slate-50`, `rounded-lg`, `pl-9 pr-4` |
| 10.10 | Banner CTA text `text-amber-700` | `text-slate-900` |
| 10.11 | Header cells `text-[10px]`; thumbnail 40×40 | Header inherits `text-xs`; thumbnail `w-11 h-11` (44px) |
| 10.12 | Amber/rose thresholds "not yet implemented" (50/25) | **Implemented**, thresholds **80 / 50** |
| 10.13 | Backdrop `bg-slate-950/60`; max height `90vh` | `/75` and `/80`; `max-h-[92vh]` |
| 10.14 | Toast bottom-right, `py-3`, `font-semibold`, `shadow-2xl`, 4 messages | top-right, `py-2.5`, `font-bold`, `shadow-lg`, 5 messages |
| 10.15 | AI auto-approve is **indigo** | **`coke-500` brand red**; `indigo` = Before & After marker (§3.3, §3.4) |

**Internal contradictions resolved (2):**

- §2 "no fonts below 11px" vs §4.2 sanctioning 10px/9px → replaced with an explicit three-tier legibility floor (§4.2).
- §2/§13 "touch targets ≥ 40px" vs §10.2/§10.7/§10.8 specifying 26–36px controls → the 40px rule is now marked **🎯 Target, not met**, with measured values (§13).

**Dangerous present-tense spec removed:**

- §10.13 stated "Escape closes; focus is trapped; first field is auto-focused" as if implemented. Live test: `Esc` does nothing. Now explicitly tagged **🎯 Target — NOT implemented**, with all four missing behaviours enumerated.

**Implementation trap documented:**

- §15 now warns that `web/vite.config.ts` loads `web/tailwind.config.js`, so editing only the root config is a silent no-op, and gives a verification checklist.

**New gaps added to §14 (previously undocumented):** authentication (#18, P0), broken demo image + no `onError` fallback (#16, P0), two-line button wrapping (#17), `alert()` validation (#19), hardcoded status labels (#20), non-semantic clickable divs (#21), legibility audit (#13), modal keyboard behaviour (#14), toast `aria-live` (#15). Severity and `✅/🎯` tagging introduced throughout.

**New finding from live measurement:** the dashboard row action button renders "Müqayisə / Et" on two lines (46px tall instead of 28px) because the button recipe lacks `whitespace-nowrap` — same root cause as the "Ləğv Et" wrap in the bulk-dispatch modal.

---

## Appendix A — Surface Inventory

| Surface | Tech | Design system applies? |
|---|---|---|
| Supervisor & Admin Web Portal (`web/`) | React 19 + Vite + Tailwind 3.4 | **Yes — primary subject of this document** |
| Telegram Bot (`src/bot/`) | grammY | Partially — text, emoji and keyboard labels follow §8/§11/§12 |
| iOS Field Client (`mobile/`) | TypeScript controllers, no rendered UI yet | **Not yet** — `mobile/src` contains controllers and services only (no components/styles). Define its tokens before UI work starts. |
| NestJS API (`apps/api/`) | Server-side | No |
