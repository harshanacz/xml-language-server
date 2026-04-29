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

  constructor(connection: Connection, service: LanguageService) {
    this.connection = connection;
    this.service = service;
    this.schemaUri = null;
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
      this.connection.sendDiagnostics({ uri: document.uri, diagnostics: this.toDiagnostics(raw) });
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
      this.connection.sendDiagnostics({ uri: document.uri, diagnostics: this.toDiagnostics(raw) });
      return;
    }

    // No schema found — clear any stale diagnostics.
    this.connection.console.log(
      `[DiagnosticsHandler] No schema for ${document.uri}, clearing diagnostics`
    );
    this.connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  }

  /** Clears all diagnostics for the given document URI. */
  clearDiagnostics(uri: string): void {
    this.connection.console.log(`[DiagnosticsHandler] Clearing diagnostics for ${uri}`);
    this.connection.sendDiagnostics({ uri, diagnostics: [] });
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
