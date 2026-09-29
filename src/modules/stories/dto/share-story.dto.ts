import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Send a story into one or more chats. */
export class ShareStoryDto {
  /** The people to send it to; a conversation is created where needed. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsMongoId({ each: true })
  userIds: string[];

  /** Optional note alongside the story. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;
}
