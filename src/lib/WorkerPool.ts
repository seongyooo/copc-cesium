/**
 * WorkerPool
 *
 * 고정 크기 Worker 풀. Promise 기반 run() API로 메시지를 보내고
 * 결과를 비동기로 받습니다. 유휴 Worker가 없으면 큐에서 대기합니다.
 */

export type WorkerResult = {
  posHigh: Float32Array;
  posLow: Float32Array;
  colors: Uint8Array;
  cls: Uint8Array;
  pointCount: number;
  sphereCenter: [number, number, number];
  sphereRadius: number;
  seenClasses: number[];
};

interface WorkerResponse extends Partial<WorkerResult> {
  id: string;
  error?: string;
}

interface PendingEntry {
  resolve: (val: WorkerResult) => void;
  reject: (err: Error) => void;
  worker: Worker;
}

interface QueueEntry {
  id: string;
  msg: Record<string, unknown>;
  transfer: Transferable[];
  resolve: (val: WorkerResult) => void;
  reject: (err: Error) => void;
}

export type WorkerCtor = new () => Worker;

export class WorkerPool {
  private _pending: Map<string, PendingEntry>;
  private _counter: number;
  private _idle: Worker[];
  private _queue: QueueEntry[];
  // shift() 대신 커서로 dequeue (O(n) → O(1)). _queue[0.._queueHead)는 이미 소비됨.
  private _queueHead: number;

  /**
   * @param WorkerCtor Vite `?worker&inline` 생성자 (Blob URL 기반이므로
   *                   정적 파일로 서빙되지 않아 MIME 타입 문제가 없음)
   * @param size       풀 크기 (동시 실행 Worker 수)
   */
  constructor(WorkerCtor: WorkerCtor, size: number) {
    this._pending   = new Map();
    this._counter   = 0;
    this._idle      = [];
    this._queue     = [];
    this._queueHead = 0;

    // B2: 재귀 재시도에 한도를 두어 Worker 오류 시 무한 루프 방지
    const createWorker = (retries = 3): Worker => {
      const w = new WorkerCtor();
      w.onmessage = ({ data }) => this._onResult(data, w);
      w.onerror = (e) => {
        console.error('[WorkerPool] Worker error:', e);
        // 이 Worker에 할당된 pending 작업 모두 reject
        for (const [id, p] of this._pending) {
          if (p.worker === w) {
            this._pending.delete(id);
            p.reject(new Error(`Worker crashed: ${e.message}`));
          }
        }
        // idle 목록에서 제거
        const idx = this._idle.indexOf(w);
        if (idx !== -1) this._idle.splice(idx, 1);
        // 재시도 한도 내에서만 교체 Worker 생성
        if (retries > 0) {
          this._idle.push(createWorker(retries - 1));
          this._flush();
        } else {
          console.error('[WorkerPool] Worker 복구 실패 — 재시도 한도 초과');
        }
      };
      return w;
    };

    for (let i = 0; i < size; i++) {
      this._idle.push(createWorker());
    }
  }

  /**
   * Worker에 메시지를 보내고 결과를 Promise로 반환합니다.
   * @param msg           postMessage에 전달할 데이터
   * @param transfer      Transferable 객체 목록
   * @param timeoutMs     응답 타임아웃 (ms). 초과 시 reject
   */
  run<T extends Record<string, unknown>>(msg: T, transfer: Transferable[] = [], timeoutMs = 30_000): Promise<WorkerResult> {
    const id = String(++this._counter);

    return new Promise((resolve, reject) => {
      let timerId: ReturnType<typeof setTimeout>;
      let settled = false;

      const settle = (fn: ((val: WorkerResult) => void) | ((err: Error) => void), val: WorkerResult | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timerId);
        (fn as (v: WorkerResult | Error) => void)(val);
      };

      this._queue.push({
        id,
        msg: { ...msg, id },
        transfer,
        resolve: (val) => settle(resolve, val),
        reject:  (err) => settle(reject, err),
      });
      this._flush();

      timerId = setTimeout(() => {
        if (this._pending.has(id)) {
          // pending에서 제거. 워커가 뒤늦게 응답하면 _onResult에서 idle 복귀됨
          this._pending.delete(id);
        } else {
          // 아직 큐에서 대기 중이면 제거 (미소비 구간 [_queueHead, length)에서만 탐색)
          for (let i = this._queueHead; i < this._queue.length; i++) {
            if (this._queue[i].id === id) { this._queue.splice(i, 1); break; }
          }
        }
        settle(reject, new Error(`Worker 응답 타임아웃 (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }

  /** 모든 Worker를 종료합니다. */
  destroy(): void {
    this._idle.forEach(w => w.terminate());
    this._idle = [];
    // 대기 중인(아직 디스패치되지 않은) 작업만 reject — 미소비 구간만 순회
    // (A-4: 이전에는 _queue만 처리, _pending 누락)
    for (let i = this._queueHead; i < this._queue.length; i++) {
      this._queue[i].reject(new Error('WorkerPool destroyed'));
    }
    this._queue     = [];
    this._queueHead = 0;
    // Worker에 이미 디스패치된 pending 작업도 reject
    for (const { reject } of this._pending.values()) {
      reject(new Error('WorkerPool destroyed'));
    }
    this._pending.clear();
  }

  private _flush(): void {
    while (this._idle.length > 0 && this._queueHead < this._queue.length) {
      const worker = this._idle.pop()!;
      const { id, msg, transfer, resolve, reject } = this._queue[this._queueHead++];
      this._pending.set(id, { resolve, reject, worker });
      worker.postMessage(msg, transfer);
    }
    // 큐가 완전히 소진되면 배열을 비워 메모리를 회수, 아니면 소비된 앞부분이
    // 과도하게 쌓였을 때만 압축(잦은 압축으로 인한 재할당 비용은 피함)
    if (this._queueHead === this._queue.length) {
      this._queue     = [];
      this._queueHead = 0;
    } else if (this._queueHead > 64 && this._queueHead * 2 > this._queue.length) {
      this._queue     = this._queue.slice(this._queueHead);
      this._queueHead = 0;
    }
  }

  private _onResult({ id, error, ...data }: WorkerResponse, worker: Worker): void {
    // 타임아웃으로 pending이 제거된 경우에도 워커는 항상 idle로 복귀
    this._idle.push(worker);
    this._flush();

    const pending = this._pending.get(id);
    if (!pending) return; // 이미 타임아웃 처리됨
    this._pending.delete(id);
    if (error) pending.reject(new Error(error));
    else       pending.resolve(data as WorkerResult);
  }
}
