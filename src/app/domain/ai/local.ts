/** Bytes of the two models Nexo downloads (Qwen3.5-9B and 4B, Q4_K_M), said before. */
export const MODEL_SIZES = { large: 5_680_522_464, small: 2_740_937_888 };

/** The model run inside Nexo, as the backend reports it. */
export interface LocalAiStatus {
  /** `cuda`, `vulkan`, `metal` or `cpu`. */
  backend: string;
  engine: boolean;
  /** An id of the catalog, `file` for one of the person's own, or none. */
  model?: string | null;
  modelName?: string | null;
  engineSize: number;
  modelSize: number;
  recommended?: string | null;
  /** `ai.local.why.*`, or the reason it does not fit. */
  reason?: string | null;
  devices: { id: string; name: string; totalMib: number; freeMib: number }[];
  device?: string | null;
  ramFreeMib: number;
  running: boolean;
  gpuLayers?: string | null;
  context?: number | null;
  installing: boolean;
  received: number;
  total: number;
  error?: string | null;
}

/** The local model can answer: an engine and a model are there. */
export const localReady = (status: LocalAiStatus | undefined) => !!status?.engine && !!status.model;

/** Bytes as people read them: `5.3 GB`, `39 MB`. */
export function byteSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
