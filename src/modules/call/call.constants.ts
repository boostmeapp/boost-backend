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
  CannotCallSelf = 'CANNOT_CALL_SELF',
  /** Also returned for blocks, so a blocked caller cannot tell the difference. */
  UserUnavailable = 'USER_UNAVAILABLE',
  NotConnected = 'NOT_CONNECTED',
  CallingRestricted = 'CALLING_RESTRICTED',
}

/**
 * Why a call was refused, for logs and tests only. Never sent to the client:
 * Blocked and UserUnavailable must look identical from outside.
 */
export enum CallDenialReason {
  Self = 'self',
  CallerRestricted = 'caller_restricted',
  CalleeUnavailable = 'callee_unavailable',
  Blocked = 'blocked',
  NotConnected = 'not_connected',
}

/**
 * Who may call whom. A named policy rather than scattered conditionals, so the
 * rule is readable, testable, and relaxable without a rewrite.
 *
 * When on, only users who follow each other can call. Messaging history does
 * not count.
 */
export const CALL_POLICY = {
  requireMutualFollow: true,
};

/** Stream user tokens: long enough to avoid mid-call expiry, short enough to bound a leak. */
export const STREAM_TOKEN_VALIDITY_SECONDS = 24 * 60 * 60;

/** Statuses a call can still leave. Everything else is terminal. */
export const LIVE_CALL_STATUSES: readonly CallStatus[] = [
  CallStatus.Ringing,
  CallStatus.Active,
];
