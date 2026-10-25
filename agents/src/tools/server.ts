import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Toolset } from './toolset';

/** The server name Droid sees; its tools appear to the model as mcp__desk__<tool>. */
export const SERVER_NAME = 'desk';

export interface Binding {
  /** The session's mcpServers entry. */
  config: { type: 'http'; name: string; url: string; oauth: false; headers: { name: string; value: string }[] };
  release(): void;
}

/**
 * One MCP server for the whole agents process (Streamable HTTP on 127.0.0.1, random port, started
 * on first use). Each Droid session is handed its own secret: the bearer token names ONE task's
 * toolset, so the session can reach that client and nothing else. Stateless: each request builds
 * a fresh MCP server over the toolset's tools.
 */
export class ToolServer {
  private http?: http.Server;
  private url = '';
  private readonly bound = new Map<string, Toolset>();

  async start(): Promise<void> {
    if (this.http) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('tool server has no address');
    this.http = server;
    this.url = `http://127.0.0.1:${address.port}/mcp`;
  }

  async bind(toolset: Toolset): Promise<Binding> {
    await this.start();
    const token = randomBytes(32).toString('base64url');
    this.bound.set(token, toolset);
    return {
      config: { type: 'http', name: SERVER_NAME, url: this.url, oauth: false, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
      release: () => void this.bound.delete(token),
    };
  }

  async close(): Promise<void> {
    const server = this.http;
    this.http = undefined;
    this.bound.clear();
    if (!server) return;
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }

  private toolsetFor(authorization: string | undefined): Toolset | undefined {
    const m = /^Bearer (.+)$/i.exec(authorization ?? '');
    if (!m) return undefined;
    const given = Buffer.from(m[1]!);
    for (const [token, toolset] of this.bound) {
      const want = Buffer.from(token);
      if (want.length === given.length && timingSafeEqual(want, given)) return toolset;
    }
    return undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const fail = (code: number, message: string) => {
      if (res.headersSent) return;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }));
    };
    if (req.url !== '/mcp') return void res.writeHead(404).end();
    if (req.method !== 'POST') return void res.writeHead(405).end();
    const toolset = this.toolsetFor(req.headers.authorization);
    if (!toolset) return fail(401, 'Unauthorized');

    const mcp = new McpServer({ name: SERVER_NAME, version: '1.0.0' });
    for (const def of toolset.defs) {
      mcp.registerTool(
        def.name,
        { description: def.description, inputSchema: def.input, annotations: { readOnlyHint: def.readOnly, openWorldHint: false } },
        async (args: Record<string, unknown>) => {
          const text = await toolset.call(def.name, args);
          return { content: [{ type: 'text' as const, text }], isError: text.startsWith('error:') };
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      fail(500, e instanceof Error ? e.message : 'Internal server error');
      await transport.close();
      await mcp.close();
    }
  }
}

let shared: ToolServer | undefined;
/** The process's one tool server. */
export const toolServer = () => (shared ??= new ToolServer());
