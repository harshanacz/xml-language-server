import { describe, expect, it } from "vitest";
import { Diagnostic } from "vscode-languageserver/node.js";
import { filterDiagnostics, formatDiagnosticMessage } from "../src/diagnosticsFilter.js";

const diag = (message: string, line = 0, character = 0): Diagnostic => ({
  message,
  range: { start: { line, character }, end: { line, character: character + 1 } },
});

describe("formatDiagnosticMessage", () => {
  it("lists allowed elements for an element that is not in the content model", () => {
    expect(formatDiagnosticMessage("element 'x' is not allowed for content model 'Sequence(a,b?,c*)'")).toBe(
      "Element 'x' is not allowed here. Allowed elements: a, b, c."
    );
  });

  it("reports a duplicate when an 'All' model already contains the element", () => {
    expect(formatDiagnosticMessage("element 'a' is not allowed for content model 'All(a?,b?)'")).toBe(
      "Duplicate element 'a' is not allowed (exceeds maxOccurs limit)."
    );
  });

  it("does not call it a duplicate for Sequence or Choice models", () => {
    expect(formatDiagnosticMessage("element 'a' is not allowed for content model 'Sequence(a,b)'")).toContain("not allowed here");
    expect(formatDiagnosticMessage("element 'a' is not allowed for content model 'Choice(a|b)'")).toContain("not allowed here");
  });

  it("splits choice alternatives", () => {
    expect(formatDiagnosticMessage("element 'z' is not allowed for content model 'Choice(a|b)'")).toContain("Allowed elements: a, b.");
  });

  it("matches prefixed names in an 'All' model", () => {
    expect(formatDiagnosticMessage("element 'a' is not allowed for content model 'All(ns:a?,b?)'")).toContain("Duplicate");
  });

  it("omits the allowed list when the model is empty", () => {
    expect(formatDiagnosticMessage("element 'x' is not allowed for content model 'Sequence()'")).toBe("Element 'x' is not allowed here.");
  });

  it("is case-insensitive about the model keyword", () => {
    expect(formatDiagnosticMessage("element 'a' is not allowed for content model 'all(a?)'")).toContain("Duplicate");
  });

  it("returns other messages unchanged", () => {
    for (const message of ["missing required attribute 'id'", "", "entity 'x' not found"]) {
      expect(formatDiagnosticMessage(message)).toBe(message);
    }
  });
});

describe("filterDiagnostics", () => {
  it("keeps the unknown-element error and drops cascading attribute errors", () => {
    const result = filterDiagnostics([
      diag("no declaration found for element 'foo'"),
      diag("attribute 'name' is not declared for element 'foo'", 0, 5),
    ]);
    expect(result.map((d) => d.message)).toEqual(["no declaration found for element 'foo'"]);
  });

  it("drops content-model errors for unknown elements", () => {
    const result = filterDiagnostics([
      diag("no declaration found for element 'foo'"),
      diag("element 'foo' is not allowed for content model 'Sequence(a)'", 0, 9),
    ]);
    expect(result).toHaveLength(1);
  });

  it("keeps errors about other elements", () => {
    const result = filterDiagnostics([
      diag("no declaration found for element 'foo'"),
      diag("attribute 'id' is not declared for element 'bar'", 1),
      diag("element 'bar' is not allowed for content model 'Sequence(a)'", 2),
    ]);
    expect(result).toHaveLength(3);
  });

  it("does not filter anything when there are no unknown elements", () => {
    const input = [diag("attribute 'x' is not declared for element 'a'"), diag("something else", 3)];
    expect(filterDiagnostics(input)).toEqual(input);
  });

  it("removes exact duplicates at the same position but keeps the same message elsewhere", () => {
    const result = filterDiagnostics([diag("boom", 1, 1), diag("boom", 1, 1), diag("boom", 2, 1), diag("boom", 1, 2)]);
    expect(result).toHaveLength(3);
  });

  it("handles an empty list", () => {
    expect(filterDiagnostics([])).toEqual([]);
  });

  it("preserves order", () => {
    const result = filterDiagnostics([diag("b", 2), diag("a", 1), diag("c", 3)]);
    expect(result.map((d) => d.message)).toEqual(["b", "a", "c"]);
  });
});
