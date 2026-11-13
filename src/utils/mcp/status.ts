import { type MCPStatus } from './types';

const IDLE: MCPStatus = { state: 'idle' };

class StatusStore {
  private values = new Map<string, MCPStatus>();
  private listeners = new Set<() => void>();

  get(id: string): MCPStatus {
    return this.values.get(id) ?? IDLE;
  }

  set(id: string, status: MCPStatus): void {
    this.values.set(id, status);
    this.emit();
  }

  remove(id: string): void {
    if (!this.values.delete(id)) return;
    this.emit();
  }

  reset(): void {
    if (this.values.size === 0) return;
    this.values.clear();
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const mcpStatus = new StatusStore();
