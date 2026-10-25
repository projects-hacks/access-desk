/** A sliding-window cap on how many bank writes the world makes per minute. */
export class CallBudget {
  private readonly at: number[] = [];

  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {}

  private prune() {
    const cutoff = this.now() - 60_000;
    while (this.at.length && this.at[0]! <= cutoff) this.at.shift();
  }

  /** Reserves `n` writes if the window has room. */
  take(n: number): boolean {
    this.prune();
    if (this.at.length + n > this.perMinute) return false;
    for (let i = 0; i < n; i++) this.at.push(this.now());
    return true;
  }

  used(): number {
    this.prune();
    return this.at.length;
  }
}
