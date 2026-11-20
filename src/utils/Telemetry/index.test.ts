import Telemetry from '@/utils/Telemetry';

describe('Telemetry', () => {
  test('does not report events or errors', async () => {
    expect(await Telemetry.isEnabled()).toBe(false);
    expect(() => Telemetry.logEvent(Telemetry.CUSTOM_EVENTS.ACTIONS.CHAT_COMPLETED, { llmProvider: 'x' })).not.toThrow();
    expect(() => Telemetry.recordError(new Error('boom'), 'ctx')).not.toThrow();
    await expect(Telemetry.setEnabled(true)).resolves.toBeUndefined();
    expect(await Telemetry.isEnabled()).toBe(false);
  });

  test('trackNativeModelLoad only runs the loader', async () => {
    const load = jest.fn().mockResolvedValue('ready');
    await expect(Telemetry.trackNativeModelLoad('chat', '/models/a.gguf', { n_ctx: 512 }, load)).resolves.toBe('ready');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
