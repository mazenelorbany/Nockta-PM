import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type VerifyCallback } from 'passport-google-oauth20';

import { Env } from '../../../config/env';

export interface GoogleProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  /** Workspace hosted-domain claim — must match GOOGLE_OAUTH_ALLOWED_DOMAIN. */
  hd?: string;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor() {
    super({
      clientID: Env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: Env.GOOGLE_OAUTH_CLIENT_SECRET,
      callbackURL: Env.GOOGLE_OAUTH_REDIRECT_URI,
      scope: ['email', 'profile'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: {
      id: string;
      emails?: { value: string; verified?: boolean }[];
      displayName: string;
      photos?: { value: string }[];
      _json?: { hd?: string };
    },
    done: VerifyCallback,
  ): Promise<void> {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      return done(new UnauthorizedException('Google profile has no email'), false);
    }

    const hd = profile._json?.hd;
    const allowedDomain = Env.GOOGLE_OAUTH_ALLOWED_DOMAIN;
    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (hd !== allowedDomain && emailDomain !== allowedDomain) {
      return done(
        new UnauthorizedException(
          `Only @${allowedDomain} accounts are allowed (got ${email})`,
        ),
        false,
      );
    }

    const result: GoogleProfile = {
      id: profile.id,
      email,
      name: profile.displayName,
      ...(profile.photos?.[0]?.value ? { avatarUrl: profile.photos[0].value } : {}),
      ...(hd ? { hd } : {}),
    };
    return done(null, result);
  }
}
