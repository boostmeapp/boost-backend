import { IsString, MinLength } from 'class-validator';

export class AppleNotificationDto {
  /** Apple's signed JWT; its `events` claim carries the notification. */
  @IsString()
  @MinLength(20)
  payload: string;
}
