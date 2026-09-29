import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReplyToStoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  text: string;
}
