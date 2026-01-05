import { IsEnum } from 'class-validator';
import { UploadType } from './request-upload.dto';

export class DirectUploadDto {
  @IsEnum(UploadType)
  type: UploadType;
}
