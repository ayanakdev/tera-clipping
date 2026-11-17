import { EventEmitter } from 'node:events';
import type { AppEvents } from '../../shared/types';

class TypedBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    this.emitter.emit(event, payload);
    this.emitter.emit('*', event, payload);
  }

  on<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  onAny(listener: (event: string, payload: unknown) => void): () => void {
    const handler = (event: string, payload: unknown) => listener(event, payload);
    this.emitter.on('*', handler);
    return () => this.emitter.off('*', handler);
  }
}

export const bus = new TypedBus();
