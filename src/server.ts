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
  DidChangeConfigurationParams,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs";
import * as path from "path";
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

function getDocumentPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  return decodeURIComponent(uri.replace("file://", ""));
}

function escapeMd(text: string): string {
  return text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

async function validateAndSendSafely(document: TextDocument, reason: string): Promise<void> {
  try {
    await diagnosticsHandler.validateAndSend(document);
  } catch (error) {
    connection.console.error(
      `[diagnostics] Validation failed during ${reason} for ${document.uri}: ${formatError(error)}`
    );
    diagnosticsHandler.clearDiagnostics(document.uri);
  }
}

async function validateOpenDocumentsSafely(reason: string): Promise<void> {
  await Promise.all(documents.all().map((doc) => validateAndSendSafely(doc, reason)));
}

// ── Type adapters ────────────────────────────────────────────────────────────

const COMPLETION_KIND_MAP: Record<XmlCompletionItem["kind"], CompletionItemKind> = {
  element: CompletionItemKind.Class,
  attribute: CompletionItemKind.Property,
  value: CompletionItemKind.Value,
  closeTag: CompletionItemKind.Keyword,
};

const DOCUMENT_SYMBOL_KIND_MAP: Record<XmlDocumentSymbol["kind"], SymbolKind> = {
  namespace: SymbolKind.Namespace,
  class: SymbolKind.Class,
  method: SymbolKind.Method,
  function: SymbolKind.Function,
  property: SymbolKind.Property,
  field: SymbolKind.Field,
  interface: SymbolKind.Interface,
  struct: SymbolKind.Struct,
  array: SymbolKind.Array,
  object: SymbolKind.Object,
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
    kind: DOCUMENT_SYMBOL_KIND_MAP[sym.kind],
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

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoot = params.workspaceFolders?.[0]?.uri.replace("file://", "") ?? null;
  connection.console.log("=== STARTUP WAS TRIGGERED!===");

  const schemas: SchemaConfig[] = (params.initializationOptions as any)?.schemas ?? [];
  if (schemas.length > 0) applySchemaSettings(schemas);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false, triggerCharacters: ['<', ' ', '"', '/'] },
      hoverProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      renameProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentFormattingProvider: true,
      workspace: { workspaceFolders: { supported: true } },
    },
  };
});

connection.onInitialized(async () => {
  try {
    const config = await connection.workspace.getConfiguration('xmlLanguageServer');
    connection.console.log(`[config] Fetched initial config: ${JSON.stringify(config)}`);
    const schemas: SchemaConfig[] = config?.schemas ?? [];
    applySchemaSettings(schemas);
  } catch (e) {
    connection.console.log(`[config] Could not fetch initial config: ${e}`);
  } finally {
    initialConfigurationLoaded = true;
    // Re-validate any documents that opened before schema associations were registered
    // (race condition: onDidChangeContent can fire before getConfiguration resolves).
    await validateOpenDocumentsSafely("initial configuration");
  }
});

// ── Configuration ────────────────────────────────────────────────────────────

interface SchemaConfig {
  pattern: string;
  xsdPath: string;
}

let workspaceRoot: string | null = null;
let initialConfigurationLoaded = false;

function applySchemaSettings(schemas: SchemaConfig[]): void {
  for (const entry of schemas) {
    const resolved = path.isAbsolute(entry.xsdPath)
      ? entry.xsdPath
      : workspaceRoot
        ? path.join(workspaceRoot, entry.xsdPath)
        : null;

    if (!resolved) {
      connection.console.warn(`[config] Cannot resolve relative xsdPath '${entry.xsdPath}' without a workspace root`);
      continue;
    }

    if (!fs.existsSync(resolved)) {
      connection.console.warn(`[config] XSD not found: ${resolved}`);
      continue;
    }

    service.addUserAssociation({ pattern: entry.pattern, xsdPath: resolved, isBuiltIn: false });
    connection.console.log(`[config] Registered schema: ${entry.pattern} → ${resolved}`);
  }
}

connection.onDidChangeConfiguration((params: DidChangeConfigurationParams) => {
  connection.console.log(`[config] onDidChangeConfiguration fired: ${JSON.stringify(params.settings?.xmlLanguageServer)}`);
  const schemas: SchemaConfig[] = params.settings?.xmlLanguageServer?.schemas ?? [];
  service.invalidateAutoSchemas();
  applySchemaSettings(schemas);
  if (!initialConfigurationLoaded) {
    connection.console.log("[config] Deferring configuration-change validation until initial configuration is loaded");
    return;
  }
  void validateOpenDocumentsSafely("configuration change");
});

// ── Request handlers ─────────────────────────────────────────────────────────

/** Returns completion items at the cursor position. */
connection.onCompletion((params: CompletionParams) => {
  connection.console.log(`[onCompletion] Triggered for ${params.textDocument.uri} at line ${params.position.line}, char ${params.position.character}`);
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const fileName = getFileName(params.textDocument.uri);
  const documentPath = getDocumentPath(params.textDocument.uri);
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  return toLSPCompletionList(service.doComplete(xmlDoc, params.position, fileName, documentPath));
});

/** Returns hover information for the symbol under the cursor. */
connection.onHover((params: HoverParams) => {
  connection.console.log(`[onHover] Triggered for ${params.textDocument.uri} at line ${params.position.line}, char ${params.position.character}`);

  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const { line, character } = params.position;

  const errors = diagnosticsHandler.getDiagnosticsAt(document.uri, line, character);
  if (errors.length > 0) {
    const isError = (d: typeof errors[number]) =>
      d.severity === undefined || d.severity === 1;
    const sections = errors.map((d) => {
      const label = isError(d) ? "**ERROR**" : "**WARNING**";
      return `${label} — ${escapeMd(d.message)}`;
    });
    const value = sections.join("\n\n");
    return { contents: { kind: MarkupKind.Markdown, value } };
  }

  const fileName = getFileName(params.textDocument.uri);
  const documentPath = getDocumentPath(params.textDocument.uri);
  const xmlDoc = service.parseXMLDocument(document.uri, document.getText());
  const result = service.doHover(xmlDoc, params.position, fileName, documentPath);
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
  if (!initialConfigurationLoaded) {
    connection.console.log(
      `[onDidChangeContent] Deferring validation for ${change.document.uri} until initial configuration is loaded`
    );
    return;
  }

  connection.console.log(`[onDidChangeContent] Validating ${change.document.uri}`);
  await validateAndSendSafely(change.document, "document change");
});

connection.onShutdown(() => {
  service.dispose();
});

// ── Bootstrap ────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
