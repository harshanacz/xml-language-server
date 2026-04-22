# xml-language-server

LSP (Language Server Protocol) wrapper around xml-language-service.
Connects any LSP-compatible editor (VS Code, Neovim, etc.) to the XML language features.

## Architecture

```
VS Code / Editor
      ↓ JSON-RPC
xml-language-server   (this package)
      ↓ delegates
xml-language-service  (core library)
      ↓
libxml2-wasm (XSD validation)
```

## Features (via LSP)

- Completion
- Hover
- Document Symbols
- Folding Ranges
- Rename
- Go to Definition
- Find References
- Push Diagnostics (XSD validation on save)

## Project Structure

```
src/
├── server.ts                 ← LSP connection + handlers
├── textDocumentUtils.ts      ← bridge between LSP and xml-language-service
└── diagnosticsHandler.ts     ← push diagnostics to client
```

## Development

```sh
npm run build
npm run test:run
```

## Related

- `xml-language-service` — core library (Phase 01 + 02)
- `xml-language-server` — this package (Phase 03)
- MI Layer — coming Phase 04
