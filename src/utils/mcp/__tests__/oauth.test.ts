jest.mock('../config', () => ({ getServerOAuth: jest.fn(), saveServerOAuth: jest.fn() }));

import {
  bearerRejectedAsNonOauthToken,
  canonicalResource,
  connectionKey,
  oauthResourceIndicator,
  resolveHeaders,
  shouldRequestMcpAuthorization,
  startMcpAuthorization,
  wellKnownAuthorizationServerUrls,
  wellKnownProtectedResourceUrls,
} from '../oauth';
import { type MCPServer } from '../types';

const server: MCPServer = { id: 'server-1', name: 'Docs', url: 'https://mcp.example.com/mcp', enabled: true, tools: [] };

test('builds protected-resource and authorization-server discovery URLs', () => {
  expect(wellKnownProtectedResourceUrls('https://mcp.example.com/mcp')).toEqual([
    'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    'https://mcp.example.com/.well-known/oauth-protected-resource',
  ]);
  expect(wellKnownAuthorizationServerUrls('https://auth.example.com/tenant')).toEqual([
    'https://auth.example.com/.well-known/oauth-authorization-server/tenant',
    'https://auth.example.com/.well-known/openid-configuration/tenant',
    'https://auth.example.com/tenant/.well-known/openid-configuration',
    'https://auth.example.com/.well-known/oauth-authorization-server',
    'https://auth.example.com/.well-known/openid-configuration',
  ]);
});

test('uses the protected-resource metadata URL as the resource indicator', () => {
  expect(canonicalResource('https://mcp.example.com/mcp#frag')).toBe('https://mcp.example.com/mcp');
  expect(oauthResourceIndicator('https://mcp.example.com/mcp/', 'https://mcp.example.com/mcp#x')).toBe('https://mcp.example.com/mcp');
});

test('decides when a failure should open OAuth', () => {
  expect(bearerRejectedAsNonOauthToken(new Error('Bearer token rejected: not a valid oauth token'))).toBe(true);
  expect(shouldRequestMcpAuthorization({
    hasAccessToken: false, oauthEnabled: false, hasManualAuthorizationHeader: true,
    error: new Error('HTTP 401'), protectedResourceDiscovered: false,
  })).toBe(false);
  expect(shouldRequestMcpAuthorization({
    hasAccessToken: false, oauthEnabled: false, hasManualAuthorizationHeader: true,
    error: new Error('Bearer token rejected: not a valid jwt'), protectedResourceDiscovered: false,
  })).toBe(true);
  expect(shouldRequestMcpAuthorization({
    hasAccessToken: true, oauthEnabled: true, hasManualAuthorizationHeader: false,
    error: new Error('HTTP 500'), protectedResourceDiscovered: false,
  })).toBe(false);
  expect(shouldRequestMcpAuthorization({
    hasAccessToken: false, oauthEnabled: false, hasManualAuthorizationHeader: false,
    error: new Error('Could not reach the MCP server.'), protectedResourceDiscovered: false,
  })).toBeNull();
});

test('replaces a manual Authorization header when an OAuth access token is present', () => {
  expect(resolveHeaders({ authorization: 'Bearer manual', 'x-api-key': 'k' }, { enabled: true, accessToken: 'oauth' })).toEqual({
    'x-api-key': 'k',
    authorization: 'Bearer oauth',
  });
  expect(connectionKey({ ...server, transport: 'sse' }, { authorization: 'Bearer oauth' })).toContain('sse');
});

test('registers the loopback redirect, then exchanges the authorization code', async () => {
  const stored: Array<unknown> = [];
  const requests: Array<{ url: string; body?: string }> = [];
  const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (String(url).endsWith('/mcp')) return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } });
    if (String(url).includes('oauth-protected-resource')) return Response.json({ resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'], scopes_supported: ['mcp'] });
    if (String(url).includes('oauth-authorization-server')) return Response.json({ authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', registration_endpoint: 'https://auth.example.com/register' });
    if (String(url).endsWith('/register')) return Response.json({ client_id: 'client-1' });
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
    return new Response('missing', { status: 404 });
  });
  let launched = '';
  await startMcpAuthorization(server, {
    fetch: fetchImpl as unknown as typeof fetch,
    bind: async () => 4321,
    launch: async url => {
      launched = url;
      const state = new URL(url).searchParams.get('state');
      return `http://127.0.0.1:4321/oauth/callback?code=code-1&state=${state}`;
    },
    cancel: () => {},
    sha256: async () => 'challenge',
    random: () => 'state-token',
    now: () => 1_000,
    loadOAuth: async () => null,
    storeOAuth: async (_id, oauth) => { stored.push(oauth); },
    setStatus: () => {},
    reconnect: () => {},
  });
  expect(launched).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2Foauth%2Fcallback');
  expect(launched).toContain('code_challenge=challenge');
  expect(launched).toContain('resource=https%3A%2F%2Fmcp.example.com%2Fmcp');
  expect(stored.at(-1)).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', clientId: 'client-1', expiresAt: 3_601_000 });
  expect(requests.some(request => request.url.endsWith('/register') && request.body?.includes('http://127.0.0.1:4321/oauth/callback'))).toBe(true);
});
