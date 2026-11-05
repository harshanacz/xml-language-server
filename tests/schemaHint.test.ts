import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { getLanguageService } from "xml-language-service";
import { findLocalSchemaHint } from "../src/schemaHint.js";
import { makeTempDir, writeFile } from "./helpers/diagnosticsTestUtils.js";

const service = getLanguageService();
const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const XSD = "<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'/>";

const hint = (xml: string, documentPath: string | undefined) =>
  findLocalSchemaHint(service.parseXMLDocument("file:///doc.xml", xml), documentPath);
const withNoNs = (location: string) => `<r ${XSI} xsi:noNamespaceSchemaLocation="${location}"/>`;

describe("findLocalSchemaHint", () => {
  it("resolves a relative path against the document directory", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "s.xsd"), XSD);
    expect(hint(withNoNs("s.xsd"), path.join(dir, "doc.xml"))).toEqual({ xsdPath: path.join(dir, "s.xsd"), xsdText: XSD });
  });

  it("accepts an absolute path", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "s.xsd"), XSD);
    expect(hint(withNoNs(path.join(dir, "s.xsd")), "/elsewhere/doc.xml")?.xsdPath).toBe(path.join(dir, "s.xsd"));
  });

  it("accepts a file:// URL", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "my schema.xsd"), XSD);
    expect(hint(withNoNs(pathToFileURL(path.join(dir, "my schema.xsd")).href), undefined)?.xsdPath).toBe(path.join(dir, "my schema.xsd"));
  });

  it("needs a document path to resolve relative locations", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "s.xsd"), XSD);
    expect(hint(withNoNs("s.xsd"), undefined)).toBeUndefined();
  });

  it("ignores http(s), ftp and other schemes", () => {
    for (const location of ["http://x/s.xsd", "https://x/s.xsd", "ftp://x/s.xsd", "urn:x:s.xsd"]) {
      expect(hint(withNoNs(location), "/d/doc.xml")).toBeUndefined();
    }
  });

  it("ignores locations that are not .xsd files", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "notes.txt"), "x");
    writeFile(path.join(dir, "s.dtd"), "x");
    expect(hint(withNoNs("notes.txt"), path.join(dir, "d.xml"))).toBeUndefined();
    expect(hint(withNoNs("s.dtd"), path.join(dir, "d.xml"))).toBeUndefined();
  });

  it("ignores a directory named like a schema", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "dir.xsd"));
    expect(hint(withNoNs("dir.xsd"), path.join(dir, "d.xml"))).toBeUndefined();
  });

  it("ignores schemas larger than the size limit", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "big.xsd"), "x".repeat(2 * 1024 * 1024 + 1));
    expect(hint(withNoNs("big.xsd"), path.join(dir, "d.xml"))).toBeUndefined();
  });

  it("returns undefined for a missing file", () => {
    expect(hint(withNoNs("missing.xsd"), "/definitely/not/doc.xml")).toBeUndefined();
  });

  it("returns undefined when the document has no hint, no root, or is empty", () => {
    expect(hint("<root/>", "/d/doc.xml")).toBeUndefined();
    expect(hint("", "/d/doc.xml")).toBeUndefined();
    expect(hint("not xml at all", "/d/doc.xml")).toBeUndefined();
  });

  it("returns undefined for an empty or whitespace-only location", () => {
    expect(hint(withNoNs(""), "/d/doc.xml")).toBeUndefined();
    expect(hint(withNoNs("   "), "/d/doc.xml")).toBeUndefined();
  });

  it("ignores a dangling token in xsi:schemaLocation", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "s.xsd"), XSD);
    const xml = `<r ${XSI} xsi:schemaLocation="urn:only-a-namespace"/>`;
    expect(hint(xml, path.join(dir, "d.xml"))).toBeUndefined();
  });

  it("prefers the pair matching the root's default namespace", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "a.xsd"), "<a/>");
    writeFile(path.join(dir, "b.xsd"), "<b/>");
    const xml = `<r xmlns="urn:b" ${XSI} xsi:schemaLocation="urn:a a.xsd urn:b b.xsd"/>`;
    expect(hint(xml, path.join(dir, "d.xml"))?.xsdText).toBe("<b/>");
  });

  it("falls back to other pairs when the matching one is missing", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "a.xsd"), "<a/>");
    const xml = `<r xmlns="urn:b" ${XSI} xsi:schemaLocation="urn:a a.xsd urn:b gone.xsd"/>`;
    expect(hint(xml, path.join(dir, "d.xml"))?.xsdText).toBe("<a/>");
  });

  it("supports a differently named xsi prefix and ignores the literal xsi when it is not bound", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "s.xsd"), XSD);
    const docPath = path.join(dir, "d.xml");
    expect(hint(`<r xmlns:x="http://www.w3.org/2001/XMLSchema-instance" x:noNamespaceSchemaLocation="s.xsd"/>`, docPath)).toBeDefined();
    // Bound to a different prefix, so "xsi:" here is not the schema-instance namespace.
    expect(hint(`<r xmlns:x="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="s.xsd"/>`, docPath)).toBeUndefined();
  });

  it("tolerates extra whitespace and newlines in xsi:schemaLocation", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "s.xsd"), XSD);
    const xml = `<r xmlns="urn:a" ${XSI} xsi:schemaLocation="\n   urn:a\n   s.xsd  "/>`;
    expect(hint(xml, path.join(dir, "d.xml"))?.xsdPath).toBe(path.join(dir, "s.xsd"));
  });

  it("only reads hints from the root element", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "s.xsd"), XSD);
    const xml = `<r><child ${XSI} xsi:noNamespaceSchemaLocation="s.xsd"/></r>`;
    expect(hint(xml, path.join(dir, "d.xml"))).toBeUndefined();
  });
});
