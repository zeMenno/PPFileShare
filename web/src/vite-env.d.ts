/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL?: string;
  readonly VITE_SIGNALING_MODE?: 'ws' | 'http';
  readonly VITE_SIGNALING_HTTP_URL?: string;
  readonly VITE_ICE_SERVERS?: string;
}

/** Set at build time: "http" on Vercel builds, otherwise "ws". */
declare const __DEFAULT_SIGNALING_MODE__: string;
