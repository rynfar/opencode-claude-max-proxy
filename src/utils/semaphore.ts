/**
 * Counting semaphore for concurrency control.
 *
 * Limits the number of concurrent operations. Callers that exceed the
 * limit are queued and resolved in FIFO order when a slot opens.
 */

export class Semaphore {
  private active = 0
  private readonly queue: Array<{ resolve: () => void }> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve })
    })
  }

  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) {
      this.active++
      next.resolve()
    }
  }

  get activeCount(): number {
    return this.active
  }

  get queueLength(): number {
    return this.queue.length
  }
}
