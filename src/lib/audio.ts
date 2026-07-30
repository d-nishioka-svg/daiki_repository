/**
 * Shared AudioContext for the scanner's feedback tones.
 *
 * Every beep used to construct its own AudioContext and never close it. Browsers
 * cap concurrent contexts per document (Chrome allows about six) and the
 * constructor throws once the cap is reached, so after a handful of scans all
 * audio feedback stopped — silently, because the throw was swallowed. In a
 * warehouse the beep is the operator's only confirmation that a tag was read.
 */
let sharedContext: AudioContext | null = null;

export const getAudioContext = (): AudioContext | null => {
  try {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!sharedContext) {
      sharedContext = new AudioContextClass();
    }

    // A context created before the first user gesture starts suspended and plays
    // nothing. Resuming is a no-op once the page has been interacted with.
    if (sharedContext.state === "suspended") {
      void sharedContext.resume();
    }

    return sharedContext;
  } catch (err) {
    console.warn("Audio feedback unavailable:", err);
    return null;
  }
};

/** Plays a single tone on the shared context. Never throws. */
export const playTone = (
  frequency: number,
  duration: number,
  options: { delay?: number; gain?: number; type?: OscillatorType } = {},
) => {
  const { delay = 0, gain = 0.08, type = "sine" } = options;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    const startAt = ctx.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gainNode.gain.setValueAtTime(gain, startAt);
    gainNode.gain.exponentialRampToValueAtTime(0.01, startAt + duration);

    oscillator.start(startAt);
    oscillator.stop(startAt + duration);
  } catch (err) {
    console.warn("Could not play feedback tone:", err);
  }
};
