declare module '*.css';

declare module 'soundtouchjs' {
  export class SoundTouch {
    tempo: number;
    pitch: number;
    rate: number;
    virtualPitch: number;
    virtualRate: number;
    virtualTempo: number;

    constructor();
    clear(): void;
    flush(): void;
    putSamples(samples: Float32Array, position: number, numFrames: number): void;
    receiveSamples(output: Float32Array, maxSamples: number): number;
    get inputBuffer(): unknown;
    get outputBuffer(): unknown;
  }

  export interface FilterSource {
    extract(target: Float32Array, numFrames: number, position: number): number;
  }

  export class SimpleFilter {
    sourcePosition: number;

    constructor(source: FilterSource, soundTouch: SoundTouch);
    extract(target: Float32Array, numFrames: number): number;
  }
}
