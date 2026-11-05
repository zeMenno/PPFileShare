/** Bytes per second over a short sliding window. */
export class SpeedMeter {
  #samples: { t: number; n: number }[] = [];

  constructor(private readonly windowMs = 3000) {}

  add(bytes: number) {
    const t = performance.now();
    this.#samples.push({ t, n: bytes });
    this.#trim(t);
  }

  rate(): number {
    const now = performance.now();
    this.#trim(now);
    if (!this.#samples.length) return 0;
    const total = this.#samples.reduce((s, x) => s + x.n, 0);
    const span = Math.max(500, now - this.#samples[0].t);
    return (total / span) * 1000;
  }

  #trim(now: number) {
    while (this.#samples.length && now - this.#samples[0].t > this.windowMs) this.#samples.shift();
  }
}
