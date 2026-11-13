export type MCPTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
};

/** Headers are kept separately in the device keychain. */
export type MCPServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  tools: MCPTool[];
};

export type MCPToolResult = {
  content?: Array<{
    type: string;
    text?: string;
    uri?: string;
    mimeType?: string;
    resource?: { uri?: string; text?: string; mimeType?: string };
  }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
};
