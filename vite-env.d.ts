/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the deejai backend. Defaults to the "/deejai" dev proxy. */
  readonly VITE_DEEJAI_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
