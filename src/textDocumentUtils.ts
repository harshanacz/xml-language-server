import { TextDocument } from "vscode-languageserver-textdocument";
import { XMLDocument, getLanguageService } from "xml-language-service";

const service = getLanguageService();

/**
 * Parses a vscode-languageserver TextDocument into an xml-language-service XMLDocument.
 */
export function toXMLDocument(document: TextDocument): XMLDocument {
  return service.parseXMLDocument(document.uri, document.getText());
}

/**
 * Pass-through for LSP position to xml-language-service position.
 * Both use the same { line, character } shape; this function is here for clarity
 * and to give a single migration point if the shapes ever diverge.
 */
export function toXMLPosition(position: {
  line: number;
  character: number;
}): { line: number; character: number } {
  return { line: position.line, character: position.character };
}
