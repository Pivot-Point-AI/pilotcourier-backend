import logger from '../utils/logger';

// Settings the API cannot run safely without. Checked once at startup so a
// missing value stops the deploy instead of silently falling back to a default
// that is public (a JWT secret anyone can sign with, credentials in source).
const REQUIRED = ['MONGODB_URI', 'JWT_SECRET'] as const;

export const assertRequiredEnv = (): void => {
  const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const secret = process.env.JWT_SECRET as string;
  if (secret.length < 32 || /^your[\s_-]/i.test(secret) || /change[\s_-]?(me|this)/i.test(secret)) {
    logger.error(
      'JWT_SECRET looks like a placeholder or is shorter than 32 characters. Anyone who knows it can ' +
      'sign admin tokens. Set a long random value (e.g. `openssl rand -hex 48`) and restart.',
    );
  }
};

export const jwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
};
