import { describe, expect, it } from "vitest";
import * as path from "path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getLanguageService } from "xml-language-service";
import { DiagnosticsHandler } from "../src/diagnosticsHandler.js";
import { createConnection, makeTempDir, writeFile } from "./helpers/diagnosticsTestUtils.js";

const BOOKS_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="library">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="book" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence><xs:element name="year" type="xs:integer"/></xs:sequence>
            <xs:attribute name="id" type="xs:string" use="required"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const invalidBody = `<book><year>abc</year></book>`;

async function validate(dir: string, relativeFile: string, xml: string, configure?: (s: ReturnType<typeof getLanguageService>) => void) {
  const { connection, sentDiagnostics } = createConnection();
  const service = getLanguageService();
  configure?.(service);
  const handler = new DiagnosticsHandler(connection as any, service);
  const documentPath = path.join(dir, relativeFile);
  await handler.validateAndSend(TextDocument.create(`file://${documentPath}`, "xml", 1, xml));
  const messages: string[] = ((sentDiagnostics.at(-1) as any)?.diagnostics ?? []).map((d: any) => d.message);
  return messages;
}

describe("DiagnosticsHandler local xsi schema location", () => {
  it("validates against a relative xsi:noNamespaceSchemaLocation", async () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "books.xsd"), BOOKS_XSD);
    const messages = await validate(dir, "doc.xml", `<library ${XSI} xsi:noNamespaceSchemaLocation="books.xsd">${invalidBody}</library>`);
    expect(messages.some((m) => m.includes("missing required attribute 'id'"))).toBe(true);
    expect(messages.some((m) => m.includes("'abc'"))).toBe(true);
  });

  it("resolves locations in a sub-directory and parent directory", async () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "schemas", "books.xsd"), BOOKS_XSD);
    const down = await validate(dir, "doc.xml", `<library ${XSI} xsi:noNamespaceSchemaLocation="schemas/books.xsd">${invalidBody}</library>`);
    const up = await validate(dir, "nested/doc.xml", `<library ${XSI} xsi:noNamespaceSchemaLocation="../schemas/books.xsd">${invalidBody}</library>`);
    expect(down.length).toBeGreaterThan(0);
    expect(up.length).toBeGreaterThan(0);
  });

  it("reports no errors for a valid document", async () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "books.xsd"), BOOKS_XSD);
    const messages = await validate(dir, "doc.xml", `<library ${XSI} xsi:noNamespaceSchemaLocation="books.xsd"><book id="1"><year>1</year></book></library>`);
    expect(messages).toEqual([]);
  });

  it("uses the xsi namespace prefix declared by the document", async () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "books.xsd"), BOOKS_XSD);
    const messages = await validate(dir, "doc.xml", `<library xmlns:x="http://www.w3.org/2001/XMLSchema-instance" x:noNamespaceSchemaLocation="books.xsd">${invalidBody}</library>`);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("validates against a namespaced xsi:schemaLocation pair", async () => {
    const dir = makeTempDir();
    writeFile(
      path.join(dir, "books.xsd"),
      BOOKS_XSD.replace('<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">', '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:lib" xmlns="urn:lib" elementFormDefault="qualified">')
    );
    const messages = await validate(dir, "doc.xml", `<library xmlns="urn:lib" ${XSI} xsi:schemaLocation="urn:lib books.xsd">${invalidBody}</library>`);
    expect(messages.some((m) => m.includes("'abc'"))).toBe(true);
  });

  it("re-registers when the document points at a different schema", async () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "books.xsd"), BOOKS_XSD);
    writeFile(path.join(dir, "lenient.xsd"), BOOKS_XSD.replace('type="xs:integer"', 'type="xs:string"').replace('use="required"', 'use="optional"'));
    const { connection, sentDiagnostics } = createConnection();
    const handler = new DiagnosticsHandler(connection as any, getLanguageService());
    const uri = `file://${path.join(dir, "doc.xml")}`;
    const doc = (xsd: string, version: number) =>
      TextDocument.create(uri, "xml", version, `<library ${XSI} xsi:noNamespaceSchemaLocation="${xsd}">${invalidBody}</library>`);
    await handler.validateAndSend(doc("books.xsd", 1));
    const strict = (sentDiagnostics.at(-1) as any).diagnostics.length;
    await handler.validateAndSend(doc("lenient.xsd", 2));
    const lenient = (sentDiagnostics.at(-1) as any).diagnostics.length;
    expect(strict).toBeGreaterThan(0);
    expect(lenient).toBe(0);
  });

  it("lets a user-configured schema take priority over the document's hint", async () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "books.xsd"), BOOKS_XSD);
    writeFile(path.join(dir, "lenient.xsd"), BOOKS_XSD.replace('type="xs:integer"', 'type="xs:string"').replace('use="required"', 'use="optional"'));
    const messages = await validate(
      dir,
      "doc.xml",
      `<library ${XSI} xsi:noNamespaceSchemaLocation="books.xsd">${invalidBody}</library>`,
      (service) => service.addUserAssociation({ pattern: "doc.xml", xsdPath: path.join(dir, "lenient.xsd"), isBuiltIn: false })
    );
    expect(messages).toEqual([]);
  });

  it("falls back to syntax checking when the referenced file does not exist or is remote", async () => {
    const dir = makeTempDir();
    const missing = await validate(dir, "doc.xml", `<library ${XSI} xsi:noNamespaceSchemaLocation="nope.xsd"><a></b></library>`);
    const remote = await validate(dir, "doc.xml", `<library ${XSI} xsi:noNamespaceSchemaLocation="http://localhost:1/x.xsd"><a></b></library>`);
    expect(missing.some((m) => m.includes("expected end of tag"))).toBe(true);
    expect(remote.some((m) => m.includes("expected end of tag"))).toBe(true);
  });

  it("ignores locations that are not .xsd files", async () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "secret.txt"), "not a schema");
    const messages = await validate(dir, "doc.xml", `<library ${XSI} xsi:noNamespaceSchemaLocation="secret.txt"><a></b></library>`);
    expect(messages.some((m) => m.includes("expected end of tag"))).toBe(true);
  });
});
