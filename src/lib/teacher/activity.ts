import { streamChat } from '../ai/client'

/** Portrait activity follows actual transport lifetimes, not local saving or a
 * simulated background teacher. Counts also handle overlapping requests safely. */
export class TeacherActivity {
  pending = 0
  constructor(private changed: (pending: number) => void = () => {}) {}
  begin = () => {
    this.pending++; this.changed(this.pending)
    let settled = false
    return () => { if (!settled) { settled = true; this.pending--; this.changed(this.pending) } }
  }
  async track<T>(request: () => Promise<T>): Promise<T> {
    const finish = this.begin()
    try { return await request() } finally { finish() }
  }
  transport: typeof streamChat = options => this.track(() => streamChat(options))
}
