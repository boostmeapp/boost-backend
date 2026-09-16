/**
 * Shared notification vocabulary. Mirrors the BOE backend's
 * `enums.constant.ts`, trimmed to what Boostra actually emits.
 */

export enum NotificationType {
  Follow = 'Follow',
  Like = 'Like',
  Comment = 'Comment',
  CommentLike = 'CommentLike',
  Coins = 'Coins',
  Boost = 'Boost',
  System = 'System',
}

export enum NotificationStatus {
  Scheduled = 'Scheduled',
  Sent = 'Sent',
  Failed = 'Failed',
  Skipped = 'Skipped',
}

export enum DevicePlatform {
  Ios = 'ios',
  Android = 'android',
  Web = 'web',
}

/** Bull queue names. */
export enum Queues {
  InstantNotification = 'instant-notification',
}

/** Bull job names within those queues. */
export enum QueueJobs {
  SendNotification = 'send-notification',
}

/**
 * Which notification types belong to the app's "Boosts" filter tab.
 */
export const BOOST_NOTIFICATION_TYPES = [
  NotificationType.Coins,
  NotificationType.Boost,
];
