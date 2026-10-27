/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_PLAYROOM_GAME_ID?: string;
  /** Optional TURN relay for proximity voice behind strict NATs: comma-separated urls, plus credentials. */
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USER?: string;
  readonly VITE_TURN_CRED?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
/** public path -> [content hash (10 hex), byte size]; injected by vite.config.ts */
declare const __ASSETS__: Record<string, [string, number]>;
declare const __BUILD_ID__: string;
