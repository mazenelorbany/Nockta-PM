import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class MagicLinkVerifyDto {
  @ApiProperty({ example: 'client@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: 'The raw token from the magic-link email' })
  @IsString()
  @MinLength(16)
  token!: string;
}
