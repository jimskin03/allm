import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ArrowLeft } from 'phosphor-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import SafeView from '@/components/SafeView';
import ToggleSwitch from '@/components/ToggleSwitch';
import AwaitableAlert from '@/components/AwaitableAlert';
import useHighjackBackButtonPress from '@/hooks/useHighjackBackButtonPress';
import ToolsManager from '@/utils/ToolsManager';
import MCPManager, { discoverTools } from '@/utils/mcp';
import { getServerHeaders, listServers, parseHeaders, removeServer, saveServer, validateServerUrl } from '@/utils/mcp/config';
import { type MCPServer } from '@/utils/mcp/types';
import { generateUUID } from '@/utils/constants';
import { type IWorkspacePageKey } from '../index';

export default function MCPServers({ goToPage }: { goToPage: (page: IWorkspacePageKey) => void }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [draft, setDraft] = useState<MCPServer | null>(null);
  const [headers, setHeaders] = useState('{}');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const goBack = () => {
    if (busy) return true;
    if (draft) setDraft(null);
    else goToPage('main');
    setError('');
    return true;
  };
  useHighjackBackButtonPress(goBack);

  const reportError = (reason: unknown) => setError(t('settings.mcp.failed', {
    message: reason instanceof Error ? reason.message : t('common.unknown_error'),
  }));

  useEffect(() => {
    listServers().then(setServers).catch(reportError).finally(() => setBusy(false));
  }, []);

  const refresh = async () => {
    await MCPManager.load();
    ToolsManager.resetTools();
    setServers(await listServers());
  };

  const edit = async (server: MCPServer) => {
    setBusy(true);
    setError('');
    try {
      setHeaders(JSON.stringify(await getServerHeaders(server.id)));
      setDraft({ ...server });
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
      const tools = await discoverTools(url, parsedHeaders);
      await saveServer({ ...draft, url, tools }, parsedHeaders);
      await refresh();
      setDraft(null);
      setHeaders('{}');
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  const toggle = async (server: MCPServer) => {
    setBusy(true);
    setError('');
    try {
      await saveServer({ ...server, enabled: !server.enabled }, await getServerHeaders(server.id));
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
      await removeServer(server.id);
      await refresh();
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };

  return (
    <SafeView scrollable={false} safeAreaClassNames="pt-[21px]" containerClassNames="flex-1 flex flex-col" safeAreaStyle={{ backgroundColor: '#0E0F0F' }}>
      <View style={{ paddingTop: insets.top, paddingBottom: 20 }} className="w-full flex flex-row items-center justify-center relative">
        <TouchableOpacity disabled={busy} accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={goBack} className="absolute left-0">
          <ArrowLeft size={24} color="#FFF" weight="bold" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-medium">{t('settings.mcp.title')}</Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 24, gap: 16 }}>
        <Text style={{ color: '#9F9FA0' }}>{t('settings.mcp.description')}</Text>
        {!!error && <Text accessibilityRole="alert" style={{ color: '#F97066' }}>{error}</Text>}
        {busy && <ActivityIndicator accessibilityLabel={t('common.loading')} color="#FFF" />}
        {draft ? (
          <View style={{ gap: 16 }}>
            <Field label={t('settings.mcp.name')} value={draft.name} editable={!busy} onChangeText={name => setDraft({ ...draft, name })} />
            <Field label={t('settings.mcp.url')} value={draft.url} editable={!busy} onChangeText={url => setDraft({ ...draft, url })} placeholder="https://example.com/mcp" />
            <Field label={t('settings.mcp.headers')} value={headers} editable={!busy} onChangeText={setHeaders} placeholder={'{"Authorization":"Bearer ..."}'} />
            <Text style={{ color: '#9F9FA0' }} className="text-sm">{t('settings.mcp.headers_hint')}</Text>
            <Action label={t('settings.mcp.connect_save')} disabled={busy} onPress={connectAndSave} />
            <Action label={t('common.cancel')} disabled={busy} onPress={goBack} />
          </View>
        ) : (
          <>
            {servers.length === 0 && !busy && <Text className="text-white">{t('settings.mcp.empty')}</Text>}
            {servers.map(server => (
              <View key={server.id} style={{ backgroundColor: '#1B1B1E', padding: 16, borderRadius: 8, gap: 12 }}>
                <View className="flex flex-row items-center justify-between" style={{ gap: 12 }}>
                  <View className="flex-1" style={{ gap: 4 }}>
                    <Text className="text-white text-lg font-medium">{server.name}</Text>
                    <Text numberOfLines={1} style={{ color: '#9F9FA0' }}>{server.url}</Text>
                    <Text style={{ color: '#9F9FA0' }}>{t('settings.mcp.tool_count', { count: server.tools.length })}</Text>
                  </View>
                  <View accessibilityLabel={t('settings.mcp.enable_server', { name: server.name })} pointerEvents={busy ? 'none' : 'auto'}>
                    <ToggleSwitch isOn={server.enabled} onToggle={() => toggle(server)} />
                  </View>
                </View>
                <View className="flex flex-row" style={{ gap: 16 }}>
                  <Action label={t('settings.mcp.edit_refresh')} disabled={busy} onPress={() => edit(server)} />
                  <Action label={t('common.delete')} disabled={busy} onPress={() => remove(server)} />
                </View>
              </View>
            ))}
            <Action label={t('settings.mcp.add')} disabled={busy} onPress={() => {
              setError('');
              setHeaders('{}');
              setDraft({ id: generateUUID(), name: '', url: '', enabled: true, tools: [] });
            }} />
            <Text style={{ color: '#9F9FA0' }} className="text-sm">{t('settings.mcp.tools_hint')}</Text>
          </>
        )}
      </ScrollView>
    </SafeView>
  );
}

function Field({ label, ...props }: { label: string; value: string; editable: boolean; onChangeText: (value: string) => void; placeholder?: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text className="text-white font-medium">{label}</Text>
      <TextInput {...props} accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} placeholderTextColor="#9F9FA0" style={{ backgroundColor: '#27282A', color: '#FFF', padding: 12, borderRadius: 8 }} />
    </View>
  );
}

function Action({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ backgroundColor: '#27282A', padding: 12, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}>
      <Text className="text-white font-medium text-center">{label}</Text>
    </TouchableOpacity>
  );
}
