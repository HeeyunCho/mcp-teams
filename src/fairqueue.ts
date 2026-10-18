/**
 * A fixed number of slots shared fairly between sessions (2.4). Each session has its own
 * first-come line; a freed slot goes to the waiting session with the fewest slots in use, and
 * among equals to the one served longest ago. So a session with many calls (a long scan) can't
 * make another session's single call wait more than about one turn.
 *
 * Ported from mcp-newoutlook's src/fairqueue.ts. It only counts: callers handle their own
 * timeouts and cancellation (by leaving the line).
 */
export class FairQueue<K> {
  private _running = 0;
  /** Waiting work per session; the Map's order is the rotation (served sessions move to the end). */
  private lines = new Map<K, Array<() => void>>();
  /** Slots in use per session. */
  private using = new Map<K, number>();

  constructor(readonly max: number) {}

  /** Slots in use. */
  get running(): number {
    return this._running;
  }

  /** Work waiting for a slot, across sessions. */
  get waiting(): number {
    let n = 0;
    for (const line of this.lines.values()) n += line.length;
    return n;
  }

  /** Takes a free slot for `key` now, if there is one and nobody waits for it. */
  tryTake(key: K): boolean {
    if (this._running >= this.max || this.lines.size) return false;
    this._running++;
    this.using.set(key, (this.using.get(key) ?? 0) + 1);
    return true;
  }

  /** Joins `key`'s line; `go` runs once a slot is handed to it. Returns leave(): true if it was still waiting. */
  wait(key: K, go: () => void): () => boolean {
    let line = this.lines.get(key);
    if (!line) this.lines.set(key, (line = []));
    line.push(go);
    return () => {
      const l = this.lines.get(key);
      const i = l ? l.indexOf(go) : -1;
      if (i < 0) return false;
      l!.splice(i, 1);
      if (!l!.length) this.lines.delete(key);
      return true;
    };
  }

  /** Frees one of `key`'s slots and hands it to the next waiting work, if any. */
  release(key: K): void {
    const left = (this.using.get(key) ?? 1) - 1;
    if (left > 0) this.using.set(key, left);
    else this.using.delete(key);
    let next: [K, Array<() => void>] | undefined;
    let fewest = Infinity;
    for (const entry of this.lines) {
      const n = this.using.get(entry[0]) ?? 0;
      if (n < fewest) [next, fewest] = [entry, n];
    }
    if (!next) {
      this._running--;
      return;
    }
    const [k, line] = next;
    const go = line.shift()!;
    this.lines.delete(k);
    if (line.length) this.lines.set(k, line); // to the end of the rotation
    this.using.set(k, fewest + 1);
    go();
  }
}
