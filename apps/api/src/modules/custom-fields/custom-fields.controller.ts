import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CustomFieldKind } from '@prisma/client';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, MaxLength, MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { CustomFieldsService} from './custom-fields.service';
import { type CustomFieldInput, type CustomFieldOption, type RollupConfig } from './custom-fields.service';
import type { VisibilityRule } from './formula-evaluator';

class CreateFieldDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsEnum(CustomFieldKind) kind!: CustomFieldKind;
  @IsOptional() @IsArray() options?: CustomFieldOption[];
  @IsOptional() @IsInt() position?: number;
  @IsOptional() @IsBoolean() required?: boolean;
  /** kind=formula: required, the expression body. Parsed server-side. */
  @IsOptional() @IsString() @MaxLength(4096) formulaExpression?: string | null;
  /** kind=rollup: required, the aggregation config. Shape validated in svc. */
  @IsOptional() @IsObject() rollupConfig?: RollupConfig | null;
  /** Optional: hide this field from a task's editor list when the rule
   *  evaluates to false. Honored client-side AND server-side. */
  @IsOptional() @IsObject() visibilityRule?: VisibilityRule | null;
}

class UpdateFieldDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @IsEnum(CustomFieldKind) kind?: CustomFieldKind;
  @IsOptional() @IsArray() options?: CustomFieldOption[];
  @IsOptional() @IsInt() position?: number;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsString() @MaxLength(4096) formulaExpression?: string | null;
  @IsOptional() @IsObject() rollupConfig?: RollupConfig | null;
  @IsOptional() @IsObject() visibilityRule?: VisibilityRule | null;
}

class SetValueDto {
  /** Any JSON value — validated server-side by field kind. */
  value!: unknown;
}

class ValidateFormulaDto {
  @IsString() @MaxLength(4096) expression!: string;
}

class ValidateFormulaForFieldDto {
  /** Optional: when present, validate this expression instead of the
   *  field's stored expression. Lets the editor preview unsaved edits. */
  @IsOptional() @IsString() @MaxLength(4096) expression?: string;
}

@ApiTags('custom-fields')
@ApiBearerAuth()
@Controller()
export class CustomFieldsController {
  constructor(private readonly svc: CustomFieldsService) {}

  // Definitions
  @Get('projects/:projectId/custom-fields')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.svc.listForProject(actor, projectId);
  }

  @Post('projects/:projectId/custom-fields')
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: CreateFieldDto,
  ) {
    return this.svc.create(actor, projectId, dto as CustomFieldInput);
  }

  @Patch('custom-fields/:id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateFieldDto,
  ) {
    return this.svc.update(actor, id, dto as Partial<CustomFieldInput>);
  }

  @Delete('custom-fields/:id')
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.remove(actor, id);
  }

  /** Parse-only check used by the editor UI for live validation. */
  @Post('custom-fields/validate-formula')
  validateFormula(@Body() dto: ValidateFormulaDto) {
    return this.svc.validateFormula(dto.expression);
  }

  /**
   * Parse + evaluate the field's formula (or an override expression) against
   * the first available task in the project. Used by the editor's "Test
   * expression" button to surface a sampleResult preview.
   */
  @Post('custom-fields/:id/validate-formula')
  validateFormulaForField(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ValidateFormulaForFieldDto,
  ) {
    return this.svc.validateFormulaAgainstField(actor, id, dto.expression);
  }

  // Per-task values
  @Get('tasks/:taskId/custom-fields')
  listValues(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.svc.listValuesForTask(actor, taskId);
  }

  @Put('tasks/:taskId/custom-fields/:fieldId')
  setValue(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('fieldId', new ParseUUIDPipe()) fieldId: string,
    @Body() dto: SetValueDto,
  ) {
    return this.svc.setValue(actor, taskId, fieldId, dto.value);
  }

  @Delete('tasks/:taskId/custom-fields/:fieldId')
  clearValue(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('fieldId', new ParseUUIDPipe()) fieldId: string,
  ) {
    return this.svc.clearValue(actor, taskId, fieldId);
  }
}
