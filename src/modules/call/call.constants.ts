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
  CalleeBusy = 'CALLEE_BUSY',
  AlreadyInCall = 'ALREADY_IN_CALL',
  InvalidConversation = 'INVALID_CONVERSATION',
  CallFailed = 'CALL_FAILED',
  CallNotFound = 'CALL_NOT_FOUND',
  NotParticipant = 'NOT_PARTICIPANT',
  /** The call has already moved on, e.g. accepting a call that was cancelled. */
  CallAlreadyEnded = 'CALL_ALREADY_ENDED',
  /** A participant, but the wrong one — e.g. the caller trying to accept. */
  ActionNotAllowed = 'ACTION_NOT_ALLOWED',
  CallRateLimited = 'CALL_RATE_LIMITED',
  /** The callee has never run a build that can answer calls. */
  CalleeUnsupported = 'CALLEE_UNSUPPORTED',
  /** The callee's "Who can call me" is set to nobody. */
  CallsNotAccepted = 'CALLS_NOT_ACCEPTED',
  IllegalTransition = 'ILLEGAL_TRANSITION',
}

/**
 * The only legal status moves. Data, enforced in one place (applyTransition).
 * Terminal statuses map to nothing.
 */
export const CALL_TRANSITIONS: Readonly<Record<CallStatus, readonly CallStatus[]>> = {
  [CallStatus.Ringing]: [
    CallStatus.Active,
    CallStatus.Rejected,
    CallStatus.Cancelled,
    CallStatus.Missed,
    CallStatus.Failed,
  ],
  [CallStatus.Active]: [CallStatus.Ended, CallStatus.Failed],
  [CallStatus.Ended]: [],
  [CallStatus.Rejected]: [],
  [CallStatus.Cancelled]: [],
  [CallStatus.Missed]: [],
  [CallStatus.Failed]: [],
};

export const isTerminalStatus = (status: CallStatus): boolean =>
  CALL_TRANSITIONS[status].length === 0;

/** The reason recorded when a transition doesn't specify one. */
export const DEFAULT_END_REASON: Partial<Record<CallStatus, CallEndReason>> = {
  [CallStatus.Ended]: CallEndReason.HungUp,
  [CallStatus.Rejected]: CallEndReason.Rejected,
  [CallStatus.Cancelled]: CallEndReason.CancelledByCaller,
  [CallStatus.Missed]: CallEndReason.RingTimeout,
  [CallStatus.Failed]: CallEndReason.NetworkFailure,
};

/**
 * Which APNs environment the app build is signed for. Mirrors APNS_MODE in the
 * app's app.config.js: `development` only for development builds; staging,
 * TestFlight and App Store builds are all `production`.
 */
export enum ApnsEnvironment {
  Development = 'development',
  Production = 'production',
}

export const CALL_QUEUE = 'call';

export enum CallJobs {
  /** Delayed by the ring timeout; jobId is the call id, so it is deduped and cancellable. */
  RingTimeout = 'ring-timeout',
}

export interface RingTimeoutJob {
  callId: string;
}

/** Sweeper: a ringing call older than the timeout plus this is stuck. */
export const SWEEP_RINGING_GRACE_SECONDS = 60;
/** Sweeper: an active call answered longer ago than this is orphaned. Its duration is capped here. */
export const SWEEP_ACTIVE_MAX_SECONDS = 6 * 60 * 60;
/** Single-flight lock across API replicas. Shorter than the 5-minute interval. */
export const SWEEP_LOCK_TTL_SECONDS = 4 * 60;

/** Rate-limit window for CALL_MAX_PER_HOUR. */
export const CALL_RATE_WINDOW_SECONDS = 60 * 60;

/**
 * Repeat-rejection backoff: this many deliberate rejections of the same caller
 * by the same callee within the window blocks that caller → callee pair for
 * the backoff period. The highest-signal harassment pattern in 1:1 calling.
 */
export const REJECT_BACKOFF_THRESHOLD = 3;
export const REJECT_WINDOW_SECONDS = 60 * 60;
export const REJECT_BACKOFF_SECONDS = 60 * 60;

/** Answer-rate alert needs at least this many answerable calls in the hour to mean anything. */
export const ANSWER_RATE_ALERT_MIN_SAMPLE = 10;

/** Stream call type. `default` has ringing enabled — verified in the dashboard. */
export const STREAM_CALL_TYPE = 'default';

/** Per-user initiation lock. Covers busy-check-and-persist only, so a few seconds is ample. */
export const CALL_INIT_LOCK_TTL_SECONDS = 5;

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
  CallsNotAccepted = 'calls_not_accepted',
}

/** A user's "Who can call me" setting. */
export enum CallPrivacy {
  Everyone = 'everyone',
  /** The default — identical to the app-wide mutual-follow policy. */
  MutualFollows = 'mutual_follows',
  Nobody = 'nobody',
}

/** callingCapableAt is refreshed at most this often, so token refreshes aren't a write each. */
export const CALLING_CAPABLE_REFRESH_SECONDS = 24 * 60 * 60;

/** Quick issue chips on the post-call rating. */
export enum CallIssue {
  Audio = 'audio',
  Video = 'video',
  Dropped = 'dropped',
  Echo = 'echo',
  Other = 'other',
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
