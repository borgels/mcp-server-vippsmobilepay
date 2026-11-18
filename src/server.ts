import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VippsMobilePayClient, type VippsClientOptions } from './vipps/client.js';
import { registerTools } from './tools/vipps.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: VippsMobilePayClient;
  clientOptions?: VippsClientOptions;
}

let defaultClient: VippsMobilePayClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): VippsMobilePayClient {
  defaultClient ??= new VippsMobilePayClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'vippsmobilepay',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new VippsMobilePayClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
