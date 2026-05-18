import { forwardRef, Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { CommentsModule } from '../comments/comments.module';
import { TasksModule } from '../tasks/tasks.module';

import { ChatBindingController } from './chat-binding.controller';
import { ChatDispatcherService } from './chat-dispatcher.service';
import { ChatEventsController } from './chat-events.controller';
import { ChatEventsService } from './chat-events.service';
import { ChatService } from './chat.service';

@Module({
  // forwardRef on AiModule: ChatModule provides ChatService which AiModule
  // also imports (AiCronService sends standup cards). The inbound slash-
  // command path now needs AiSyncService.generateStandup, so the two modules
  // are mutually dependent. forwardRef lets Nest break the cycle at DI time.
  imports: [TasksModule, CommentsModule, forwardRef(() => AiModule)],
  controllers: [ChatBindingController, ChatEventsController],
  providers: [ChatService, ChatDispatcherService, ChatEventsService],
  exports: [ChatService],
})
export class ChatModule {}
