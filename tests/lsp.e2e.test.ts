import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LspClient, PublishedDiagnostic, buildServerBundle } from "./helpers/lspServer.js";

const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const BOOKS_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="library">
    <xs:complexType><xs:sequence>
      <xs:element name="book" maxOccurs="unbounded">
        <xs:complexType>
          <xs:sequence><xs:element name="year" type="xs:integer"/></xs:sequence>
          <xs:attribute name="id" type="xs:string" use="required"/>
        </xs:complexType>
      </xs:element>
    </xs:sequence></xs:complexType>
  </xs:element>
</xs:schema>`;
const LENIENT_XSD = BOOKS_XSD.replace('type="xs:integer"', 'type="xs:string"').replace('use="required"', 'use="optional"');
const INVALID_BOOK = "<book><year>abc</year></book>";

let bundleDir: string;
let serverPath: string;
const workspaces: string[] = [];
const clients: LspClient[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xml-ls-e2e-")));
  workspaces.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

async function start(ws: string, options: { configuration?: unknown; initializationOptions?: unknown } = {}) {
  const client = new LspClient(serverPath, options.configuration ?? {});
  clients.push(client);
  const init = await client.initialize(ws, options.initializationOptions ?? {});
  return { client, init };
}

/** Every published diagnostic must be valid LSP: finite, non-negative integer positions and ordered ranges. */
function expectValidDiagnostics(diagnostics: PublishedDiagnostic[]): void {
  for (const d of diagnostics) {
    const { start, end } = d.range;
    for (const n of [start.line, start.character, end.line, end.character]) {
      expect(Number.isInteger(n) && n >= 0, `bad position in "${d.message}": ${JSON.stringify(d.range)}`).toBe(true);
    }
    expect(end.line > start.line || (end.line === start.line && end.character >= start.character)).toBe(true);
    expect(typeof d.message).toBe("string");
  }
}

async function diagnose(client: LspClient, ws: string, file: string, text: string): Promise<PublishedDiagnostic[]> {
  const uri = client.open(path.join(ws, file), text);
  const diagnostics = await client.diagnosticsFor(uri);
  expectValidDiagnostics(diagnostics);
  return diagnostics;
}

beforeAll(() => {
  ({ dir: bundleDir, serverPath } = buildServerBundle());
}, 60_000);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.shutdown()));
});

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

describe("LSP lifecycle", () => {
  it("advertises every supported capability", async () => {
    const { init } = await start(workspace());
    expect(Object.keys(init.capabilities)).toEqual(
      expect.arrayContaining([
        "textDocumentSync", "completionProvider", "hoverProvider", "documentSymbolProvider",
        "foldingRangeProvider", "renameProvider", "definitionProvider", "referencesProvider",
        "documentFormattingProvider",
      ])
    );
  });

  it("shuts down cleanly with exit code 0 and nothing on stderr", async () => {
    const { client } = await start(workspace());
    expect(await client.shutdown()).toBe(0);
    expect(client.stderr).toBe("");
  });
});

describe("syntax diagnostics (no schema)", () => {
  it("reports a mismatched end tag with its exact position", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const diagnostics = await diagnose(client, ws, "a.xml", "<root><a></b></root>");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe("expected end of tag 'a' but found 'b'");
    expect(diagnostics[0].range.start).toEqual({ line: 0, character: 11 });
  });

  it("reports undefined entities in text and attributes", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const messages = (await diagnose(client, ws, "a.xml", '<root a="&x;">&foo;&amp;</root>')).map((d) => d.message);
    expect(messages).toEqual(["entity 'x' not found", "entity 'foo' not found"]);
  });

  it("publishes valid positions for an unclosed element (end-of-input error)", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const diagnostics = await diagnose(client, ws, "a.xml", "<root>\n  <unclosed>\n</root>");
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("publishes valid positions for assorted malformed documents", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const inputs = ["", "<", "<root", '<root a="x', "<a/><b/>", "hello", "<!-- open", "<root>&</root>", "\u0000"];
    for (const [i, text] of inputs.entries()) await diagnose(client, ws, `m${i}.xml`, text);
  });

  it("publishes an empty list for a well-formed document", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    expect(await diagnose(client, ws, "a.xml", "<root><child/></root>")).toEqual([]);
  });

  it("re-validates on change: fixing the error clears the diagnostics", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const uri = client.open(path.join(ws, "a.xml"), "<root><a></b></root>");
    expect((await client.diagnosticsFor(uri)).length).toBe(1);
    client.change(uri, "<root><a></a></root>", 2);
    expect(await client.diagnosticsFor(uri, 1)).toEqual([]);
  });

  it("re-validates on change: introducing an error produces diagnostics", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const uri = client.open(path.join(ws, "a.xml"), "<root><a></a></root>");
    expect(await client.diagnosticsFor(uri)).toEqual([]);
    client.change(uri, "<root><a></x></root>", 2);
    expect((await client.diagnosticsFor(uri, 1)).length).toBe(1);
  });
});

describe("schema selection", () => {
  it("validates against a local xsi:noNamespaceSchemaLocation with no configuration", async () => {
    const ws = workspace({ "books.xsd": BOOKS_XSD });
    const { client } = await start(ws);
    const messages = (await diagnose(client, ws, "doc.xml", `<library ${XSI} xsi:noNamespaceSchemaLocation="books.xsd">${INVALID_BOOK}</library>`)).map((d) => d.message);
    expect(messages.some((m) => m.includes("missing required attribute 'id'"))).toBe(true);
    expect(messages.some((m) => m.includes("'abc'"))).toBe(true);
  });

  it("accepts a valid document that declares a local schema", async () => {
    const ws = workspace({ "books.xsd": BOOKS_XSD });
    const { client } = await start(ws);
    const ok = `<library ${XSI} xsi:noNamespaceSchemaLocation="books.xsd"><book id="1"><year>1</year></book></library>`;
    expect(await diagnose(client, ws, "doc.xml", ok)).toEqual([]);
  });

  it("uses schemas from initializationOptions", async () => {
    const ws = workspace({ "books.xsd": BOOKS_XSD });
    const { client } = await start(ws, { initializationOptions: { schemas: [{ pattern: "cfg.xml", xsdPath: "books.xsd" }] } });
    const diagnostics = await diagnose(client, ws, "cfg.xml", `<library>${INVALID_BOOK}</library>`);
    expect(diagnostics.some((d) => d.message.includes("'abc'"))).toBe(true);
  });

  it("uses schemas from the workspace/configuration pull", async () => {
    const ws = workspace({ "books.xsd": BOOKS_XSD });
    const { client } = await start(ws, { configuration: { schemas: [{ pattern: "cfg.xml", xsdPath: "books.xsd" }] } });
    const diagnostics = await diagnose(client, ws, "cfg.xml", `<library>${INVALID_BOOK}</library>`);
    expect(diagnostics.some((d) => d.message.includes("'abc'"))).toBe(true);
  });

  it("offers schema-driven completions for a document with a local xsi hint", async () => {
    const ws = workspace({ "books.xsd": BOOKS_XSD });
    const { client } = await start(ws);
    // <year> never appears in the document, so only the schema can suggest it.
    const text = `<library ${XSI} xsi:noNamespaceSchemaLocation="books.xsd"><book id="1">\n  <\n</book></library>`;
    const uri = client.open(path.join(ws, "doc.xml"), text);
    await client.diagnosticsFor(uri);
    const list = await client.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 3 } });
    expect(list.items.map((i: any) => i.label)).toContain("year");
  });

  it("offers schema-driven completions for a configured schema", async () => {
    const ws = workspace({ "books.xsd": BOOKS_XSD });
    const { client } = await start(ws, { configuration: { schemas: [{ pattern: "cfg.xml", xsdPath: "books.xsd" }] } });
    const uri = client.open(path.join(ws, "cfg.xml"), `<library><book id="1">\n  <\n</book></library>`);
    await client.diagnosticsFor(uri);
    const list = await client.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 3 } });
    expect(list.items.map((i: any) => i.label)).toContain("year");
  });

  it("lets a configured schema override the document's own hint", async () => {
    const ws = workspace({ "books.xsd": BOOKS_XSD, "lenient.xsd": LENIENT_XSD });
    const { client } = await start(ws, { configuration: { schemas: [{ pattern: "doc.xml", xsdPath: "lenient.xsd" }] } });
    const text = `<library ${XSI} xsi:noNamespaceSchemaLocation="books.xsd">${INVALID_BOOK}</library>`;
    expect(await diagnose(client, ws, "doc.xml", text)).toEqual([]);
  });

  it("falls back to syntax errors when the declared schema is missing", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const text = `<library ${XSI} xsi:noNamespaceSchemaLocation="gone.xsd"><a></b></library>`;
    const diagnostics = await diagnose(client, ws, "doc.xml", text);
    expect(diagnostics.some((d) => d.message.startsWith("expected end of tag"))).toBe(true);
  });

  it("validates pom.xml against the built-in Maven schema", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const pom = '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><bogus/></project>';
    const messages = (await diagnose(client, ws, "pom.xml", pom)).map((d) => d.message);
    expect(messages.some((m) => m.includes("bogus"))).toBe(true);
  });
});

describe("language features", () => {
  const xml = '<?xml version="1.0"?>\n<library>\n  <book id="1">\n    <year>2000</year>\n  </book>\n</library>';

  async function open() {
    const ws = workspace();
    const { client } = await start(ws);
    const uri = client.open(path.join(ws, "doc.xml"), xml);
    await client.diagnosticsFor(uri);
    return { client, uri };
  }

  it("hover describes the element under the cursor", async () => {
    const { client, uri } = await open();
    const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: { line: 2, character: 4 } });
    expect(hover.contents.value).toContain("book");
  });

  it("completion offers element names inside the root", async () => {
    const { client, uri } = await open();
    const list = await client.request("textDocument/completion", { textDocument: { uri }, position: { line: 2, character: 0 } });
    expect(Array.isArray(list.items)).toBe(true);
  });

  it("document symbols form a tree rooted at <library>", async () => {
    const { client, uri } = await open();
    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
    expect(symbols[0].name).toBe("library");
    expect(symbols[0].children.length).toBeGreaterThan(0);
  });

  it("folding ranges cover multi-line elements", async () => {
    const { client, uri } = await open();
    const ranges = await client.request("textDocument/foldingRange", { textDocument: { uri } });
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(ranges.every((r: any) => r.endLine > r.startLine)).toBe(true);
  });

  it("formatting returns edits that produce re-indented text", async () => {
    const { client, uri } = await open();
    const edits = await client.request("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 4, insertSpaces: true } });
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[0].newText).toContain("    <book");
  });

  it("rename edits the start and end tag", async () => {
    const { client, uri } = await open();
    const edit = await client.request("textDocument/rename", { textDocument: { uri }, position: { line: 2, character: 4 }, newName: "volume" });
    const edits = edit.changes[uri];
    expect(edits).toHaveLength(2);
    expect(edits.every((e: any) => e.newText === "volume")).toBe(true);
  });

  it("references and definition return locations in the same document", async () => {
    const { client, uri } = await open();
    const refs = await client.request("textDocument/references", {
      textDocument: { uri }, position: { line: 2, character: 4 }, context: { includeDeclaration: true },
    });
    expect(refs.every((r: any) => r.uri === uri)).toBe(true);
    const def = await client.request("textDocument/definition", { textDocument: { uri }, position: { line: 2, character: 4 } });
    expect(def === null || def.uri === uri).toBe(true);
  });

  it("requests for an unopened document return empty results instead of failing", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const uri = client.uri(path.join(ws, "never-opened.xml"));
    const td = { textDocument: { uri } };
    expect(await client.request("textDocument/documentSymbol", td)).toEqual([]);
    expect(await client.request("textDocument/foldingRange", td)).toEqual([]);
    expect(await client.request("textDocument/formatting", { ...td, options: { tabSize: 2, insertSpaces: true } })).toEqual([]);
    expect(await client.request("textDocument/hover", { ...td, position: { line: 0, character: 0 } })).toBeNull();
    expect(await client.request("textDocument/rename", { ...td, position: { line: 0, character: 0 }, newName: "x" })).toBeNull();
  });

  it("stays responsive after handling malformed documents", async () => {
    const ws = workspace();
    const { client } = await start(ws);
    const uri = client.open(path.join(ws, "bad.xml"), "<<<>>> &&& <a");
    await client.diagnosticsFor(uri);
    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
    expect(Array.isArray(symbols)).toBe(true);
    const good = client.open(path.join(ws, "good.xml"), "<root/>");
    expect(await client.diagnosticsFor(good)).toEqual([]);
  });
});
