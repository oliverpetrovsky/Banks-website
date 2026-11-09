---
version: "alpha"
name: "Noir Detetive"
description: "Noir detective landing page. Ideal for landing pages, saas. AI-ready template."
colors:
  primary: "#0F0F0F"
  secondary: "#4A4A4A"
  tertiary: "#E8C547"
  neutral: "#D4D4D4"
  surface: "#5C0A0A"
  accent: "#FF2D2D"
typography:
  h1:
    fontFamily: Special Elite
    fontSize: 2.5rem
    fontWeight: 700
  body-md:
    fontFamily: Special Elite
    fontSize: 1rem
    fontWeight: 400
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    padding: 12px
---

## Overview

Noir detective landing page. Ideal for landing pages, saas. AI-ready template. Film noir didn't ask permission. It crawled out of post-war anxiety, German Expressionist cinematography, and cheap studio lighting rigs that turned limitations into style. The 1940s and 50s gave us a visual grammar built on chiaroscuro — hard light cutting through darkness, faces half-revealed, venetian blinds slicing scenes into horizontal wounds. Directors like Billy Wilder and Fritz Lang understood something fundamental: what you hide matters more than what you show.

That tension translates beautifully to interface design. Noir's dramatic contrast ratios aren't decorative — they're hierarchical. Deep blacks push content forward. Harsh directional light (or its digital equivalent: strategic white space against dark surfaces) creates focal points without screaming for attention. The venetian blind motif becomes horizontal rule patterns, layered card shadows, striped data visualizations.

What makes noir endure isn't the fedoras. It's the commitment to mood over clarity, atmosphere over explanation. Every shadow is a design decision.

- Density: 5/10 — Balanced
- Variance: 7/10 — Dynamic
- Motion: 8/10 — Cinematic

- **Style:** Mysterious, Cinematic, Moody
- **Keywords:** film noir, detective, mysterious, cinematic, moody, high contrast, venetian blinds, shadows, rain, trench coat, crime
- **Era:** 1940s-1950s Film Noir
- **Light/Dark:** ✗ No / ✓ Full

## Colors

- **Noir Black** (#0F0F0F) — Dark surface, primary background
- **Smoke Grey** (#4A4A4A) — Secondary text, borders, muted elements
- **Streetlamp Yellow** (#E8C547) — Warning states, attention indicators
- **Fog White** (#D4D4D4) — Light surface, card backgrounds
- **Blood Wine** (#5C0A0A) — Extended palette, decorative use
- **Neon Sign Red** (#FF2D2D) — Error states, destructive actions
- **Rainy Blue** (#3A5F7C) — Secondary accent
- **Cigarette Orange** (#D4762C) — Warm accent, call-to-action secondary


## Typography

- **Display / Hero:** Special Elite — Weight 700, tight tracking, used for headline impact
- **Body:** Special Elite — Weight 400, 16px/1.6 line-height, max 72ch per line
- **UI Labels / Captions:** Special Elite — 0.875rem, weight 500, slight letter-spacing
- **Monospace:** JetBrains Mono — Used for code, metadata, and technical values

Scale:
- Hero: clamp(2.5rem, 5vw, 4rem)
- H1: 2.25rem
- H2: 1.5rem
- Body: 1rem / 1.6
- Small: 0.875rem


## Layout

- **Grid:** CSS Grid primary. Max-width containment: 1280px centered with 1.5rem side padding.
- **Spacing rhythm:** Balanced. Base unit: 0.5rem (8px).
- **Section vertical gaps:** clamp(4rem, 8vw, 8rem).
- **Hero layout:** Asymmetric composition.
- **Feature sections:** Asymmetric grid with varied card sizes. No 3-equal-columns.
- **Mobile collapse:** All multi-column layouts collapse below 768px. No horizontal overflow.
- **z-index contract:** base (0) / sticky-nav (100) / overlay (200) / modal (300) / toast (500).


## Elevation & Depth

Venetian blind shadow overlays, rain streak animations, film grain texture, spotlight cones, dramatic vignette borders, typewriter text animation, foggy background layers, high-contrast black and white photography style

- **Physics:** Spring — stiffness 120, damping 20. Confident, weighted transitions.
- **Entry animations:** Fade + translate-Y (16px → 0) over 540ms ease-out. Staggered cascades for lists: 120ms between items.
- **Hover states:** Scale(1.03) + shadow lift over 200ms.
- **Page transitions:** Fade + slide (300ms).
- **Performance:** Only transform and opacity animated. No layout-triggering properties.


## Shapes

Base corner radius: 8px. See rounded tokens in front matter for the full scale.


## Components

- **Primary Button:** Subtly rounded (0.5rem) shape. Accent color fill. Hover: 8% darken + subtle lift shadow. Active: -1px translate tactile press. Font weight 600. No outer glows.
- **Secondary / Ghost Button:** Outline variant. 1.5px border in muted color. Text in primary color. Hover: subtle background fill.
- **Cards:** Subtly rounded (0.5rem) corners. Surface background. Subtle shadow (0 2px 12px rgba(0,0,0,0.06)). 1px border stroke.
- **Inputs:** Label above input. 1px border stroke. Focus ring: 2px accent color offset 2px. Error text below in semantic red. No floating labels.
- **Navigation:** Primary surface background. Active item: accent color indicator. Font weight 500 when active.
- **Skeletons:** Shimmer animation matching component dimensions. No circular spinners.
- **Empty States:** Icon-based composition with descriptive text and action button.


## Do's and Don'ts

- No emojis in UI — use icon system only (Lucide, Heroicons)
- No pure black (#000000) — use off-black or charcoal variants
- No oversaturated accent colors (saturation cap: 80%)
- No 3-column equal-width feature layouts — use zig-zag or asymmetric grid
- No `h-screen` — use `min-h-[100dvh]`
- No AI copywriting clichés: "Elevate", "Seamless", "Unleash", "Next-Gen"
- No broken external image links — use picsum.photos or inline SVG
- No generic lorem ipsum in demos

- Do Venetian blind shadow overlays
- Do Rain streak animations
- Do Film grain texture
- Do Spotlight cones
- Do Dramatic vignette borders
- Do Typewriter text animation


## Use Case

Landing pages, SaaS

<!-- Source: https://designmd.app/library/noir-detetive · designmd.app -->
