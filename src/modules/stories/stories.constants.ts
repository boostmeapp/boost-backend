/** Bull queue that carries the per-story expiry job. */
export const STORY_QUEUE = 'stories';

export enum StoryJobs {
  Expire = 'expire-story',
}

export interface ExpireStoryJob {
  storyId: string;
}

/** A story is live for 24 hours. */
export const STORY_TTL_HOURS = 24;
export const STORY_TTL_MS = STORY_TTL_HOURS * 60 * 60 * 1000;

/** A story clip is short-form; anything longer belongs in a post. */
export const MAX_STORY_VIDEO_SECONDS = 30;

/** S3 prefixes a story's media may live under (see UploadService). */
export const STORY_VIDEO_PREFIX = 'videos';
export const STORY_IMAGE_PREFIXES = ['thumbnails', 'chat'];
