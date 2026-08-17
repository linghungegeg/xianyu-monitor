/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_DEMO_MODE?: string
  readonly VITE_ADMIN_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
