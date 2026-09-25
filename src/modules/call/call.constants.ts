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

/** Statuses a call can still leave. Everything else is terminal. */
export const LIVE_CALL_STATUSES: readonly CallStatus[] = [
  CallStatus.Ringing,
  CallStatus.Active,
];
