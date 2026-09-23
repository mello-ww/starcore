import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Plain, non-secret local preferences - currently just the StarCore server
 * address the user connects to. Deliberately *not* SecureStore/Keychain:
 * that's reserved for the session token (see src/auth/session.ts), the one
 * thing on this device that actually needs OS-level encryption and
 * biometric gating. A server address is a convenience to remember, not a
 * secret to protect - see "Do not put ... server-specific paths ... into
 * the mobile source code" in the task brief, which this satisfies by never
 * hardcoding one at all: it's entered once by the person running the app
 * and kept only on their device.
 */
const SERVER_URL_KEY = 'starcore_server_url';

export async function getServerUrl(): Promise<string | null> {
  return AsyncStorage.getItem(SERVER_URL_KEY);
}

export async function setServerUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(SERVER_URL_KEY, url.trim().replace(/\/+$/, ''));
}

export async function clearServerUrl(): Promise<void> {
  await AsyncStorage.removeItem(SERVER_URL_KEY);
}
