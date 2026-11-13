import { type ToolManagerTool } from '@/utils/ToolsManager';
import ToolApproval from '@/utils/ToolsManager/toolApproval';
import { isAbortError, throwIfAborted } from '@/utils/chat/abort';
import i18n from '@/i18n';
import { MCPClient } from './client';
import { getServerHeaders, listServers } from './config';
import { materializeToolResult } from './images';
import { ensureFreshToken, resolveHeaders } from './oauth';
import { SseMCPClient } from './sseClient';
import { mcpSessions } from './session';
import { toolNameFor } from './toolNames';
import { serverTransport, type MCPServer, type MCPTool, type MCPToolResult } from './types';

/** Keep binary payloads out of the model's text context and the chat activity log. */
export function formatToolResult(result: MCPToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'resource' && item.resource) parts.push(item.resource.text ?? item.resource.uri ?? '[MCP resource]');
    else if (item.type === 'resource_link') parts.push(item.uri ?? '[MCP resource link]');
    else parts.push(`[MCP ${item.type} content${item.mimeType ? `: ${item.mimeType}` : ''}]`);
  }
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n\n') || 'MCP tool completed with no text content.';
  return result.isError ? `Error: ${text}` : text;
}

export async function discoverTools(url: string, headers: Record<string, string>, signal?: AbortSignal, transport: MCPServer['transport'] = 'streamable_http'): Promise<MCPTool[]> {
  const client = transport === 'sse' ? new SseMCPClient(url, headers) : new MCPClient(url, headers);
  try { return await client.listTools(signal); }
  finally { await client.close(); }
}

class MCPManager {
  private servers: MCPServer[] = [];

  async load(): Promise<void> {
    try { this.servers = await listServers(); }
    catch (error) {
      this.servers = [];
      throw error;
    }
  }

  get tools(): ToolManagerTool[] {
    return this.servers.filter(server => server.enabled).flatMap(server => server.tools.filter(tool => tool.enabled !== false).map(tool => this.toTool(server, tool)));
  }

  private toTool(server: MCPServer, tool: MCPTool): ToolManagerTool {
    const functionName = toolNameFor(server.id, tool.name);
    return {
      id: functionName,
      name: `${server.name}: ${tool.title || tool.name}`,
      description: tool.description || tool.name,
      defaultEnabled: true,
      category: 'appConnections',
      // MCP calls require a person to review the remote operation in this first implementation.
      hiddenFromScheduledJobs: true,
      definition: {
        type: 'function',
        function: {
          name: functionName,
          description: `${server.name} / ${tool.name}: ${tool.description || tool.title || tool.name}`,
          parameters: { ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {}, required: tool.inputSchema.required ?? [] },
        },
      },
      config: {},
      execute: async (rawArgs, streamEmitter, context) => {
        try {
          throwIfAborted(context?.signal);
          const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
          if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Error: MCP tool arguments must be a JSON object.';
          const toolStillListed = (candidate: MCPServer | undefined): candidate is MCPServer => !!candidate?.enabled
            && candidate.url === server.url
            && serverTransport(candidate) === serverTransport(server)
            && candidate.tools.some(item => item.name === tool.name && item.enabled !== false);
          const current = (await listServers()).find(item => item.id === server.id);
          if (!toolStillListed(current)) {
            return 'Error: This MCP tool is no longer available. Refresh the server connection in Settings.';
          }
          if (context?.autoApproveTools) return 'Error: MCP tools are not available to unattended jobs.';
          const approval = await ToolApproval.request({
            skillName: functionName,
            description: i18n.t('settings.mcp.approval', { server: current.name, tool: tool.title || tool.name }),
            payload: { server: current.name, tool: tool.name, arguments: args },
            streamEmitter,
            signal: context?.signal,
          });
          if (!approval.approved) return approval.message;
          throwIfAborted(context?.signal);
          // Settings may change while an approval card is waiting for the user.
          const latest = (await listServers()).find(item => item.id === server.id);
          if (!toolStillListed(latest) || latest.url !== current.url) {
            return 'Error: This MCP tool is no longer available.';
          }
          const ready = { ...latest, transport: serverTransport(latest) };
          const headers = resolveHeaders(await getServerHeaders(latest.id), await ensureFreshToken(ready));
          return formatToolResult(await materializeToolResult(await mcpSessions.call(ready, headers, tool.name, args, context?.signal)));
        } catch (error) {
          if (isAbortError(error)) throw error;
          return `Error: ${error instanceof Error ? error.message : 'MCP tool execution failed.'}`;
        }
      },
    };
  }
}

export default new MCPManager();
