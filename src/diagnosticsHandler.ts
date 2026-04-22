import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node";
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

  constructor(connection: Connection) {
    this.connection = connection;
    this.service = getLanguageService();
    this.schemaUri = null;
  }

  /** Registers an XSD schema so subsequent validations use it. */
  async registerSchema(info: SchemaInfo): Promise<void> {
    await this.service.registerSchema(info);
    this.schemaUri = info.uri;
  }

  /**
   * Validates the document against the registered schema and pushes diagnostics
   * to the client. Does nothing when no schema has been registered yet.
   */
  async validateAndSend(document: TextDocument): Promise<void> {
    if (!this.schemaUri) return;

    const xmlDoc = this.service.parseXMLDocument(
      document.uri,
      document.getText()
    );
    const raw = await this.service.validate(this.schemaUri, xmlDoc);

    const diagnostics: Diagnostic[] = raw.map((d) => ({
      range: d.range,
      message: d.message,
      severity: SEVERITY_MAP[d.severity],
      source: "xml-language-service",
    }));

    this.connection.sendDiagnostics({ uri: document.uri, diagnostics });
  }

  /** Clears all diagnostics for the given document URI. */
  clearDiagnostics(uri: string): void {
    this.connection.sendDiagnostics({ uri, diagnostics: [] });
  }
}
