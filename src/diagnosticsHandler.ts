import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getLanguageService, SchemaInfo } from "xml-language-service";
import * as fs from "fs";
import * as path from "path";

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
    const documentPath = document.uri.startsWith("file://")
      ? decodeURIComponent(document.uri.replace("file://", ""))
      : undefined;
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
    const resolved = this.service.resolveSchemaForDocument(fileName, xmlns, documentPath);
    if (resolved) {
      const autoUri = `auto://${documentPath ?? fileName}`;
      if (!this.service.hasSchema(autoUri)) {
        const imports = resolved.xsdPath ? this.loadSiblingXsds(resolved.xsdPath) : undefined;
        const importKeys = imports ? Object.keys(imports) : [];
        this.connection.console.log(
          `[DiagnosticsHandler] Auto-registering schema for ${fileName}: ${importKeys.length} import files (${importKeys.filter(k => k.includes("/")).length} in subdirs)`
        );
        await this.service.registerSchema({
          uri: autoUri,
          xsdText: resolved.xsdText,
          imports,
        });
        this.connection.console.log(
          `[DiagnosticsHandler] Schema registered at ${autoUri}`
        );
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

  /** Recursively loads all .xsd files under the entry XSD's directory (excluding the entry itself).
   *  Keys are relative paths from that directory (e.g. "misc/common.xsd", "mediators/mediators.xsd").
   *  The WASM bridge registers them as memory:///key, which matches the URIs Xerces computes when
   *  resolving xs:include schemaLocation values relative to memory:///main.xsd. */
  private loadSiblingXsds(entryPath: string): Record<string, string> | undefined {
    try {
      const dir = path.dirname(entryPath);
      const entryName = path.basename(entryPath);
      const imports: Record<string, string> = {};

      const scan = (scanDir: string, relBase: string) => {
        let names: string[];
        try { names = fs.readdirSync(scanDir); } catch { return; }
        for (const name of names) {
          const full = path.join(scanDir, name);
          const rel = relBase ? `${relBase}/${name}` : name;
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              scan(full, rel);
            } else if (
              (name.toLowerCase().endsWith(".xsd") || name.toLowerCase().endsWith(".dtd")) &&
              rel !== entryName
            ) {
              imports[rel] = fs.readFileSync(full, "utf-8");
            }
          } catch {
            // ignore unreadable files or symlink cycles
          }
        }
      };

      scan(dir, "");
      return Object.keys(imports).length > 0 ? imports : undefined;
    } catch {
      return undefined;
    }
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
