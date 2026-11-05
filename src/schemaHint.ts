import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getLanguageService } from "xml-language-service";

type XMLDocument = ReturnType<ReturnType<typeof getLanguageService>["parseXMLDocument"]>;

const XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";
const MAX_HINT_SCHEMA_BYTES = 2 * 1024 * 1024;

export interface LocalSchemaHint {
  xsdPath: string;
  xsdText: string;
}

/**
 * Resolves the schema a document points to with xsi:noNamespaceSchemaLocation or
 * xsi:schemaLocation on its root element, when that location is a local .xsd file.
 * Relative locations are resolved against the document's directory.
 * Remote (http/https) locations are ignored here.
 */
export function findLocalSchemaHint(xmlDoc: XMLDocument, documentPath: string | undefined): LocalSchemaHint | undefined {
  const root = xmlDoc.children?.find((node) => node.type === "element");
  if (!root) return undefined;

  const attrs = new Map(root.attributes.map((a) => [a.name, a.value ?? ""]));
  let prefix = "xsi";
  for (const [name, value] of attrs) {
    if (name.startsWith("xmlns:") && value === XSI_NAMESPACE) {
      prefix = name.slice("xmlns:".length);
      break;
    }
  }

  const rootNamespace = attrs.get("xmlns");
  const pairs: { namespace: string; location: string }[] = [];
  const tokens = (attrs.get(`${prefix}:schemaLocation`) ?? "").trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    pairs.push({ namespace: tokens[i], location: tokens[i + 1] });
  }
  const noNamespace = (attrs.get(`${prefix}:noNamespaceSchemaLocation`) ?? "").trim();

  const candidates = [
    ...pairs.filter((p) => p.namespace === rootNamespace).map((p) => p.location),
    ...(noNamespace ? [noNamespace] : []),
    ...pairs.filter((p) => p.namespace !== rootNamespace).map((p) => p.location),
  ];

  for (const location of candidates) {
    const xsdPath = toLocalPath(location, documentPath);
    if (!xsdPath) continue;
    const xsdText = readSchema(xsdPath);
    if (xsdText !== undefined) return { xsdPath, xsdText };
  }
  return undefined;
}

function toLocalPath(location: string, documentPath: string | undefined): string | undefined {
  let resolved: string;
  if (/^file:/i.test(location)) {
    try {
      resolved = fileURLToPath(location);
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(location)) {
    return undefined; // http(s) and other remote schemes
  } else if (path.isAbsolute(location)) {
    resolved = location;
  } else if (documentPath) {
    resolved = path.resolve(path.dirname(documentPath), location);
  } else {
    return undefined;
  }
  return resolved.toLowerCase().endsWith(".xsd") ? resolved : undefined;
}

function readSchema(xsdPath: string): string | undefined {
  try {
    const stat = fs.statSync(xsdPath);
    if (!stat.isFile() || stat.size > MAX_HINT_SCHEMA_BYTES) return undefined;
    return fs.readFileSync(xsdPath, "utf-8");
  } catch {
    return undefined;
  }
}
