const TIMEZONE_STEP_MS = 15 * 60 * 1_000;
const MAX_TIMEZONE_CORRECTION_MS = 14 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 2_000;
const REQUIRED_SHIFTED_SAMPLES = 3;

export type PocketClockResult = {
  accepted: boolean;
  calibrated: boolean;
  justCalibrated: boolean;
  normalizedTimestampMs: number | null;
  rawOffsetMs: number;
  normalizedOffsetMs: number | null;
  correctionMs: number | null;
};

function validLiveOffset(offsetMs: number, staleAfterMs: number): boolean {
  return offsetMs >= -MAX_FUTURE_SKEW_MS && offsetMs <= staleAfterMs;
}

/**
 * Pocket can encode its terminal wall-clock timezone into numeric timestamps.
 * This calibrator accepts only a stable, real-world timezone-sized shift and
 * keeps the normal freshness checks after converting that wall clock to UTC.
 */
export class PocketClock {
  private calibrated = false;
  private correction = 0;
  private candidateCorrection: number | null = null;
  private candidateSamples = 0;

  constructor(private readonly staleAfterMs: number) {}

  reset(): void {
    this.calibrated = false;
    this.correction = 0;
    this.candidateCorrection = null;
    this.candidateSamples = 0;
  }

  isCalibrated(): boolean {
    return this.calibrated;
  }

  correctionMs(): number | null {
    return this.calibrated ? this.correction : null;
  }

  normalize(rawTimestampMs: number, receivedAtMs: number): PocketClockResult {
    const rawOffsetMs = receivedAtMs - rawTimestampMs;

    if (this.calibrated) {
      const normalizedTimestampMs = rawTimestampMs - this.correction;
      const normalizedOffsetMs = receivedAtMs - normalizedTimestampMs;
      return {
        accepted: validLiveOffset(normalizedOffsetMs, this.staleAfterMs),
        calibrated: true,
        justCalibrated: false,
        normalizedTimestampMs,
        rawOffsetMs,
        normalizedOffsetMs,
        correctionMs: this.correction
      };
    }

    if (validLiveOffset(rawOffsetMs, this.staleAfterMs)) {
      this.calibrated = true;
      this.correction = 0;
      return {
        accepted: true,
        calibrated: true,
        justCalibrated: true,
        normalizedTimestampMs: rawTimestampMs,
        rawOffsetMs,
        normalizedOffsetMs: rawOffsetMs,
        correctionMs: 0
      };
    }

    const candidate =
      Math.round((rawTimestampMs - receivedAtMs) / TIMEZONE_STEP_MS) * TIMEZONE_STEP_MS;
    const candidateTimestampMs = rawTimestampMs - candidate;
    const candidateOffsetMs = receivedAtMs - candidateTimestampMs;
    const validCandidate =
      candidate !== 0 &&
      Math.abs(candidate) <= MAX_TIMEZONE_CORRECTION_MS &&
      validLiveOffset(candidateOffsetMs, this.staleAfterMs);

    if (!validCandidate) {
      this.candidateCorrection = null;
      this.candidateSamples = 0;
      return {
        accepted: false,
        calibrated: false,
        justCalibrated: false,
        normalizedTimestampMs: null,
        rawOffsetMs,
        normalizedOffsetMs: null,
        correctionMs: null
      };
    }

    if (this.candidateCorrection === candidate) this.candidateSamples += 1;
    else {
      this.candidateCorrection = candidate;
      this.candidateSamples = 1;
    }

    if (this.candidateSamples < REQUIRED_SHIFTED_SAMPLES) {
      return {
        accepted: false,
        calibrated: false,
        justCalibrated: false,
        normalizedTimestampMs: null,
        rawOffsetMs,
        normalizedOffsetMs: candidateOffsetMs,
        correctionMs: null
      };
    }

    this.calibrated = true;
    this.correction = candidate;
    this.candidateCorrection = null;
    this.candidateSamples = 0;
    return {
      accepted: true,
      calibrated: true,
      justCalibrated: true,
      normalizedTimestampMs: candidateTimestampMs,
      rawOffsetMs,
      normalizedOffsetMs: candidateOffsetMs,
      correctionMs: candidate
    };
  }
}
