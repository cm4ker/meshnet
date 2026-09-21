/**
 * What a link to a radio looks like from the protocol's side: whole frames in,
 * whole frames out, and a word when it drops. The shells supply these — Web
 * Bluetooth or Web Serial in a browser, the Tauri plugins on the desktop, the
 * Capacitor plugin on a phone — and nothing above this line knows which.
 */

export type TransportKind = "ble" | "serial" | "tcp";

export interface Transport {
  readonly kind: TransportKind;
  /** What the connect screen showed: a device name, a port, an address. */
  readonly label: string;
  /** One bare protocol frame, framed by the transport as the link needs. */
  send(frame: Uint8Array): Promise<void>;
  onFrame(listener: (frame: Uint8Array) => void): () => void;
  onClose(listener: (reason: Error | null) => void): () => void;
  close(): Promise<void>;
}

/**
 * The listener bookkeeping every transport needs, so each implements only the
 * link. `emitFrame` and `emitClose` are what the link's callbacks call.
 */
export abstract class BaseTransport implements Transport {
  abstract readonly kind: TransportKind;
  abstract readonly label: string;

  private frameListeners = new Set<(frame: Uint8Array) => void>();
  private closeListeners = new Set<(reason: Error | null) => void>();
  private closed = false;

  abstract send(frame: Uint8Array): Promise<void>;
  protected abstract shutdown(): Promise<void>;

  onFrame(listener: (frame: Uint8Array) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onClose(listener: (reason: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  protected emitFrame(frame: Uint8Array): void {
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch (error) {
        console.error("frame listener threw", error);
      }
    }
  }

  /** Idempotent: a link that drops and is then closed reports once. */
  protected emitClose(reason: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch (error) {
        console.error("close listener threw", error);
      }
    }
    this.frameListeners.clear();
    this.closeListeners.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.shutdown();
    } finally {
      this.emitClose(null);
    }
  }
}
