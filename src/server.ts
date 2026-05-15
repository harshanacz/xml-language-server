import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationParams,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getLanguageService } from "xml-language-service";
import { DiagnosticsHandler } from "./diagnosticsHandler.js";
import { SchemaConfig, applySchemaSettings } from "./configuration.js";
import { registerRequestHandlers } from "./requestHandlers.js";
import { formatError } from "./utils.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const service = getLanguageService();
const diagnosticsHandler = new DiagnosticsHandler(connection, service);

let workspaceRoot: string | null = null;
let initialConfigurationLoaded = false;

// ── Validation helpers ───────────────────────────────────────────────────────

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

// ── LSP lifecycle ────────────────────────────────────────────────────────────

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoot = params.workspaceFolders?.[0]?.uri.replace("file://", "") ?? null;
  connection.console.log("=== STARTUP WAS TRIGGERED!===");

  const schemas: SchemaConfig[] = (params.initializationOptions as any)?.schemas ?? [];
  if (schemas.length > 0) applySchemaSettings(schemas, connection, service, workspaceRoot);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false, triggerCharacters: ["<", " ", '"', "/"] },
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
    const config = await connection.workspace.getConfiguration("xmlLanguageServer");
    connection.console.log(`[config] Fetched initial config: ${JSON.stringify(config)}`);
    applySchemaSettings(config?.schemas ?? [], connection, service, workspaceRoot);
  } catch (e) {
    connection.console.log(`[config] Could not fetch initial config: ${e}`);
  } finally {
    initialConfigurationLoaded = true;
    await validateOpenDocumentsSafely("initial configuration");
  }
});

connection.onDidChangeConfiguration((params: DidChangeConfigurationParams) => {
  connection.console.log(
    `[config] onDidChangeConfiguration fired: ${JSON.stringify(params.settings?.xmlLanguageServer)}`
  );
  const schemas: SchemaConfig[] = params.settings?.xmlLanguageServer?.schemas ?? [];
  service.invalidateAutoSchemas();
  applySchemaSettings(schemas, connection, service, workspaceRoot);
  if (!initialConfigurationLoaded) {
    connection.console.log("[config] Deferring configuration-change validation until initial configuration is loaded");
    return;
  }
  void validateOpenDocumentsSafely("configuration change");
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

registerRequestHandlers(connection, documents, service, diagnosticsHandler);
documents.listen(connection);
connection.listen();
