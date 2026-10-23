# Sulfur and Phosphorus: where the code divides

Sulfur runs in two places: inside the Phosphorus desktop (a window of the web desktop) and
on its own (its desktop app, or `/sulfur/` on any Phosphorus host). One codebase serves
both. The two sides meet at a single, written boundary.

```
web/
  style.css            cascade order only: @imports of the parts below
  src/
    app.js, apps/      Phosphorus: the desktop and its apps
    css/               Phosphorus's styles (desktop, shared looks, bar layout)
    sulfur/            Sulfur: workbench.js, editor.js, its language, build and
                       navigation modules, host.js (its own host), main.js (its entry),
                       workbench.css and looks.css
    host/
      contract.js      the boundary: every name Sulfur may take from its host
      desktop.js       the Phosphorus desktop as Sulfur's host (re-exports app.js)
    lezer.js, md.js, theme.js, highlight-ranges.js, text-operations.js, …
                       shared libraries, belonging to neither side
```

## The rule

Sulfur's code, and the components it shares with the desktop (`apps/terminal.js`), import
their host only as `'#host'`, and only the names listed in `src/host/contract.js`. The
build binds `'#host'` per page (`cmd/webbuild`):

| page                 | `'#host'` resolves to   | what it is                                    |
|----------------------|-------------------------|-----------------------------------------------|
| `index.html`         | `src/host/desktop.js`   | the desktop's own state and helpers            |
| `sulfur/index.html`  | `src/sulfur/host.js`    | this computer offline, plus a remembered mesh  |

The desktop reaches Sulfur in one way only: it loads `sulfur/workbench.js` when its Sulfur
window opens (`ideStart`).

`web/tests/host-boundary.test.mjs` enforces this. Both hosts must export every name in the
contract, and Sulfur's import graph must not reach `app.js` or the desktop's apps. The
desktop's graph must not statically reach `sulfur/`.

## Adding something Sulfur needs from its host

1. Add the name, with a one-line description, to `src/host/contract.js`.
2. Export it from `app.js` and list it in `src/host/desktop.js`.
3. Implement it in `src/sulfur/host.js`, offline first: Sulfur on its own must work with no
   mesh at all.
4. Run `node --test web/tests/*.test.mjs`.

## Working offline

Sulfur on its own needs no mesh. Its Go server (`cmd/sulfur`) answers the same APIs for this
computer that a mesh host does: files, live editing sessions, terminals, toolchains,
language servers, git and build/run tasks. A remembered mesh adds its machines under
`/api/mesh/`, beside this computer and never instead of it. Only the chat's agents and AI
completions need a mesh, for its models.

## Styles

`web/style.css` imports the parts in cascade order. Sulfur's rules live in
`src/sulfur/workbench.css` (editor and workbench) and `src/sulfur/looks.css` (Sulfur under the
macOS, Windows 11 and cli looks). Colors come from the theme library's `--ide-*` and `--hl-*`
tokens in `internal/theme/themes.json`.
