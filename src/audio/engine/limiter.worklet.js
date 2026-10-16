// Lookahead brickwall limiter, linked across channels.
//
// Gain needed per sample -> minimum over the lookahead window (so the gain is already down when
// a peak arrives) -> instant attack / slow release -> moving average over the lookahead (a
// smooth ramp instead of a step). Audio is delayed by the lookahead, so the ramp completes
// before each peak leaves the delay line and no sample exceeds the ceiling.

const LOOKAHEAD_SECONDS = 0.005;
const RELEASE_SECONDS = 0.12;

class LookaheadLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ceilingDb = options?.processorOptions?.ceilingDb ?? -1.5;
    this.ceiling = Math.pow(10, ceilingDb / 20);
    this.length = Math.max(1, Math.round(LOOKAHEAD_SECONDS * sampleRate));
    this.release = 1 - Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
    this.delay = [];
    this.gains = new Float32Array(this.length).fill(1);
    this.gainSum = this.length;
    this.held = 1;
    this.position = 0;
    this.sample = 0;
    // Sliding minimum over the last length + 1 samples (monotonic deque).
    this.minIndex = new Float64Array(this.length + 2);
    this.minValue = new Float32Array(this.length + 2);
    this.minHead = 0;
    this.minCount = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    while (this.delay.length < output.length) this.delay.push(new Float32Array(this.length));

    const capacity = this.minIndex.length;
    for (let i = 0; i < output[0].length; i++) {
      let peak = 0;
      for (let c = 0; c < output.length; c++) {
        const channel = input && input.length ? input[c % input.length] : null;
        const x = channel ? channel[i] : 0;
        if (Math.abs(x) > peak) peak = Math.abs(x);
      }
      const required = peak > this.ceiling ? this.ceiling / peak : 1;

      while (this.minCount > 0 && this.minValue[(this.minHead + this.minCount - 1) % capacity] >= required) {
        this.minCount--;
      }
      const tail = (this.minHead + this.minCount) % capacity;
      this.minIndex[tail] = this.sample;
      this.minValue[tail] = required;
      this.minCount++;
      while (this.minIndex[this.minHead] < this.sample - this.length) {
        this.minHead = (this.minHead + 1) % capacity;
        this.minCount--;
      }
      const windowMin = this.minValue[this.minHead];

      this.held = windowMin < this.held ? windowMin : this.held + (windowMin - this.held) * this.release;
      this.gainSum += this.held - this.gains[this.position];
      this.gains[this.position] = this.held;
      const gain = this.gainSum / this.length;

      for (let c = 0; c < output.length; c++) {
        const channel = input && input.length ? input[c % input.length] : null;
        const line = this.delay[c];
        const delayed = line[this.position];
        line[this.position] = channel ? channel[i] : 0;
        output[c][i] = delayed * gain;
      }
      this.position = (this.position + 1) % this.length;
      this.sample++;
    }
    return true;
  }
}

registerProcessor('lookahead-limiter', LookaheadLimiter);
