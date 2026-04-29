import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getLanguageService, SchemaInfo } from "xml-language-service";

type LanguageService = ReturnType<typeof getLanguageService>;

const SEVERITY_MAP: Record<"error" | "warning" | "info", DiagnosticSeverity> =
  {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    info: DiagnosticSeverity.Information,
  };

export class DiagnosticsHandler {
  private connection: Connection;
  private service: LanguageService;
  private schemaUri: string | null;
  private diagnosticsByUri = new Map<string, Diagnostic[]>();

  constructor(connection: Connection, service: LanguageService) {
    this.connection = connection;
    this.service = service;
    this.schemaUri = null;
  }

  /** Returns all diagnostics at the given position for a document. */
  getDiagnosticsAt(uri: string, line: number, character: number): Diagnostic[] {
    const all = this.diagnosticsByUri.get(uri) ?? [];
    return all.filter((d) => {
      const { start, end } = d.range;
      if (line < start.line || line > end.line) return false;
      if (line === start.line && character < start.character) return false;
      if (line === end.line && character > end.character) return false;
      return true;
    });
  }

  /** Registers an XSD schema so subsequent validations use it. Manual schemas take priority over auto-resolved ones. */
  async registerSchema(info: SchemaInfo): Promise<void> {
    this.connection.console.log(`[DiagnosticsHandler] Registering schema: ${info.uri}`);
    await this.service.registerSchema(info);
    this.schemaUri = info.uri;
  }

  async validateAndSend(document: TextDocument): Promise<void> {
    const fileName = document.uri.split("/").pop() ?? "";
    const text = document.getText();
    const xmlDoc = this.service.parseXMLDocument(document.uri, text);
    const xmlns = (xmlDoc as any).getNamespace?.() ?? undefined;

    // Manual schema takes priority over auto-resolution.
    if (this.schemaUri) {
      this.connection.console.log(
        `[DiagnosticsHandler] Validating ${document.uri} against manual schema ${this.schemaUri}`
      );
      const raw = await this.service.validate(this.schemaUri, xmlDoc);
      this.send(document.uri, this.toDiagnostics(raw));
      return;
    }

    // Auto-resolve schema by file name / namespace.
    const resolved = this.service.resolveSchemaForDocument(fileName, xmlns);
    if (resolved) {
      const autoUri = `auto://${fileName}`;
      if (!this.service.hasSchema(autoUri)) {
        this.connection.console.log(
          `[DiagnosticsHandler] Auto-registering schema for ${fileName}`
        );
        await this.service.registerSchema({ uri: autoUri, xsdText: resolved.xsdText });
      }
      this.connection.console.log(
        `[DiagnosticsHandler] Validating ${document.uri} against auto schema`
      );
      const raw = await this.service.validate(autoUri, xmlDoc);
      this.send(document.uri, this.toDiagnostics(raw));
      return;
    }

    // No schema found — clear any stale diagnostics.
    this.connection.console.log(
      `[DiagnosticsHandler] No schema for ${document.uri}, clearing diagnostics`
    );
    this.send(document.uri, []);
  }

  /** Clears all diagnostics for the given document URI. */
  clearDiagnostics(uri: string): void {
    this.connection.console.log(`[DiagnosticsHandler] Clearing diagnostics for ${uri}`);
    this.send(uri, []);
  }

  private send(uri: string, diagnostics: Diagnostic[]): void {
    this.diagnosticsByUri.set(uri, diagnostics);
    this.connection.sendDiagnostics({ uri, diagnostics });
  }

  private toDiagnostics(raw: Awaited<ReturnType<LanguageService["validate"]>>): Diagnostic[] {
    return raw.map((d) => ({
      range: d.range,
      message: d.message,
      severity: SEVERITY_MAP[d.severity],
      source: "xml-language-service",
    }));
  }
}
