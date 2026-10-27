import { Diagnostic } from "vscode-languageserver/node.js";

/**
 * Reformats raw XSD/Xerces validation messages into clean, user-friendly strings.
 * For example:
 *   "element 'endpoint' is not allowed for content model 'All(inSequence?,outSequence?,faultSequence?,endpoint?)'"
 * -> "Duplicate element 'endpoint' is not allowed (exceeds maxOccurs limit)." (if endpoint is in the content model)
 * -> "Element 'endpoint' is not allowed here. Allowed elements: inSequence, outSequence, faultSequence." (if endpoint is not in model)
 */
export function formatDiagnosticMessage(rawMessage: string): string {
  const contentModelMatch = rawMessage.match(/element '([^']+)' is not allowed for content model '([^']+)'/i);
  if (contentModelMatch) {
    const elementName = contentModelMatch[1];
    const rawContentModel = contentModelMatch[2];

    const isAllModel = /^All\(/i.test(rawContentModel);

    const cleanedElements = rawContentModel
      .replace(/^(?:All|Sequence|Choice)\((.*)\)$/i, "$1")
      .split(/[,|]/)
      .map((s) => s.trim().replace(/[?*+()]/g, ""))
      .filter(Boolean);

    const isDeclaredInModel = cleanedElements.some(
      (name) => name === elementName || name.endsWith(":" + elementName)
    );

    if (isAllModel && isDeclaredInModel) {
      return `Duplicate element '${elementName}' is not allowed (exceeds maxOccurs limit).`;
    } else {
      const allowedStr = cleanedElements.join(", ");
      return allowedStr
        ? `Element '${elementName}' is not allowed here. Allowed elements: ${allowedStr}.`
        : `Element '${elementName}' is not allowed here.`;
    }
  }

  return rawMessage;
}

/**
 * Removes redundant attribute and content-model diagnostics for elements that
 * are already reported as unknown ("no declaration found for element 'X'").
 * Keeping only the single "unknown element" error avoids noisy cascades like:
 *   - "attribute 'name' is not declared for element 'variable'"
 *   - "element 'variable' is not allowed for content model '(...)'"
 */
export function filterDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  // Step 1: collect element names that are outright unknown
  const unknownElements = new Set<string>();
  for (const d of diagnostics) {
    const m = d.message.match(/no declaration found for element '([^']+)'/);
    if (m) unknownElements.add(m[1]);
  }

  // Step 2: drop attribute and content-model noise for those elements
  let filtered = diagnostics;
  if (unknownElements.size > 0) {
    filtered = diagnostics.filter((d) => {
      const msg = d.message;

      // "attribute 'X' is not declared for element 'name'" — redundant when element is unknown
      if (msg.includes("is not declared for element '") && msg.includes("attribute")) {
        const m = msg.match(/is not declared for element '([^']+)'/);
        if (m && unknownElements.has(m[1])) return false;
      }

      // "element 'name' is not allowed for content model '(...)'" — redundant when element is unknown
      if (msg.includes("is not allowed for content model")) {
        const m = msg.match(/element '([^']+)' is not allowed for content model/);
        if (m && unknownElements.has(m[1])) return false;
      }

      return true;
    });
  }

  // Step 3: deduplicate — Xerces can emit the same message twice for the same position
  const seen = new Set<string>();
  return filtered.filter((d) => {
    const key = `${d.message}|${d.range.start.line}|${d.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
