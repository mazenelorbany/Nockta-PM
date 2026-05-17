import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class MagicLinkRequestDto {
  @ApiProperty({ example: 'client@example.com' })
  @IsEmail()
  email!: string;
}
