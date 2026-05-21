import type { AppSettings } from '@/types/settings.types';

const STORAGE_KEY = 'devforge_settings_v1';
const PASSPHRASE = 'devforge-settings-aes-v1';
const SALT = 'devforge-pbkdf2-salt-v1';

export const DEFAULT_SETTINGS: AppSettings = {
  azure: {
    subscriptionId: '',
    apps: [],
  },
  apiKeys: {
    pagespeedApiKey: '',
    anthropicApiKey: '',
    uptimeRobotApiKey: '',
  },
};

async function deriveKey(): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(PASSPHRASE), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(SALT), iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encrypt(plaintext: string): Promise<string> {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(encoded: string): Promise<string> {
  const key = await deriveKey();
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export async function loadSettings(): Promise<AppSettings> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const json = await decrypt(raw);
    const parsed = JSON.parse(json) as Partial<AppSettings>;
    return {
      azure: { ...DEFAULT_SETTINGS.azure, ...parsed.azure },
      apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...parsed.apiKeys },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const json = JSON.stringify(settings);
  const encrypted = await encrypt(json);
  localStorage.setItem(STORAGE_KEY, encrypted);
}
