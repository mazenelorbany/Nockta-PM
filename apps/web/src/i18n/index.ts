// =============================================================================
// i18n — i18next + react-i18next bootstrap (English-only).
//
// The framework is wired up so user-facing strings live in the locale file
// instead of being scattered across components. We ship only English today;
// future locales drop in as additional resource bundles without touching
// component code.
//
// Pattern in components:
//   const { t } = useTranslation();
//   <h1>{t('settings.profile.title', 'Profile')}</h1>
//
// The English literal is the fallback — if a key is missing the literal still
// renders.
// =============================================================================

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '../locales/en.json';

export const SUPPORTED_LOCALES = ['en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_STORAGE_KEY = 'nockta:locale';

/** Locales whose script renders right-to-left. Empty today; preserved for
 *  future RTL locales without code changes elsewhere. */
export const RTL_LOCALES: ReadonlySet<string> = new Set();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LOCALES as unknown as string[],
  react: { useSuspense: false },
  interpolation: { escapeValue: false },
  returnNull: false,
  returnEmptyString: false,
});

if (typeof document !== 'undefined') {
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
}

export default i18n;
