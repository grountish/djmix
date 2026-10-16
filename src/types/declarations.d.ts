declare module '*.css';

declare module 'signalsmith-stretch' {
  export interface StretchChange {
    /** Audio-context time the change applies at. */
    output?: number;
    active?: boolean;
    /** Position in the loaded buffers, seconds. */
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    schedule(change: StretchChange): Promise<unknown>;
    addBuffers(buffers: Float32Array[], transfer?: Transferable[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    latency(): Promise<number>;
  }

  export default function SignalsmithStretch(
    context: BaseAudioContext,
    options?: AudioWorkletNodeOptions,
  ): Promise<StretchNode>;
}
