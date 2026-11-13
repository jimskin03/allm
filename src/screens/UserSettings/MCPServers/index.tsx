import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { ArrowLeft } from 'phosphor-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import SafeView from '@/components/SafeView';
import ToggleSwitch from '@/components/ToggleSwitch';
import AwaitableAlert from '@/components/AwaitableAlert';
import useHighjackBackButtonPress from '@/hooks/useHighjackBackButtonPress';
import ToolsManager from '@/utils/ToolsManager';
import MCPManager, { discoverTools } from '@/utils/mcp';
import { getServerHeaders, getServerOAuth, listServers, parseHeaders, removeServer, saveServer, validateServerUrl } from '@/utils/mcp/config';
import { parseMcpImport } from '@/utils/mcp/importConfig';
import { authorizationNeeded, cancelMcpAuthorization, clearMcpAuthorization, startMcpAuthorization } from '@/utils/mcp/oauth';
import { mcpSessions, mergeTools } from '@/utils/mcp/session';
import { mcpStatus } from '@/utils/mcp/status';
import { serverTransport, type MCPServer, type MCPStatus, type MCPTransport } from '@/utils/mcp/types';
import { generateUUID } from '@/utils/constants';
import { type IWorkspacePageKey } from '../index';

type OAuthSummary = { enabled: boolean; hasToken: boolean };

export default function MCPServers({ goToPage }: { goToPage: (page: IWorkspacePageKey) => void }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [oauth, setOauth] = useState<Record<string, OAuthSummary>>({});
  const [draft, setDraft] = useState<MCPServer | null>(null);
  const [headers, setHeaders] = useState('{}');
  const [importText, setImportText] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const goBack = () => {
    if (busy) return true;
    if (draft || importText !== null) {
      setDraft(null);
      setImportText(null);
    } else goToPage('main');
    setError('');
    return true;
  };
  useHighjackBackButtonPress(goBack);

  const reportError = (reason: unknown) => setError(t('settings.mcp.failed', {
    message: reason instanceof Error ? reason.message : t('common.unknown_error'),
  }));

  const loadOauth = async (next: MCPServer[]) => {
    const summaries: Record<string, OAuthSummary> = {};
    for (const server of next) {
      const stored = await getServerOAuth(server.id);
      summaries[server.id] = { enabled: !!stored?.enabled, hasToken: !!stored?.accessToken };
    }
    setOauth(summaries);
  };

  useEffect(() => {
    listServers().then(async next => {
      setServers(next);
      await loadOauth(next);
    }).catch(reportError).finally(() => setBusy(false));
  }, []);

  const refresh = async () => {
    await MCPManager.load();
    ToolsManager.resetTools();
    const next = await listServers();
    setServers(next);
    await loadOauth(next);
    setDraft(current => {
      if (!current) return current;
      const latest = next.find(item => item.id === current.id);
      if (!latest) return null;
      return { ...current, enabled: latest.enabled, tools: latest.tools };
    });
  };

  const edit = async (server: MCPServer) => {
    setBusy(true);
    setError('');
    try {
      setHeaders(JSON.stringify(await getServerHeaders(server.id)));
      setDraft({ ...server, transport: serverTransport(server) });
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  const connectAndSave = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      if (!draft.name.trim()) throw new Error(t('settings.mcp.name_required'));
      const url = validateServerUrl(draft.url);
      const parsedHeaders = parseHeaders(headers);
      const transport = serverTransport(draft);
      let tools = draft.tools;
      try {
        tools = mergeTools(draft.tools, await discoverTools(url, parsedHeaders, undefined, transport));
      } catch (reason) {
        if (!(await authorizationNeeded({ ...draft, url, transport }, parsedHeaders, reason))) throw reason;
        await saveServer({ ...draft, url, transport, tools }, parsedHeaders);
        mcpStatus.set(draft.id, { state: 'needs_authorization' });
        await refresh();
        setDraft({ ...draft, url, transport, tools });
        return;
      }
      const saved = { ...draft, url, transport, tools };
      await saveServer(saved, parsedHeaders);
      await mcpSessions.sync(saved).catch(() => {});
      await refresh();
      const latest = (await listServers()).find(item => item.id === draft.id);
      setDraft(latest ? { ...latest, transport: serverTransport(latest) } : saved);
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  const toggle = async (server: MCPServer) => {
    setBusy(true);
    setError('');
    try {
      if (server.enabled) await mcpSessions.forget(server.id);
      const next = { ...server, enabled: !server.enabled, transport: serverTransport(server) };
      await saveServer(next, await getServerHeaders(server.id));
      if (next.enabled) await mcpSessions.sync(next).catch(() => {});
      await refresh();
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  const toggleTool = async (server: MCPServer, name: string) => {
    setBusy(true);
    setError('');
    try {
      const tools = server.tools.map(tool => tool.name === name ? { ...tool, enabled: tool.enabled === false } : tool);
      await saveServer({ ...server, transport: serverTransport(server), tools }, await getServerHeaders(server.id));
      await refresh();
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  const remove = async (server: MCPServer) => {
    const confirmed = await AwaitableAlert(
      t('settings.mcp.remove_title'),
      t('settings.mcp.remove_message', { name: server.name }),
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive' },
    );
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      await mcpSessions.forget(server.id);
      await removeServer(server.id);
      await refresh();
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  const authorize = async (server: MCPServer) => {
    setBusy(true);
    setError('');
    try {
      await startMcpAuthorization({ ...server, transport: serverTransport(server) });
      await mcpSessions.sync({ ...server, transport: serverTransport(server) }).catch(() => {});
      await refresh();
    } catch (reason) {
      if (!(reason instanceof Error && /cancel/i.test(reason.message))) reportError(reason);
    }
    finally { setBusy(false); }
  };

  const signOut = async (server: MCPServer) => {
    setBusy(true);
    setError('');
    try {
      await clearMcpAuthorization(server.id);
      await mcpSessions.forget(server.id);
      await refresh();
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  const importServers = async () => {
    if (importText === null) return;
    setBusy(true);
    setError('');
    try {
      const existing = new Set((await listServers()).map(server => server.name));
      let added = 0;
      for (const entry of parseMcpImport(importText)) {
        if (existing.has(entry.name)) continue;
        existing.add(entry.name);
        added += 1;
        await saveServer({
          id: generateUUID(),
          name: entry.name,
          url: entry.url,
          enabled: true,
          transport: entry.transport,
          tools: [],
        }, entry.headers);
      }
      if (added === 0) throw new Error('Those MCP servers are already imported.');
      await refresh();
      setImportText(null);
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  const pullRefresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      for (const server of await listServers()) {
        if (!server.enabled) continue;
        await mcpSessions.sync({ ...server, transport: serverTransport(server) }).catch(reason => reportError(reason));
      }
      await refresh();
    } catch (reason) { reportError(reason); }
    finally { setRefreshing(false); }
  };

  const savedDraft = draft ? servers.find(server => server.id === draft.id) : undefined;
  const title = importText !== null
    ? t('settings.mcp.import')
    : draft
      ? (savedDraft ? (draft.name.trim() || t('common.edit')) : t('settings.mcp.add'))
      : t('settings.mcp.title');

  return (
    <SafeView scrollable={false} safeAreaClassNames="pt-[21px]" containerClassNames="flex-1 flex flex-col" safeAreaStyle={{ backgroundColor: '#0E0F0F' }}>
      <View style={{ paddingTop: insets.top, paddingBottom: 20 }} className="w-full flex flex-row items-center justify-center relative">
        <TouchableOpacity disabled={busy} accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={goBack} className="absolute left-0">
          <ArrowLeft size={24} color="#FFF" weight="bold" />
        </TouchableOpacity>
        <Text numberOfLines={1} className="text-white text-lg font-medium" style={{ marginHorizontal: 40 }}>{title}</Text>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pullRefresh} tintColor="#FFF" />}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 24, gap: 16 }}
      >
        {!draft && importText === null && <Text style={{ color: '#9F9FA0' }}>{t('settings.mcp.description')}</Text>}
        {!!error && <Text accessibilityRole="alert" style={{ color: '#F97066' }}>{error}</Text>}
        {busy && <ActivityIndicator accessibilityLabel={t('common.loading')} color="#FFF" />}
        {draft ? (
          <View style={{ gap: 16 }}>
            <Field label={t('settings.mcp.name')} value={draft.name} editable={!busy} onChangeText={name => setDraft({ ...draft, name })} />
            <View style={{ gap: 8 }}>
              <Text className="text-white font-medium">{t('settings.mcp.transport')}</Text>
              <View className="flex flex-row" style={{ gap: 8 }}>
                <Choice label={t('settings.mcp.transport_http')} selected={serverTransport(draft) === 'streamable_http'} disabled={busy} onPress={() => setDraft({ ...draft, transport: 'streamable_http' })} />
                <Choice label={t('settings.mcp.transport_sse')} selected={serverTransport(draft) === 'sse'} disabled={busy} onPress={() => setDraft({ ...draft, transport: 'sse' })} />
              </View>
            </View>
            <Field label={t('settings.mcp.url')} value={draft.url} editable={!busy} onChangeText={url => setDraft({ ...draft, url })} placeholder="https://example.com/mcp" />
            <Field label={t('settings.mcp.headers')} value={headers} editable={!busy} onChangeText={setHeaders} placeholder={'{"Authorization":"Bearer ..."}'} />
            <Text style={{ color: '#9F9FA0' }} className="text-sm">{t('settings.mcp.headers_hint')}</Text>
            <View className="flex flex-row items-center justify-between" style={{ gap: 12 }}>
              <Text className="text-white flex-1 font-medium">{t('settings.mcp.enable_server', { name: draft.name.trim() || t('settings.mcp.title') })}</Text>
              <View accessibilityLabel={t('settings.mcp.enable_server', { name: draft.name.trim() || t('settings.mcp.title') })} pointerEvents={busy ? 'none' : 'auto'}>
                <ToggleSwitch isOn={draft.enabled} onToggle={() => savedDraft ? toggle(savedDraft) : setDraft({ ...draft, enabled: !draft.enabled })} />
              </View>
            </View>
            {savedDraft && (
              <ConnectionStatus
                server={savedDraft}
                oauth={oauth[savedDraft.id]}
                busy={busy}
                onAuthorize={() => authorize(savedDraft)}
                onCancel={() => cancelMcpAuthorization(savedDraft.id)}
                onSignOut={() => signOut(savedDraft)}
              />
            )}
            <Action label={savedDraft ? t('settings.mcp.edit_refresh') : t('settings.mcp.connect_save')} disabled={busy} onPress={connectAndSave} />
            <View style={{ gap: 12 }}>
              <Text className="text-white text-lg font-medium">{t('settings.mcp.functions')}</Text>
              <Text style={{ color: '#9F9FA0' }} className="text-sm">{t('settings.mcp.tools_hint')}</Text>
              {draft.tools.length === 0 && <Text className="text-white">{t('settings.mcp.functions_empty')}</Text>}
              {draft.tools.map(tool => (
                <View key={tool.name} className="flex flex-row items-center justify-between" style={{ gap: 12 }}>
                  <View className="flex-1" style={{ gap: 4 }}>
                    <Text className="text-white">{tool.title || tool.name}</Text>
                    {!!tool.description && <Text style={{ color: '#9F9FA0' }} className="text-sm">{tool.description}</Text>}
                  </View>
                  <View accessibilityLabel={t('settings.mcp.enable_tool', { name: tool.title || tool.name })} pointerEvents={busy ? 'none' : 'auto'}>
                    <ToggleSwitch
                      isOn={tool.enabled !== false}
                      onToggle={() => savedDraft ? toggleTool(savedDraft, tool.name) : setDraft({
                        ...draft,
                        tools: draft.tools.map(item => item.name === tool.name ? { ...item, enabled: item.enabled === false } : item),
                      })}
                    />
                  </View>
                </View>
              ))}
            </View>
            {savedDraft && <Action label={t('common.remove')} disabled={busy} onPress={() => remove(savedDraft)} />}
            <Action label={t('common.cancel')} disabled={busy} onPress={goBack} />
          </View>
        ) : importText !== null ? (
          <View style={{ gap: 16 }}>
            <Field label={t('settings.mcp.import')} value={importText} editable={!busy} onChangeText={setImportText} placeholder={'{"mcpServers":{}}'} />
            <Text style={{ color: '#9F9FA0' }} className="text-sm">{t('settings.mcp.import_hint')}</Text>
            <Action label={t('settings.mcp.import_save')} disabled={busy} onPress={importServers} />
            <Action label={t('common.cancel')} disabled={busy} onPress={goBack} />
          </View>
        ) : (
          <>
            {servers.length === 0 && !busy && <Text className="text-white">{t('settings.mcp.empty')}</Text>}
            {servers.map(server => (
              <ServerRow
                key={server.id}
                server={server}
                busy={busy}
                onEdit={() => edit(server)}
                onRemove={() => remove(server)}
              />
            ))}
            <Action label={t('settings.mcp.add')} disabled={busy} onPress={() => {
              setError('');
              setHeaders('{}');
              setDraft({ id: generateUUID(), name: '', url: '', enabled: true, transport: 'streamable_http', tools: [] });
            }} />
            <Action label={t('settings.mcp.import')} disabled={busy} onPress={() => { setError(''); setImportText(''); }} />
          </>
        )}
      </ScrollView>
    </SafeView>
  );
}

function ServerRow({ server, busy, onEdit, onRemove }: {
  server: MCPServer;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const status = useSyncExternalStore(mcpStatus.subscribe, () => mcpStatus.get(server.id));
  const transport: MCPTransport = serverTransport(server);
  return (
    <View style={{ backgroundColor: '#1B1B1E', padding: 16, borderRadius: 8, gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text className="text-white text-lg font-medium">{server.name}</Text>
        <Text numberOfLines={1} style={{ color: '#9F9FA0' }}>{server.url}</Text>
        <Text style={{ color: '#9F9FA0' }}>{transport === 'sse' ? t('settings.mcp.transport_sse') : t('settings.mcp.transport_http')}</Text>
        <Text style={{ color: statusColor(status) }}>{statusLabel(status, t)}</Text>
        <Text style={{ color: '#9F9FA0' }}>{server.enabled ? t('common.enabled') : t('common.disabled')}</Text>
        <Text style={{ color: '#9F9FA0' }}>{t('settings.mcp.tool_count', { count: server.tools.filter(tool => tool.enabled !== false).length })}</Text>
      </View>
      <View className="flex flex-row" style={{ gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Action label={t('common.edit')} accessibilityLabel={`${t('common.edit')} ${server.name}`} disabled={busy} onPress={onEdit} />
        </View>
        <View style={{ flex: 1 }}>
          <Action label={t('common.remove')} accessibilityLabel={`${t('common.remove')} ${server.name}`} disabled={busy} onPress={onRemove} />
        </View>
      </View>
    </View>
  );
}

function ConnectionStatus({ server, oauth, busy, onAuthorize, onCancel, onSignOut }: {
  server: MCPServer;
  oauth?: OAuthSummary;
  busy: boolean;
  onAuthorize: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const status = useSyncExternalStore(mcpStatus.subscribe, () => mcpStatus.get(server.id));
  const needsSignIn = status.state === 'needs_authorization' || (!!oauth?.enabled && !oauth.hasToken);
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: statusColor(status) }}>{statusLabel(status, t)}</Text>
      {status.state === 'error' && (
        <Action label={t('common.copy')} disabled={busy} onPress={() => Clipboard.setString(status.message)} />
      )}
      {status.state === 'authorizing' && <Action label={t('settings.mcp.cancel_authorize')} disabled={busy} onPress={onCancel} />}
      {needsSignIn && status.state !== 'authorizing' && <Action label={t('settings.mcp.authorize')} disabled={busy} onPress={onAuthorize} />}
      {!!oauth?.hasToken && <Action label={t('settings.mcp.deauthorize')} disabled={busy} onPress={onSignOut} />}
    </View>
  );
}

function statusLabel(status: MCPStatus, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (status.state === 'reconnecting') return t('settings.mcp.status_reconnecting', { attempt: status.attempt, max: status.max });
  if (status.state === 'error') return status.message;
  return t(`settings.mcp.status_${status.state}`);
}

function statusColor(status: MCPStatus): string {
  if (status.state === 'connected') return '#86EFAC';
  if (status.state === 'error' || status.state === 'needs_authorization') return '#F97066';
  return '#9F9FA0';
}

function Field({ label, ...props }: { label: string; value: string; editable: boolean; onChangeText: (value: string) => void; placeholder?: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text className="text-white font-medium">{label}</Text>
      <TextInput {...props} accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} multiline placeholderTextColor="#9F9FA0" style={{ backgroundColor: '#27282A', color: '#FFF', padding: 12, borderRadius: 8 }} />
    </View>
  );
}

function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected }} disabled={disabled} onPress={onPress} style={{ backgroundColor: selected ? '#3F3F46' : '#27282A', padding: 12, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}>
      <Text className="text-white font-medium">{label}</Text>
    </TouchableOpacity>
  );
}

function Action({ label, disabled, onPress, accessibilityLabel }: { label: string; disabled: boolean; onPress: () => void; accessibilityLabel?: string }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} disabled={disabled} onPress={onPress} style={{ backgroundColor: '#27282A', padding: 12, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}>
      <Text className="text-white font-medium text-center">{label}</Text>
    </TouchableOpacity>
  );
}
