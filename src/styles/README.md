# Theming

Every colour and size in the interface comes from a CSS custom property (a _design token_)
named `--nexo-*`. Style rules only read tokens. A theme is a list of token values, and changing
the look of Nexo means changing those values, not the rules.

## Where the tokens live

| File                                 | What it defines                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/styles/tokens/_scale.scss`      | Global sizes: fonts, weights, line heights, tracking, spacing, element sizes, corners, lines, motion, opacity and stacking.                                 |
| `src/styles/tokens/_palette.scss`    | The semantic colours of the default dark theme (the website and any template that does not redefine them), with the shadows and the printed report colours. |
| `src/styles/tokens/_components.scss` | One token per area of the workspace (top bar, rail, sidebar, tabs, URL bar, panels…). By default each one points to the palette.                            |
| `src/styles/tokens/_methods.scss`    | The HTTP method colours.                                                                                                                                    |
| `src/styles/templates/*/_theme.scss` | A template's theme: the tokens it redefines. Aurora and Studio share `aurora/_theme.scss`; Canvas has its own.                                              |

## Token families

- **Colours** (`--nexo-color-*`): `bg`, `sunken`, `chrome`, `surface`, `surface-2`, `surface-3`,
  `backdrop`; `border-subtle`, `border`, `border-strong`; `text`, `text-soft`, `text-muted`,
  `text-dim`, `text-faint`; `accent`, `accent-hover`, `accent-strong`, `accent-soft`,
  `accent-border`, `on-accent`; `success`, `info`, `danger`, `warning` and their `-soft` tints;
  `highlight` (the tint of hovers: white on dark themes, dark on light ones); `code-*`,
  `syntax-*`, `data-*` and `scope-*`.
- **Shadows** (`--nexo-shadow-*`): `sm`, `md`, `lg`, `xl`, `up`, `highlight`,
  `highlight-strong`, `accent`, `glow`.
- **Typography**: `--nexo-font-sans`, `--nexo-font-mono`, `--nexo-font-size-body` and the steps
  `--nexo-font-size-3xs` … `6xl` and `display-sm|md|lg`; `--nexo-font-weight-*`,
  `--nexo-line-height-*`, `--nexo-tracking-*`.
- **Spacing**: `--nexo-space-N` is N units of `--nexo-space-unit` (2px), so `--nexo-space-4`
  is 8px. Changing the unit makes the whole interface denser or looser.
- **Element sizes**: `--nexo-size-N` works the same way with `--nexo-size-unit`, for icons,
  controls and dots up to 80px.
- **Corners, lines, motion, layers**: `--nexo-radius-*`, `--nexo-border-width*`,
  `--nexo-focus-ring-*`, `--nexo-duration-*`, `--nexo-opacity-*`, `--nexo-z-*`.
- **Areas**: `--nexo-topbar-bg`, `--nexo-topbar-height`, `--nexo-rail-width`,
  `--nexo-sidebar-width`, `--nexo-url-bar-bg`, `--nexo-panel-bg`, `--nexo-statusbar-bg` and the
  rest in `_components.scss`. A template gives an area a gradient or another size here.
- **HTTP methods**: `--nexo-method-get`, `-post`, `-put`, `-patch`, `-delete`, `-options`,
  `-other`. An element marked with `data-method="POST"` gets `--nexo-method-color` (the method
  colour) and `--nexo-method-ink` (the colour for its text, darkened on light themes by
  `--nexo-method-ink-shade`).

## Overriding tokens

All the token declarations are in the cascade layer `nexo-tokens`. A stylesheet outside that
layer always wins over it, whatever its selector, so an override does not need `!important` or
a more specific selector:

```css
/* Every template */
.studio {
  --nexo-color-accent: #2f81f7;
  --nexo-method-post: #ffb86b;
  --nexo-space-unit: 2.5px; /* a looser interface */
}

/* Only Canvas */
.studio[data-template='canvas'] {
  --nexo-sidebar-width: 340px;
}
```

Write overrides on `.studio`, not on `:root`. The templates declare their tokens on `.studio`,
so a value set on `:root` is hidden by the template's own. The derived tokens (tints, shadows,
spacing steps) are declared on `.studio` too, so they follow an overridden base token.

Nexo does not load user stylesheets yet. These tokens are the contract that a custom theme
will use.

## Adding or changing styles

- Use tokens only. `npm run test:architecture` runs `tools/check-style-tokens.mjs`, which fails on
  a literal colour (hex, `rgb()`, `hsl()`, `white`, `black`) and on raw values in the font,
  spacing, corner, line, shadow, motion, opacity and stacking properties outside the token files.
  Layout constraints such as a dialog width or a list's maximum height may stay in px.
- For a tint of a token, use `color-mix(in srgb, var(--nexo-color-…) N%, transparent)`.
- A new colour belongs in the palette when it has a meaning shared across the interface, and in
  `_components.scss` when it belongs to one area. Give it a value in every theme where the
  default does not fit.
- A new template adds a `_theme.scss` with only token declarations, inside
  `@layer nexo-tokens`, and loads it first from its `_index.scss`.
