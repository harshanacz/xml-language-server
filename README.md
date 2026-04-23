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
```


## Related

- [`xml-language-service`](https://github.com/harshanacz/xml-language-service) — core library
- `xml-language-server` — this package 
