import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { CommentTemplatesController } from './templates.controller';
import { CommentTemplatesService } from './templates.service';

@Module({
  controllers: [CommentsController, CommentTemplatesController],
  providers: [CommentsService, CommentTemplatesService],
  exports: [CommentsService, CommentTemplatesService],
})
export class CommentsModule {}
