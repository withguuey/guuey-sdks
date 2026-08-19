/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional external-script hook (guuey#303): a URL loaded at boot — the
   * demo tour's bundle rides this in the demo apps; unset in customer
   * builds.
   */
  readonly VITE_DEMO_TOUR_SRC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
