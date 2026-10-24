# Neat CSV - Spreadsheet Editor

English | [简体中文](README.zh-CN.md)

Open large CSV and TSV files quickly in VS Code. Edit in a familiar spreadsheet, or switch to aligned, color-coded text with block editing.

## Features

- Progressive loading for large files.
- Cell editing, range and disconnected selections, clipboard actions, and batch fill.
- Column filters and sorting, pinned rows and columns, drag reordering, and resizing.
- Text mode with column alignment, multiline folding, and multiple cursors.
- Selection statistics, data checks, and find/replace.
- Undo/Redo, Save As, view export, and recovery versions.
- Light/dark themes, English/Simplified Chinese, and guided help.

See the [feature guide and screenshots](MARKETPLACE.md).

## Install and open

Requires desktop VS Code 1.95 or newer. Install the VSIX from `release/` using **Extensions → Install from VSIX…**, then open a CSV or TSV file. Use **Reopen Editor With → Neat CSV** if needed.

## Development

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:ui
npm run package
```

`src/extension.ts` registers the editor; `src/engine/` handles file indexing, queries, edits, and saves; `src/webview/` implements Table and Text modes. Cross-layer messages are in `src/protocol.ts`. Tests are in `tests/`.

The two examples are in `examples/`. Screenshots are in `docs/images/`; `npm run screenshots` refreshes automated captures. Build output goes to `dist/`, VSIX packages to `release/`.

## Marketplace description

`npm run package` uses `MARKETPLACE.md` as the extension's Marketplace overview. [简体中文介绍](MARKETPLACE.zh-CN.md) covers the same features.

## License

Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

The code license does not grant trademark rights to the Neat CSV name or logo. Use your own branding for a separately distributed product.
