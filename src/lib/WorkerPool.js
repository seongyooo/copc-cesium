/**
 * WorkerPool
 *
 * 고정 크기 Worker 풀. Promise 기반 run() API로 메시지를 보내고
 * 결과를 비동기로 받습니다. 유휴 Worker가 없으면 큐에서 대기합니다.
 */
export class WorkerPool {
  /**
   * @param {string|URL} workerUrl  Worker 스크립트 URL
   * @param {number}     size       풀 크기 (동시 실행 Worker 수)
   */
  constructor(workerUrl, size) {
    this._pending = new Map(); // id → { resolve, reject }
    this._counter = 0;
    this._idle    = [];
    this._queue   = [];

    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl, { type: 'module' });
      w.onmessage = ({ data }) => this._onResult(data, w);
      w.onerror   = (e) => console.error('[WorkerPool] Worker error:', e);
      this._idle.push(w);
    }
  }

  /**
   * Worker에 메시지를 보내고 결과를 Promise로 반환합니다.
   * @param {object}      msg         postMessage에 전달할 데이터
   * @param {Transferable[]} [transfer=[]]  Transferable 객체 목록
   */
  run(msg, transfer = []) {
    const id = String(++this._counter);
    return new Promise((resolve, reject) => {
      this._queue.push({ id, msg: { ...msg, id }, transfer, resolve, reject });
      this._flush();
    });
  }

  /** 모든 Worker를 종료합니다. */
  destroy() {
    this._idle.forEach(w => w.terminate());
    this._idle = [];
    // 대기 중인 작업은 reject
    for (const { reject } of this._queue) {
      reject(new Error('WorkerPool destroyed'));
    }
    this._queue = [];
  }

  _flush() {
    while (this._idle.length > 0 && this._queue.length > 0) {
      const worker              = this._idle.pop();
      const { id, msg, transfer, resolve, reject } = this._queue.shift();
      this._pending.set(id, { resolve, reject, worker });
      worker.postMessage(msg, transfer);
    }
  }

  _onResult({ id, error, ...data }, worker) {
    const pending = this._pending.get(id);
    if (!pending) return;
    this._pending.delete(id);
    this._idle.push(worker);
    if (error) pending.reject(new Error(error));
    else       pending.resolve(data);
    this._flush();
  }
}
