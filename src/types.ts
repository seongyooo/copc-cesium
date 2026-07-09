export interface Ref<T> { value: T }

export interface CopcOptions {
  proj: string;
  projDef: string | null;
  geoidOffset: number;
  concurrency: number;
  maxCacheNodes: number;
  maxVisibleNodes: number;
  pixelSize: number;
  sseThreshold: number;
  zFactor: number;
  xyFactor?: number;
}

export interface ProgressInfo {
  depth: number;
  visible: number;
  culled: number;
  loading: number;
  points?: number;
  cached: number;
  height: number;
  seenClasses: Set<number>;
}

export interface CrsDetectionResult {
  proj: string;
  projDef: string | null;
  zFactor: number;
  xyFactor: number;
}

export interface NodeCacheEntry {
  collection: Renderable;
  pointCount: number;
  lastUsed: number;
  seenClasses: Set<number>;
}

// PointCloudPrimitive가 구현해야 하는 인터페이스
export interface Renderable {
  show: boolean;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface PresetConfig {
  label: string;
  pts?: string;
  url: string;
  proj?: string;
  projDef?: string;
  geoidOffset?: number;
  zFactor?: number;
}
