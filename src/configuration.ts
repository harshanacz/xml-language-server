import { Connection } from "vscode-languageserver/node.js";
import { getLanguageService } from "xml-language-service";
import * as fs from "fs";
import * as path from "path";

type LanguageService = ReturnType<typeof getLanguageService>;

export interface SchemaConfig {
  pattern: string;
  xsdPath: string;
}

export function applySchemaSettings(
  schemas: SchemaConfig[],
  connection: Connection,
  service: LanguageService,
  workspaceRoot: string | null
): void {
  for (const entry of schemas) {
    const resolved = path.isAbsolute(entry.xsdPath)
      ? entry.xsdPath
      : workspaceRoot
        ? path.join(workspaceRoot, entry.xsdPath)
        : null;

    if (!resolved) {
      connection.console.warn(
        `[config] Cannot resolve relative xsdPath '${entry.xsdPath}' without a workspace root`
      );
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
