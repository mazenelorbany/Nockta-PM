import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Env } from '../config/env';
import { Public } from '../modules/auth/decorators/public.decorator';

/**
 * Public client-facing config endpoint. Returns the small subset of env
 * values that the SPA needs to render install URLs and feature flags
 * without baking secrets into the bundle.
 */
@ApiTags('config')
@Controller('config')
export class ConfigController {
  @Public()
  @Get()
  get(): {
    githubAppSlug: string | null;
    chatBindingEnabled: boolean;
    elasticSearchEnabled: boolean;
    devLoginEnabled: boolean;
  } {
    return {
      githubAppSlug: Env.GITHUB_APP_SLUG ?? null,
      chatBindingEnabled: Boolean(Env.GOOGLE_CHAT_APP_ID),
      elasticSearchEnabled: Boolean(Env.SEARCH_ELASTIC_URL),
      // Mirror the actual /auth/dev-login route's gate (Env.DEV_AUTH_ENABLED)
      // so the LoginPage UI and the route agree. Using NODE_ENV here would
      // hide the persona buttons on a production deploy even when an
      // operator has deliberately flipped DEV_AUTH_ENABLED=true to test
      // the first deploy before Google OAuth is wired.
      devLoginEnabled: Env.DEV_AUTH_ENABLED,
    };
  }
}
