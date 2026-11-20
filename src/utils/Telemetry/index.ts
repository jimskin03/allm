/**
 * Usage and crash reporting used to leave the device through Firebase Analytics and Crashlytics.
 * That collection is removed. These methods stay so existing call sites compile, and they do not
 * record, print, or send anything.
 */
class Telemetry {
    CUSTOM_EVENTS = {
        ONBOARDING: {
            COMPLETED: 'onboarding_completed',
            SURVEY_RESPONSE: 'onboarding_survey_response',
        },
        ACTIONS: {
            WORKSPACE_CREATED: 'workspace_created',
            CHAT_COMPLETED: 'chat_completed',
            CHAT_ABORTED: 'chat_aborted',
            DOCUMENT_IMPORTED: 'document_added',
            IMAGE_ATTACHED: 'image_attached',
            CONTENT_SHARED: 'content_shared',
            HF_PULL_LINK_OPENED: 'hf_pull_link_opened',
            QUICK_CONTEXT_USED: 'quick_context_used',
            QUICK_CONTEXT_TOGGLED: 'quick_context_toggled',
            ASSISTANT_SETUP_OPENED: 'assistant_setup_opened',
            ASSISTANT_INVOKED: 'assistant_invoked',
            ASSISTANT_CHAT_SENT: 'assistant_chat_sent',
            ASSISTANT_PREFERENCE_TOGGLED: 'assistant_preference_toggled',
            ASSISTANT_THEME_CHANGED: 'assistant_theme_changed',
            TOOL_CALLED: 'tool_called',
            TOOL_ENABLED: 'tool_enabled',
            LLM_SETTINGS_UPDATED: 'llm_settings_updated',
            THREAD_EXPORTED: 'thread_exported',
            THREAD_FORKED: 'thread_forked',
            CHAT_DELETED: 'chat_deleted',
            CHAT_RETRIED: 'chat_retried',
            MEMORIES_ENABLED: 'memories_enabled',
            MEMORY_SAVED: 'memory_saved',
            SCHEDULED_JOB_CREATED: 'scheduled_job_created',
            SCHEDULED_JOB_RAN: 'scheduled_job_ran',
            REMINDER_SET: 'reminder_set',
            HIGHLIGHTS_VIEWED: 'highlights_viewed',
            EXTERNAL_CONNECTION_ESTABLISHED: 'external_connection_established',
            EXTERNAL_WORKSPACE_IMPORTED: 'external_workspace_imported',
        },
        DISABLED_TELEMETRY: 'disabled_telemetry',
    } as const;

    logEvent(_name: string, _params: Record<string, unknown> = {}) {}

    recordError(_error: Error, _context?: string) {}

    /**
     * Runs a llama.rn load. The Crashlytics keys that used to wrap this call are gone.
     */
    async trackNativeModelLoad<T>(
        _kind: string,
        _path: string,
        _details: Record<string, string | number | boolean>,
        load: () => Promise<T>,
    ): Promise<T> {
        return load();
    }

    async isEnabled(): Promise<boolean> {
        return false;
    }

    async setEnabled(_enabled: boolean): Promise<void> {}
}

const telemetry = new Telemetry();
export default telemetry;
