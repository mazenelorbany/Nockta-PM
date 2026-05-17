import { Module } from '@nestjs/common';
import { ElasticSearchService } from './elastic-search.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, ElasticSearchService],
  exports: [SearchService],
})
export class SearchModule {}
