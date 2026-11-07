import { describe, expect, it } from "vitest";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { CompletionItemKind, MarkupKind, SymbolKind } from "vscode-languageserver/node.js";
import {
  escapeMd,
  formatError,
  getDocumentPath,
  getFileName,
  toLSPCompletionList,
  toLSPDocumentSymbol,
  toLSPFoldingRange,
  toLSPHover,
} from "../src/utils.js";

describe("getFileName", () => {
  it("returns the last path segment", () => {
    expect(getFileName("file:///a/b/pom.xml")).toBe("pom.xml");
  });

  it("returns the whole string when there is no slash", () => {
    expect(getFileName("pom.xml")).toBe("pom.xml");
  });

  it("keeps percent-encoding in the file name", () => {
    expect(getFileName("file:///a/my%20file.xml")).toBe("my%20file.xml");
  });
});

describe("getDocumentPath", () => {
  it("round-trips a path through a file URI on any platform", () => {
    const file = path.join(os.tmpdir(), "my dir", "café.xml");
    expect(getDocumentPath(pathToFileURL(file).href)).toBe(file);
  });

  it.runIf(process.platform !== "win32")("converts file URIs to paths", () => {
    expect(getDocumentPath("file:///a/b/c.xml")).toBe("/a/b/c.xml");
    expect(getDocumentPath("file:///my%20dir/caf%C3%A9.xml")).toBe("/my dir/café.xml");
  });

  it.runIf(process.platform === "win32")("converts Windows drive URIs, including the encoded colon VS Code sends", () => {
    expect(getDocumentPath("file:///C:/Users/me/a.xml")).toBe("C:\\Users\\me\\a.xml");
    expect(getDocumentPath("file:///c%3A/Users/me/a.xml")).toBe("c:\\Users\\me\\a.xml");
  });

  it("does not throw for a file URI that fileURLToPath rejects", () => {
    expect(() => getDocumentPath("file://some-host/share/a.xml")).not.toThrow();
  });

  it("returns undefined for non-file URIs", () => {
    expect(getDocumentPath("untitled:Untitled-1")).toBeUndefined();
    expect(getDocumentPath("https://example.com/a.xml")).toBeUndefined();
  });
});

describe("escapeMd", () => {
  it("escapes angle brackets and ampersands", () => {
    expect(escapeMd("<a href=\"x\">&</a>")).toBe("&lt;a href=\"x\"&gt;&amp;&lt;/a&gt;");
  });

  it("does not double-escape in a single pass", () => {
    expect(escapeMd("&lt;")).toBe("&amp;lt;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeMd("plain text")).toBe("plain text");
  });
});

describe("formatError", () => {
  it("uses the stack of Error instances", () => {
    expect(formatError(new Error("boom"))).toContain("boom");
  });

  it("falls back to the message when there is no stack", () => {
    const e = new Error("no stack");
    e.stack = undefined;
    expect(formatError(e)).toBe("no stack");
  });

  it("stringifies non-errors", () => {
    expect(formatError("text")).toBe("text");
    expect(formatError(42)).toBe("42");
    expect(formatError(undefined)).toBe("undefined");
  });
});

describe("LSP adapters", () => {
  it("maps every completion kind", () => {
    const list = toLSPCompletionList({
      isIncomplete: true,
      items: (["element", "attribute", "value", "closeTag"] as const).map((kind) => ({ label: kind, kind, insertText: kind + "$0", detail: "d" })),
    } as any);
    expect(list.isIncomplete).toBe(true);
    expect(list.items.map((i) => i.kind)).toEqual([
      CompletionItemKind.Class,
      CompletionItemKind.Property,
      CompletionItemKind.Value,
      CompletionItemKind.Keyword,
    ]);
    expect(list.items[0]).toMatchObject({ label: "element", insertText: "element$0", detail: "d" });
  });

  it("maps document symbols recursively", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
    const symbol = toLSPDocumentSymbol({
      name: "root", kind: "class", range, selectionRange: range,
      children: [{ name: "leaf", kind: "field", range, selectionRange: range, children: [] }],
    } as any);
    expect(symbol.kind).toBe(SymbolKind.Class);
    expect(symbol.children![0]).toMatchObject({ name: "leaf", kind: SymbolKind.Field });
  });

  it("wraps hover text as markdown", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    expect(toLSPHover({ contents: "**hi**", range } as any)).toEqual({
      contents: { kind: MarkupKind.Markdown, value: "**hi**" },
      range,
    });
  });

  it("copies only the folding fields", () => {
    expect(toLSPFoldingRange({ startLine: 1, endLine: 4, kind: "region", extra: true } as any)).toEqual({
      startLine: 1, endLine: 4, kind: "region",
    });
  });
});
