import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export enum SupportRequestType {
  REPORT = 'report',
  CONTACT = 'contact',
}

export class CreateSupportRequestDto {
  @IsEnum(SupportRequestType)
  type: SupportRequestType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}
