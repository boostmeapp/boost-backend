/** What the caller asked for. Media can be toggled mid-call; this records intent. */
export enum CallType {
  Audio = 'audio',
  Video = 'video',
}

export enum CallStatus {
  Ringing = 'ringing',
  Active = 'active',
  Ended = 'ended',
  Missed = 'missed',
  Rejected = 'rejected',
  Cancelled = 'cancelled',
  Failed = 'failed',
}

export enum CallEndReason {
  HungUp = 'hung_up',
  Rejected = 'rejected',
  CancelledByCaller = 'cancelled_by_caller',
  RingTimeout = 'ring_timeout',
  NetworkFailure = 'network_failure',
  CalleeBusy = 'callee_busy',
  Blocked = 'blocked',
  AdminTerminated = 'admin_terminated',
}

/** Machine-readable `code` on call error responses, so the app can show the right copy. */
export enum CallErrorCode {
  CallingUnavailable = 'CALLING_UNAVAILABLE',
  AccountBanned = 'ACCOUNT_BANNED',
}

/** Stream user tokens: long enough to avoid mid-call expiry, short enough to bound a leak. */
export const STREAM_TOKEN_VALIDITY_SECONDS = 24 * 60 * 60;

/** Statuses a call can still leave. Everything else is terminal. */
export const LIVE_CALL_STATUSES: readonly CallStatus[] = [
  CallStatus.Ringing,
  CallStatus.Active,
];
