/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL?: string;
  readonly VITE_SIGNALING_MODE?: 'ws' | 'relay';
  /** Comma-separated wss:// MQTT broker URLs for relay signaling. */
  readonly VITE_RELAY_BROKERS?: string;
  readonly VITE_ICE_SERVERS?: string;
}

/** Set at build time: "relay" on Vercel builds, otherwise "ws". */
declare const __DEFAULT_SIGNALING_MODE__: string;
