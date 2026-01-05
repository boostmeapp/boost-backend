import { IsString, IsNotEmpty } from 'class-validator';

export class ConfirmUploadDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsString()
  @IsNotEmpty()
  key: string; // S3 key where file was uploaded
}
