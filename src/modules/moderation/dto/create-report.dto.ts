import { IsEnum, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ReportContentType,
  ReportReason,
} from '../../../database/schemas/report/report.schema';

export class CreateReportDto {
  @IsEnum(ReportContentType)
  contentType: ReportContentType;

  @IsMongoId()
  contentId: string;

  @IsEnum(ReportReason)
  reason: ReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}
