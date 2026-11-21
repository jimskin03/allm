import { NativeModules } from 'react-native';
import { Buffer } from 'buffer';
import { getServerOAuth, saveServerOAuth } from './config';
import { mcpStatus } from './status';
import { type MCPOAuthState, type MCPServer } from './types';

const { LoopbackAuthModule } = NativeModules;

export const MCP_OAUTH_CALLBACK_PATH = '/oauth/callback';
/**
 * App redirect. A loopback `http://127.0.0.1` callback is dropped on phones once the browser
 * is in front: the sign-in page finishes, then nothing can deliver the code back to the app.
 * The custom scheme brings the code in through the OS instead.
 */
export const MCP_OAUTH_REDIRECT_URI = 'anythingllm://oauth/callback';
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const RESOURCE_METADATA_PATTERN = /resource_metadata="([^"]+)"/;

export type ProtectedResourceMetadata = {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
};

export type AuthorizationServerMetadata = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export type OAuthDeps = {
  fetch: typeof fetch;
  bind: (callbackPath: string) => Promise<number>;
  launch: (url: string, timeoutMs: number) => Promise<string>;
  /** Opens the browser and resolves with an `anythingllm://` callback. Absent on a binary that has not been rebuilt. */
  launchRedirect?: (url: string, redirectUri: string, timeoutMs: number) => Promise<string>;
  cancel: () => void;
  sha256: (input: string) => Promise<string>;
  random: (bytes: number) => string;
  now: () => number;
  loadOAuth: (id: string) => Promise<MCPOAuthState | null>;
  storeOAuth: (id: string, oauth: MCPOAuthState | null) => Promise<void>;
  setStatus: (id: string, status: Parameters<typeof mcpStatus.set>[1]) => void;
  reconnect: (server: MCPServer) => void;
};

const attempts = new Map<string, number>();
const refreshLocks = new Map<string, Promise<MCPOAuthState | null>>();
let reconnectHandler: (server: MCPServer) => void = () => {};

/** Session registry registers this so a finished sign-in opens the MCP connection. */
export function setMcpReconnectHandler(handler: (server: MCPServer) => void): void {
  reconnectHandler = handler;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

function parseQuery(url: string): Record<string, string> {
  const query = url.split('?')[1]?.split('#')[0] ?? '';
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [key, value = ''] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
  }
  return params;
}

function originOf(value: string): { origin: string; path: string } | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port ? `:${url.port}` : '';
  return { origin: `${url.protocol}//${url.hostname}${port}`, path: url.pathname.replace(/\/$/, '') };
}

export function canonicalResource(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return serverUrl;
  }
}

/** RFC 8707 resource indicator. Prefer the protected-resource metadata value, without a fragment. */
export function oauthResourceIndicator(serverUrl: string, metadataResource?: string | null): string {
  const declared = metadataResource?.trim();
  if (!declared) return canonicalResource(serverUrl);
  return canonicalResource(declared);
}

export function wellKnownProtectedResourceUrls(serverUrl: string): string[] {
  const parts = originOf(serverUrl);
  if (!parts) return [];
  const urls = [`${parts.origin}/.well-known/oauth-protected-resource`];
  if (parts.path && parts.path !== '/') urls.unshift(`${parts.origin}/.well-known/oauth-protected-resource${parts.path}`);
  return urls;
}

export function wellKnownAuthorizationServerUrls(issuer: string): string[] {
  const parts = originOf(issuer);
  if (!parts) return [];
  const urls: string[] = [];
  if (parts.path && parts.path !== '/') {
    urls.push(`${parts.origin}/.well-known/oauth-authorization-server${parts.path}`);
    urls.push(`${parts.origin}/.well-known/openid-configuration${parts.path}`);
    urls.push(`${parts.origin}${parts.path}/.well-known/openid-configuration`);
  }
  urls.push(`${parts.origin}/.well-known/oauth-authorization-server`);
  urls.push(`${parts.origin}/.well-known/openid-configuration`);
  return [...new Set(urls)];
}

function authFailureText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.message) parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (typeof error === 'string') parts.push(error);
  return parts.join(' ').toLowerCase();
}

/** Scope from a `WWW-Authenticate` challenge, when the server tells the client which one to request. */
export function scopeFromWwwAuthenticate(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const quoted = /(?:^|[\s,])scope="([^"]*)"/i.exec(header)?.[1]?.trim();
  if (quoted) return quoted;
  const bare = /(?:^|[\s,])scope=([^\s,"]+)/i.exec(header)?.[1]?.trim();
  return bare || undefined;
}

/**
 * Prefer the challenge, then the protected resource's own scopes.
 * The authorization server's full catalog is not a request: it includes scopes this client cannot grant,
 * and the consent page then fails after the user signs in.
 */
export function selectOAuthScope(input: { challenge?: string | null; resourceScopes?: string[] | null; existing?: string | null }): string | undefined {
  const challenge = input.challenge?.trim();
  if (challenge) return challenge;
  const scopes = (input.resourceScopes ?? []).map(scope => scope.trim()).filter(Boolean);
  if (scopes.length) return scopes.join(' ');
  const existing = input.existing?.trim();
  return existing || undefined;
}

export function looksLikeMcpAuthFailure(error: unknown): boolean {
  const message = authFailureText(error);
  return ['401', '403', 'unauthorized', 'forbidden', 'insufficient_scope', 'invalid_token', 'invalid access token', 'missing or invalid', 'authorization required', 'bearer token rejected', 'not a valid authkit jwt', 'not a valid jwt']
    .some(needle => message.includes(needle));
}

/** A manual Authorization header must not hide a bearer that the server rejected as a non-OAuth token. */
export function bearerRejectedAsNonOauthToken(error: unknown): boolean {
  const message = authFailureText(error);
  return ['bearer token rejected', 'not a valid authkit jwt', 'not a valid jwt', 'not a valid oauth'].some(needle => message.includes(needle));
}

/**
 * True or false when no metadata probe is required. Null means the caller should probe.
 * A stored access token is a completed sign-in. Only an auth failure may ask again.
 */
export function shouldRequestMcpAuthorization(input: {
  hasAccessToken: boolean;
  oauthEnabled: boolean;
  hasManualAuthorizationHeader: boolean;
  error: unknown;
  protectedResourceDiscovered: boolean;
}): boolean | null {
  if (bearerRejectedAsNonOauthToken(input.error)) return true;
  if (input.hasAccessToken) return looksLikeMcpAuthFailure(input.error);
  if (looksLikeMcpAuthFailure(input.error) && input.oauthEnabled) return true;
  if (input.hasManualAuthorizationHeader) return false;
  return input.protectedResourceDiscovered ? true : null;
}

export function resolveHeaders(headers: Record<string, string>, oauth: MCPOAuthState | null): Record<string, string> {
  if (!oauth?.enabled || !oauth.accessToken) return headers;
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') next[name] = value;
  }
  next.authorization = `Bearer ${oauth.accessToken}`;
  return next;
}

export function connectionKey(server: Pick<MCPServer, 'url' | 'name' | 'transport'>, headers: Record<string, string>): string {
  const transport = server.transport === 'sse' ? 'sse' : 'streamable_http';
  const pairs = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value] as const).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([transport, server.url, server.name, pairs]);
}

function defaultRandom(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

async function defaultSha256(input: string): Promise<string> {
  if (LoopbackAuthModule?.sha256Base64Url) return LoopbackAuthModule.sha256Base64Url(input);
  throw new Error('MCP sign-in is not available in this build.');
}

function defaultDeps(): OAuthDeps {
  return {
    fetch,
    bind: async callbackPath => {
      if (!LoopbackAuthModule?.bind) throw new Error('Rebuild the app to sign in to MCP servers.');
      return LoopbackAuthModule.bind(callbackPath);
    },
    launch: (url, timeoutMs) => {
      if (!LoopbackAuthModule?.launch) return Promise.reject(new Error('Rebuild the app to sign in to MCP servers.'));
      return LoopbackAuthModule.launch(url, timeoutMs);
    },
    launchRedirect: LoopbackAuthModule?.launchRedirect
      ? (url, redirectUri, timeoutMs) => LoopbackAuthModule.launchRedirect(url, redirectUri, timeoutMs)
      : undefined,
    cancel: () => LoopbackAuthModule?.cancel?.(),
    sha256: defaultSha256,
    random: defaultRandom,
    now: () => Date.now(),
    loadOAuth: getServerOAuth,
    storeOAuth: saveServerOAuth,
    setStatus: (id, status) => mcpStatus.set(id, status),
    reconnect: server => reconnectHandler(server),
  };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function getJson<T>(doFetch: typeof fetch, url: string): Promise<T> {
  const response = await doFetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const data = await readJson(response);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return data as T;
}

export async function probeResourceMetadataUrl(doFetch: typeof fetch, serverUrl: string): Promise<string | null> {
  try {
    const response = await doFetch(serverUrl, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' } });
    if (response.status !== 401) return null;
    const header = response.headers.get('WWW-Authenticate') ?? '';
    return RESOURCE_METADATA_PATTERN.exec(header)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function discoverProtectedResource(doFetch: typeof fetch, serverUrl: string): Promise<ProtectedResourceMetadata> {
  const probed = await probeResourceMetadataUrl(doFetch, serverUrl);
  const candidates = [...new Set([...(probed ? [probed] : []), ...wellKnownProtectedResourceUrls(serverUrl)])];
  for (const url of candidates) {
    const metadata = await getJson<ProtectedResourceMetadata>(doFetch, url).catch(() => null);
    if (metadata?.authorization_servers?.length) return metadata;
  }
  throw new Error('Failed to discover protected resource metadata');
}

export async function discoverAuthorizationServer(doFetch: typeof fetch, issuer: string): Promise<AuthorizationServerMetadata> {
  for (const url of wellKnownAuthorizationServerUrls(issuer)) {
    const metadata = await getJson<AuthorizationServerMetadata>(doFetch, url).catch(() => null);
    if (metadata?.authorization_endpoint && metadata.token_endpoint) return metadata;
  }
  throw new Error(`Failed to discover authorization server metadata: ${issuer}`);
}

function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
  resource: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  if (input.scope) url.searchParams.set('scope', input.scope);
  url.searchParams.append('resource', input.resource);
  return url.toString();
}

function tokenAuth(clientId: string, clientSecret: string | undefined, method: string | undefined, params: Record<string, string>): { headers: Record<string, string>; params: Record<string, string> } {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
  const next = { ...params, client_id: clientId };
  if (method === 'client_secret_basic' && clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else if (method && method !== 'none' && clientSecret) {
    next.client_secret = clientSecret;
  }
  return { headers, params: next };
}

async function postForm(doFetch: typeof fetch, url: string, params: Record<string, string>, operation: string, headers?: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: headers ?? { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody(params),
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `Could not reach the authorization server during ${operation}.`);
  }
  const data = await readJson(response) as TokenResponse | null;
  if (!response.ok || !data?.access_token) {
    const description = data?.error_description || data?.error;
    throw new Error(description ? `${operation} failed (HTTP ${response.status}): ${description}` : `${operation} failed (HTTP ${response.status}).`);
  }
  return data;
}

function expiry(now: number, expiresIn?: number): number {
  return expiresIn && expiresIn > 0 ? now + expiresIn * 1000 : 0;
}

export async function ensureFreshToken(server: MCPServer, deps: OAuthDeps = defaultDeps()): Promise<MCPOAuthState | null> {
  const pending = refreshLocks.get(server.id);
  if (pending) return pending;
  const job = refreshLocked(server, deps).finally(() => {
    if (refreshLocks.get(server.id) === job) refreshLocks.delete(server.id);
  });
  refreshLocks.set(server.id, job);
  return job;
}

async function refreshLocked(server: MCPServer, deps: OAuthDeps): Promise<MCPOAuthState | null> {
  const oauth = await deps.loadOAuth(server.id);
  if (!oauth?.enabled || !oauth.refreshToken || !oauth.tokenEndpoint || !oauth.clientId) return oauth;
  const expired = !!oauth.expiresAt && deps.now() >= oauth.expiresAt - TOKEN_REFRESH_LEEWAY_MS;
  if (oauth.accessToken && !expired) return oauth;
  try {
    let resource = oauth.resource;
    if (!resource) {
      const metadata = await discoverProtectedResource(deps.fetch, server.url).catch(() => null);
      resource = oauthResourceIndicator(server.url, metadata?.resource);
    }
    const refresh = tokenAuth(oauth.clientId, oauth.clientSecret, oauth.tokenEndpointAuthMethod, {
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      ...(oauth.scope ? { scope: oauth.scope } : {}),
      ...(resource ? { resource } : {}),
    });
    const token = await postForm(deps.fetch, oauth.tokenEndpoint, refresh.params, 'OAuth token refresh', refresh.headers);
    const updated: MCPOAuthState = {
      ...oauth,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || oauth.refreshToken,
      expiresAt: expiry(deps.now(), token.expires_in),
      scope: token.scope || oauth.scope,
      resource: resource || oauth.resource,
    };
    await deps.storeOAuth(server.id, updated);
    return updated;
  } catch {
    return oauth;
  }
}

export function cancelMcpAuthorization(serverId: string, deps: OAuthDeps = defaultDeps()): void {
  attempts.set(serverId, (attempts.get(serverId) ?? 0) + 1);
  deps.cancel();
  deps.setStatus(serverId, { state: 'needs_authorization' });
}

export async function clearMcpAuthorization(serverId: string, deps: OAuthDeps = defaultDeps()): Promise<void> {
  attempts.set(serverId, (attempts.get(serverId) ?? 0) + 1);
  deps.cancel();
  await deps.storeOAuth(serverId, null);
  deps.setStatus(serverId, { state: 'idle' });
}

async function readChallengeScope(doFetch: typeof fetch, serverUrl: string): Promise<string | undefined> {
  try {
    const response = await doFetch(serverUrl, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' } });
    return scopeFromWwwAuthenticate(response.headers.get('WWW-Authenticate'));
  } catch {
    return undefined;
  }
}

function registrationRejectedRedirect(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('redirect') || message.endsWith('registration failed (http 400).');
}

async function registerClient(deps: OAuthDeps, endpoint: string, redirectUri: string, scope: string | undefined, name: string): Promise<{ clientId: string; clientSecret?: string; method: string }> {
  const response = await deps.fetch(endpoint, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      ...(scope ? { scope } : {}),
    }),
  });
  const registration = await readJson(response);
  if (!response.ok || !registration?.client_id) {
    const description = registration?.error_description || registration?.error;
    throw new Error(description ? `OAuth client registration failed (HTTP ${response.status}): ${description}` : `OAuth client registration failed (HTTP ${response.status}).`);
  }
  const method = typeof registration.token_endpoint_auth_method === 'string' ? registration.token_endpoint_auth_method : 'none';
  return {
    clientId: registration.client_id,
    clientSecret: method === 'none' ? undefined : registration.client_secret,
    method,
  };
}

async function redirectUriFor(deps: OAuthDeps, endpoint: string | undefined, scope: string | undefined, name: string, existing: MCPOAuthState | null): Promise<{ redirectUri: string; clientId: string; clientSecret?: string; method: string; loopback: boolean }> {
  const reuse = (redirectUri: string, loopback: boolean) => {
    if (existing?.redirectUri === redirectUri && existing.clientId) {
      return { redirectUri, clientId: existing.clientId, clientSecret: existing.tokenEndpointAuthMethod === 'none' ? undefined : existing.clientSecret, method: existing.tokenEndpointAuthMethod || 'none', loopback };
    }
    return null;
  };
  if (deps.launchRedirect) {
    const reused = reuse(MCP_OAUTH_REDIRECT_URI, false);
    if (reused) return reused;
    if (!endpoint) throw new Error('Authorization server does not support dynamic registration, and client_id is not preconfigured');
    try {
      const registered = await registerClient(deps, endpoint, MCP_OAUTH_REDIRECT_URI, scope, name);
      return { redirectUri: MCP_OAUTH_REDIRECT_URI, ...registered, loopback: false };
    } catch (error) {
      if (!registrationRejectedRedirect(error)) throw error;
    }
  }
  const port = await deps.bind(MCP_OAUTH_CALLBACK_PATH);
  const redirectUri = `http://127.0.0.1:${port}${MCP_OAUTH_CALLBACK_PATH}`;
  const reused = reuse(redirectUri, true);
  if (reused) return reused;
  if (!endpoint) throw new Error('Authorization server does not support dynamic registration, and client_id is not preconfigured');
  const registered = await registerClient(deps, endpoint, redirectUri, scope, name);
  return { redirectUri, ...registered, loopback: true };
}

/** Browser OAuth 2.1 with PKCE. The code returns through the app scheme, or a loopback listener when a server rejects that. */
export async function startMcpAuthorization(server: MCPServer, deps: OAuthDeps = defaultDeps()): Promise<void> {
  const attempt = (attempts.get(server.id) ?? 0) + 1;
  attempts.set(server.id, attempt);
  const current = () => attempts.get(server.id) === attempt;
  deps.setStatus(server.id, { state: 'authorizing' });
  try {
    const [protectedResource, challengeScope] = await Promise.all([
      discoverProtectedResource(deps.fetch, server.url),
      readChallengeScope(deps.fetch, server.url),
    ]);
    if (!current()) return;
    const issuer = protectedResource.authorization_servers?.[0];
    if (!issuer) throw new Error('Protected resource does not declare an authorization server');
    const metadata = await discoverAuthorizationServer(deps.fetch, issuer);
    if (!current()) return;
    const authorizationEndpoint = metadata.authorization_endpoint;
    const tokenEndpoint = metadata.token_endpoint;
    if (!authorizationEndpoint || !tokenEndpoint) throw new Error('Authorization server metadata is incomplete.');
    const existing = await deps.loadOAuth(server.id);
    const scope = selectOAuthScope({
      challenge: challengeScope,
      resourceScopes: protectedResource.scopes_supported,
      existing: existing?.scope,
    });
    const resource = oauthResourceIndicator(server.url, protectedResource.resource);
    const verifier = deps.random(32);
    const state = deps.random(16);
    const challenge = await deps.sha256(verifier);
    const client = await redirectUriFor(deps, metadata.registration_endpoint, scope, server.name.trim() || 'AnythingLLM', existing);
    if (!current()) return;
    const registered: MCPOAuthState = {
      enabled: true,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpointAuthMethod: client.method,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: metadata.registration_endpoint,
      redirectUri: client.redirectUri,
      scope,
      resource,
    };
    await deps.storeOAuth(server.id, registered);
    if (!current()) return;
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint,
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      challenge,
      state,
      scope,
      resource,
    });
    const callbackUrl = client.loopback
      ? await deps.launch(authorizationUrl, CALLBACK_TIMEOUT_MS)
      : await deps.launchRedirect!(authorizationUrl, client.redirectUri, CALLBACK_TIMEOUT_MS);
    if (!current()) return;
    const callback = parseQuery(callbackUrl);
    if (callback.state !== state) throw new Error('The sign in response did not match this request.');
    if (callback.iss && metadata.issuer && callback.iss.replace(/\/$/, '') !== metadata.issuer.replace(/\/$/, '')) {
      throw new Error('The sign in response came from a different authorization server.');
    }
    if (callback.error) throw new Error(callback.error_description ? `Authorization failed: ${callback.error} (${callback.error_description})` : `Authorization failed: ${callback.error}`);
    if (!callback.code) throw new Error('Authorization failed: No authorization code returned');
    const exchange = tokenAuth(client.clientId, client.clientSecret, client.method, {
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
      ...(scope ? { scope } : {}),
      resource,
    });
    const token = await postForm(deps.fetch, tokenEndpoint, exchange.params, 'OAuth code exchange', exchange.headers);
    if (!current()) return;
    await deps.storeOAuth(server.id, {
      ...registered,
      scope: token.scope || scope,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: expiry(deps.now(), token.expires_in),
    });
    deps.setStatus(server.id, { state: 'connecting' });
    deps.reconnect(server);
  } catch (error) {
    if (!current()) return;
    const message = error instanceof Error ? error.message : 'OAuth authorization failed';
    if (/cancel/i.test(message)) deps.setStatus(server.id, { state: 'needs_authorization' });
    else deps.setStatus(server.id, { state: 'error', message });
    throw error;
  }
}

export async function authorizationNeeded(server: MCPServer, headers: Record<string, string>, error: unknown, deps: OAuthDeps = defaultDeps()): Promise<boolean> {
  const oauth = await deps.loadOAuth(server.id);
  const decision = shouldRequestMcpAuthorization({
    hasAccessToken: !!oauth?.accessToken,
    oauthEnabled: !!oauth?.enabled,
    hasManualAuthorizationHeader: Object.keys(headers).some(name => name.toLowerCase() === 'authorization'),
    error,
    protectedResourceDiscovered: false,
  });
  if (decision !== null) return decision;
  return discoverProtectedResource(deps.fetch, server.url).then(() => true).catch(() => false);
}
