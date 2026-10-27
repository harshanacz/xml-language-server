import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { buildSync } from "esbuild";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

const root = path.resolve(__dirname, "..", "..");

/** Bundles src/server.ts the same way `npm run bundle` does (flags, wasm and resources), into a temporary directory. */
export function buildServerBundle(): { dir: string; serverPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xml-ls-bundle-"));
  const serverPath = path.join(dir, "server.js");
  buildSync({
    entryPoints: [path.join(root, "src", "server.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: serverPath,
    banner: { js: "const _fileUrl=require('url').pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "_fileUrl" },
    logLevel: "silent",
  });
  const service = path.join(root, "node_modules", "xml-language-service");
  fs.copyFileSync(path.join(service, "node_modules", "xerces-wasm", "wasm", "xerces_validator.wasm"), path.join(dir, "xerces_validator.wasm"));
  fs.cpSync(path.join(root, "resources"), path.join(dir, "resources"), { recursive: true });
  return { dir, serverPath };
}

export interface PublishedDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  severity?: number;
  source?: string;
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private pending = new Map<number, (value: any) => void>();
  private waiters: (() => void)[] = [];
  readonly diagnostics = new Map<string, PublishedDiagnostic[][]>();
  readonly logs: string[] = [];
  stderr = "";

  constructor(serverPath: string, private configuration: unknown = {}) {
    this.proc = spawn(process.execPath, [serverPath, "--stdio"], { stdio: "pipe" });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())![1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      this.onMessage(message);
    }
  }

  private onMessage(message: any): void {
    if (message.id !== undefined && message.method) {
      // Server-to-client request.
      const result = message.method === "workspace/configuration" ? [this.configuration] : null;
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } else if (message.id !== undefined) {
      this.pending.get(message.id)?.(message.error ? { error: message.error } : message.result);
      this.pending.delete(message.id);
    } else if (message.method === "textDocument/publishDiagnostics") {
      const history = this.diagnostics.get(message.params.uri) ?? [];
      history.push(message.params.diagnostics);
      this.diagnostics.set(message.params.uri, history);
      this.waiters.splice(0).forEach((wake) => wake());
    } else if (message.method === "window/logMessage") {
      this.logs.push(message.params.message);
    }
  }

  private write(message: object): void {
    const body = JSON.stringify(message);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`LSP request ${method} timed out`)), 10_000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async initialize(workspace: string, initializationOptions: unknown = {}) {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(workspace).href,
      workspaceFolders: [{ uri: pathToFileURL(workspace).href, name: "ws" }],
      capabilities: { workspace: { configuration: true } },
      initializationOptions,
    });
    this.notify("initialized", {});
    return result;
  }

  uri(file: string): string {
    return pathToFileURL(file).href;
  }

  open(file: string, text: string, version = 1): string {
    const uri = this.uri(file);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "xml", version, text } });
    return uri;
  }

  change(uri: string, text: string, version: number): void {
    this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  /** Resolves with the next diagnostics published for `uri` after `afterCount` earlier publications. */
  async diagnosticsFor(uri: string, afterCount = 0, timeoutMs = 10_000): Promise<PublishedDiagnostic[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const history = this.diagnostics.get(uri) ?? [];
      if (history.length > afterCount) return history[history.length - 1];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`No diagnostics published for ${uri}. Server stderr: ${this.stderr}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  publishCount(uri: string): number {
    return this.diagnostics.get(uri)?.length ?? 0;
  }

  private shutdownResult: Promise<number | null> | undefined;

  shutdown(): Promise<number | null> {
    this.shutdownResult ??= this.doShutdown();
    return this.shutdownResult;
  }

  private async doShutdown(): Promise<number | null> {
    await this.request("shutdown", null).catch(() => undefined);
    this.notify("exit", null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill();
        resolve(null);
      }, 3000);
      this.proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}
