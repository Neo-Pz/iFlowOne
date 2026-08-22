/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IFLOW_SOURCE?: string
  readonly VITE_IFLOW_EDGE_URL?: string
  readonly VITE_IFLOW_EDGE_TOKEN?: string
  readonly VITE_IFLOW_MOCK_REPLAY_MS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
