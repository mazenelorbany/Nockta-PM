import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshDto {
  @ApiProperty({ description: 'The opaque refresh token issued at login.' })
  @IsString()
  @MinLength(16)
  refreshToken!: string;
}
