import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getLanguageService } from "xml-language-service";

const sampleXml = `<root>\n  <child name="test"/>\n</root>`;
const doc = TextDocument.create("file:///test.xml", "xml", 1, sampleXml);
const service = getLanguageService();

describe("xml-language-service via server bridge", () => {
  it("parseXMLDocument returns a valid XMLDocument", () => {
    const xmlDoc = service.parseXMLDocument(doc.uri, doc.getText());
    expect(xmlDoc).toBeDefined();
    expect(xmlDoc.uri).toBe("file:///test.xml");
  });

  it("doComplete returns a CompletionList", () => {
    const xmlDoc = service.parseXMLDocument(doc.uri, doc.getText());
    const result = service.doComplete(xmlDoc, { line: 0, character: 1 });
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
  });

  it("doHover at (0, 1) returns a result or null without throwing", () => {
    const xmlDoc = service.parseXMLDocument(doc.uri, doc.getText());
    let result: unknown;
    expect(() => {
      result = service.doHover(xmlDoc, { line: 0, character: 1 });
    }).not.toThrow();
    expect(result === null || typeof result === "object").toBe(true);
  });

  it("findDocumentSymbols returns an array", () => {
    const xmlDoc = service.parseXMLDocument(doc.uri, doc.getText());
    const symbols = service.findDocumentSymbols(xmlDoc);
    expect(Array.isArray(symbols)).toBe(true);
  });

  it("getFoldingRanges returns an array", () => {
    const xmlDoc = service.parseXMLDocument(doc.uri, doc.getText());
    const ranges = service.getFoldingRanges(xmlDoc);
    expect(Array.isArray(ranges)).toBe(true);
  });
});
