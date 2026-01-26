import { IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @IsMongoId()
  videoId: string;

  @IsOptional()
  @IsMongoId()
  parentCommentId?: string;

  @IsString()
  @MaxLength(500)
  content: string;
}
