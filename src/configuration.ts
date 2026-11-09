import { Connection } from "vscode-languageserver/node.js";
import { getLanguageService } from "xml-language-service";
import * as fs from "fs";
import * as path from "path";

type LanguageService = ReturnType<typeof getLanguageService>;

export interface SchemaConfig {
  pattern: string;
  xsdPath: string;
}

/**
 * Registers the configured schema associations. With `replace`, the associations from earlier
 * settings and the schemas already registered for documents are dropped first, so removed or
 * edited entries stop applying.
 */
export async function applySchemaSettings(
  schemas: SchemaConfig[],
  connection: Connection,
  service: LanguageService,
  workspaceRoots: string[],
  replace = false
): Promise<void> {
  if (replace) {
    service.clearUserAssociations();
    await service.invalidateAutoSchemas();
  }
  for (const entry of Array.isArray(schemas) ? schemas : []) {
    if (typeof entry?.pattern !== "string" || typeof entry?.xsdPath !== "string") {
      connection.console.warn(`[config] Ignoring schema entry without a string pattern and xsdPath: ${JSON.stringify(entry)}`);
      continue;
    }
    const resolved = resolveXsdPath(entry.xsdPath, workspaceRoots);

    if (!resolved) {
      connection.console.warn(
        `[config] Cannot resolve xsdPath '${entry.xsdPath}' — file not found in any workspace root`
      );
      continue;
    }

    service.addUserAssociation({ pattern: entry.pattern, xsdPath: resolved, isBuiltIn: false });
    connection.console.log(`[config] Registered schema: ${entry.pattern} → ${resolved}`);
  }
}

function resolveXsdPath(xsdPath: string, workspaceRoots: string[]): string | null {
  if (path.isAbsolute(xsdPath)) {
    return fs.existsSync(xsdPath) ? xsdPath : null;
  }
  for (const root of workspaceRoots) {
    const candidate = path.join(root, xsdPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
