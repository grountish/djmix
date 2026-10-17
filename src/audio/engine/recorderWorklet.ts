/**
 * Ring-buffer recorder, as AudioWorklet source. Keeps the last `frames` frames of its input
 * per channel; on a 'dump' message it posts the most recent `seconds` (or everything it has)
 * in playback order, with the sample rate and the worklet clock time the dump ends at. It
 * outputs silence so that it stays on the destination's render path.
 */
export const RECORDER_WORKLET_SOURCE = `
class RingRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { frames, channels } = options.processorOptions;
    this.frames = frames;
    this.buffers = Array.from({ length: channels }, () => new Float32Array(frames));
    this.write = 0;
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'dump') this.dump(event.data.seconds, event.data.id);
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const n = input[0].length;
      for (let c = 0; c < this.buffers.length; c++) {
        const src = input[Math.min(c, input.length - 1)];
        const dst = this.buffers[c];
        for (let i = 0; i < n; i++) dst[(this.write + i) % this.frames] = src[i];
      }
      this.write = (this.write + n) % this.frames;
      this.filled = Math.min(this.frames, this.filled + n);
    }
    return true;
  }

  dump(seconds, id) {
    const wanted = seconds ? Math.round(seconds * sampleRate) : this.filled;
    const count = Math.min(this.filled, wanted);
    const start = (this.write - count + this.frames) % this.frames;
    const channels = this.buffers.map((buffer) => {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = buffer[(start + i) % this.frames];
      return out;
    });
    this.port.postMessage(
      { type: 'dump', id, sampleRate, endTime: currentTime, channels },
      channels.map((channel) => channel.buffer),
    );
  }
}

registerProcessor('ring-recorder', RingRecorder);
`;
