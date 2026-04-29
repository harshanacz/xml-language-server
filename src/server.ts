import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionParams,
  HoverParams,
  DocumentSymbolParams,
  FoldingRangeParams,
  DocumentFormattingParams,
  RenameParams,
  DefinitionParams,
  ReferenceParams,
  CompletionItemKind,
  SymbolKind,
  CompletionList as LSPCompletionList,
  DocumentSymbol as LSPDocumentSymbol,
  Hover,
  FoldingRange as LSPFoldingRange,
  MarkupKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  getLanguageService,
  CompletionItem as XmlCompletionItem,
  DocumentSymbol as XmlDocumentSymbol,
  HoverResult,
  FoldingRange as XmlFoldingRange,
} from "xml-language-service";
import { DiagnosticsHandler } from "./diagnosticsHandler.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const service = getLanguageService();
const diagnosticsHandler = new DiagnosticsHandler(connection, service);

function getFileName(uri: string): string {
  const parts = uri.split('/');
  return parts[parts.length - 1];
}

// ── Type adapters ────────────────────────────────────────────────────────────

const COMPLETION_KIND_MAP: Record<XmlCompletionItem["kind"], CompletionItemKind> = {
  element: CompletionItemKind.Class,
  attribute: CompletionItemKind.Property,
  value: CompletionItemKind.Value,
  closeTag: CompletionItemKind.Keyword,
};

function toLSPCompletionList(list: {
  items: XmlCompletionItem[];
  isIncomplete: boolean;
}): LSPCompletionList {
  return {
    isIncomplete: list.isIncomplete,
    items: list.items.map((item) => ({
      label: item.label,
      kind: COMPLETION_KIND_MAP[item.kind],
      insertText: item.insertText,
      detail: item.detail,
    })),
  };
}

function toLSPDocumentSymbol(sym: XmlDocumentSymbol): LSPDocumentSymbol {
  return {
    name: sym.name,
    kind: SymbolKind.Class,
    range: sym.range,
    selectionRange: sym.selectionRange,
    children: sym.children.map(toLSPDocumentSymbol),
  };
}

function toLSPHover(result: HoverResult): Hover {
  return {
    contents: { kind: MarkupKind.Markdown, value: result.contents },
    range: result.range,
  };
}

function toLSPFoldingRange(r: XmlFoldingRange): LSPFoldingRange {
  return { startLine: r.startLine, endLine: r.endLine, kind: r.kind };
}

// ── LSP lifecycle ────────────────────────────────────────────────────────────

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  connection.console.log("=== STARTUP WAS TRIGGERED!===");
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental, 
      completionProvider: { resolveProvider: false
        , triggerCharacters: ['<', ' ', '"', '/']
       },
      hoverProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      renameProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentFormattingProvider: true,
    },
  };
});

// ── Request handlers ─────────────────────────────────────────────────────────

/** Returns completion items at the cursor position. */
connection.onCompletion((params: CompletionParams) => {
  connection.console.log(`[onCompletion] Triggered for ${params.textDocument.uri} at line ${params.position.line}, char ${params.position.character}`);
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const fileName = getFileName(params.textDocument.uri);
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  return toLSPCompletionList(service.doComplete(xmlDoc, params.position, fileName));
});

/** Returns hover information for the symbol under the cursor. */
connection.onHover((params: HoverParams) => {
  connection.console.log(`[onHover] Triggered for ${params.textDocument.uri} at line ${params.position.line}, char ${params.position.character}`);

  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const { line, character } = params.position;

  const errors = diagnosticsHandler.getDiagnosticsAt(document.uri, line, character);
  if (errors.length > 0) {
    const errorMd = errors
      .map((d) => `$(error) **${d.message}**`)
      .join("\n\n");
    return { contents: { kind: MarkupKind.Markdown, value: errorMd } };
  }

  const fileName = getFileName(params.textDocument.uri);
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  const result = service.doHover(xmlDoc, params.position, fileName);
  connection.console.log(`[onHover] Result: ${JSON.stringify(result)}`);
  return result ? toLSPHover(result) : null;
});

/** Returns the outline (document symbols) for the file. */
connection.onDocumentSymbol((params: DocumentSymbolParams) => {
  connection.console.log(`[onDocumentSymbol] Triggered for ${params.textDocument.uri}`);
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  return service.findDocumentSymbols(xmlDoc).map(toLSPDocumentSymbol);
});

/** Returns folding ranges for the file. */
connection.onFoldingRanges((params: FoldingRangeParams) => {
  connection.console.log(`[onFoldingRanges] Triggered for ${params.textDocument.uri}`);
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  return service.getFoldingRanges(xmlDoc).map(toLSPFoldingRange);
});

/** Renames the tag under the cursor and returns the workspace edit. */
connection.onRenameRequest((params: RenameParams) => {
  connection.console.log(`[onRename] Triggered for ${params.textDocument.uri} at line ${params.position.line}, char ${params.position.character} to '${params.newName}'`);
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const uri = document.uri;
  const xmlDoc = service.parseXMLDocument(uri, document.getText());
  const edits = service.doRename(xmlDoc, params.position, params.newName);
  if (!edits) return null;

  const lspEdits = edits.map((e) => ({
    range: {
      start: document.positionAt(e.startOffset),
      end: document.positionAt(e.endOffset),
    },
    newText: e.newText,
  }));

  return { changes: { [uri]: lspEdits } };
});

/** Navigates to the matching tag for the element under the cursor. */
connection.onDefinition((params: DefinitionParams) => {
  connection.console.log(`[onDefinition] Triggered for ${params.textDocument.uri} at line ${params.position.line}, char ${params.position.character}`);
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  const result = service.doDefinition(xmlDoc, params.position);
  if (!result) return null;
  return { uri: result.uri, range: result.range };
});

/** Returns all locations where the element under the cursor is used. */
connection.onReferences((params: ReferenceParams) => {
  connection.console.log(`[onReferences] Triggered for ${params.textDocument.uri} at line ${params.position.line}, char ${params.position.character}`);
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  return service.findReferences(xmlDoc, params.position).map((r) => ({
    uri: r.uri,
    range: r.range,
  }));
});

/** Formats the entire document. */
connection.onDocumentFormatting((params: DocumentFormattingParams) => {
  connection.console.log(`[onDocumentFormatting] Triggered for ${params.textDocument.uri}`);
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  return service.format(xmlDoc, {
    tabSize: params.options.tabSize,
    insertSpaces: params.options.insertSpaces,
  }).map((edit) => ({
    range: {
      start: document.positionAt(edit.startOffset),
      end: document.positionAt(edit.endOffset),
    },
    newText: edit.newText,
  }));
});

documents.onDidChangeContent(async (change) => {
  connection.console.log(`[onDidChangeContent] Validating ${change.document.uri}`);
  await diagnosticsHandler.validateAndSend(change.document);
});

connection.onShutdown(() => {
  service.dispose();
});

// ── Bootstrap ────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
