export type MCPTransport = 'streamable_http' | 'sse';

export type MCPTool = {
  name: string;
  title?: string;
  description?: string;
  /** Omitted or true means the tool is offered in chat. Preserved when the server list is refreshed. */
  enabled?: boolean;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
};

/**
 * Headers and OAuth tokens are kept separately in the device keychain.
 * `transport` defaults to Streamable HTTP when a saved server has no field.
 */
export type MCPServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  transport?: MCPTransport;
  tools: MCPTool[];
};

/** OAuth client registration and tokens. Never written to AsyncStorage. */
export type MCPOAuthState = {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  redirectUri?: string;
  scope?: string;
  resource?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. 0 or omitted means the access token has no known expiry. */
  expiresAt?: number;
};

export type MCPStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'reconnecting'; attempt: number; max: number }
  | { state: 'error'; message: string }
  | { state: 'needs_authorization' }
  | { state: 'authorizing' };

export type MCPToolResult = {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    uri?: string;
    mimeType?: string;
    resource?: { uri?: string; text?: string; mimeType?: string };
  }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
};

export const MCP_RECONNECT_ATTEMPTS = 5;

export function serverTransport(server: Pick<MCPServer, 'transport'>): MCPTransport {
  return server.transport === 'sse' ? 'sse' : 'streamable_http';
}
