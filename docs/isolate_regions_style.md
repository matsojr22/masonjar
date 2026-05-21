# Isolate Regions — region picker style guide

## Grouping level

Parent-area colors use a fixed CCF depth: **`GROUP_STYLE_LEVEL = 6`** (major area, e.g. VIS, SS, AUD, RSP). Implemented in [`js/atlas_region_style.js`](../js/atlas_region_style.js). Changing this constant is a product decision, not per-user.

For each structure row, `groupParentForRegion()` walks `id_path` and picks the ancestor at level 6; if none exists, the nearest shallower ancestor is used.

## Color source

The swatch and row tint use the group parent’s Allen **`color_hex_triplet`** from [`csv/structure_graph.json`](../csv/structure_graph.json). Colors are not assigned randomly per session.

## List rows

| Element | Rule |
|---------|------|
| Row | `border-left: 4px solid` group color (darkened if luminance > 0.72) |
| Background | `color-mix(in srgb, {groupColor} 12%, var(--mj-surface))` |
| Acronym | Small swatch before label |

Layer structures at fine depth inherit the **same** group parent tint as their area parent (e.g. `VISp2/3` matches the VIS family).

## Legend

Shows distinct group parents among **visible** available + selected rows. Search and depth filters change visibility only, not colors.

## Theme

Do not recolor Mason Jar primary/secondary buttons. Tinting applies only to the region picker lists and legend on [`pages/intensity_wizard.html`](../pages/intensity_wizard.html).

## Extension

To support custom ontologies, load a different graph JSON and rebuild [`js/structure_catalog.js`](../js/structure_catalog.js); keep `GROUP_STYLE_LEVEL` documented here.
