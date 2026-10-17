export interface OutputDevice {
  deviceId: string;
  label: string;
}

/** The entry that follows the system's default output. */
export const DEFAULT_OUTPUT: OutputDevice = { deviceId: 'default', label: 'System default' };

type SinkContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
  sinkId?: string;
};

/** Whether this browser can route an AudioContext to a chosen output. */
export function canSelectOutput(ctx: AudioContext): boolean {
  return typeof (ctx as SinkContext).setSinkId === 'function';
}

/**
 * Audio outputs the browser knows. Labels need a media permission in some browsers and come
 * back empty otherwise; those outputs are numbered instead.
 */
export async function listOutputDevices(): Promise<OutputDevice[]> {
  const devices: OutputDevice[] = [DEFAULT_OUTPUT];
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.enumerateDevices) return devices;
  let all: MediaDeviceInfo[];
  try {
    all = await media.enumerateDevices();
  } catch {
    return devices;
  }
  let unnamed = 0;
  for (const device of all) {
    if (device.kind !== 'audiooutput' || !device.deviceId || device.deviceId === 'default') continue;
    devices.push({ deviceId: device.deviceId, label: device.label || `Output ${++unnamed}` });
  }
  return devices;
}

/** Routes the context to `deviceId` ('default' for the system output). */
export async function applyOutputDevice(ctx: AudioContext, deviceId: string): Promise<void> {
  const sink = ctx as SinkContext;
  if (!sink.setSinkId) return;
  const target = deviceId === 'default' ? '' : deviceId;
  if ((sink.sinkId ?? '') === target) return;
  await sink.setSinkId(target);
}

export interface ContextInfo {
  sampleRate: number;
  /** Delay the browser's own processing adds, ms. */
  baseLatencyMs: number;
  /** Delay between the browser and the speakers, ms (0 when the browser can't say). */
  outputLatencyMs: number;
  state: AudioContextState;
}

export function describeContext(ctx: AudioContext): ContextInfo {
  return {
    sampleRate: ctx.sampleRate,
    baseLatencyMs: (ctx.baseLatency ?? 0) * 1000,
    outputLatencyMs: (ctx.outputLatency ?? 0) * 1000,
    state: ctx.state,
  };
}
