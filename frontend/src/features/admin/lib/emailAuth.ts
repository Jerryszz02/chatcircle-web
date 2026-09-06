import { adminAuth, saveAdminEmailAuth, type ParticipantAuthResponse } from '../../../shared/auth';
import { apiPost } from '../../../shared/api/http';

const BASE = '/api/collections/admin_accounts';
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
// SDK 0.21 尚无 OTP 方法，使用服务端已启用的 PB 内置 HTTP 契约。
export function requestAdminOTP(email: string): Promise<{ otpId: string }> {
  return apiPost(adminAuth.client, `${BASE}/request-otp`, { email: normalizeEmail(email) });
}
export async function verifyAdminOTP(otpId: string, password: string): Promise<void> {
  const response = await apiPost<ParticipantAuthResponse>(adminAuth.client, `${BASE}/auth-with-otp`, {
    otpId,
    password,
  });
  saveAdminEmailAuth(response);
}
export function requestAdminEmail(email: string, mode: 'verify' | 'reset'): Promise<boolean> {
  const collection = adminAuth.client.collection('admin_accounts');
  return mode === 'verify'
    ? collection.requestVerification(normalizeEmail(email))
    : collection.requestPasswordReset(normalizeEmail(email));
}
export function confirmAdminEmail(token: string): Promise<boolean> {
  return adminAuth.client.collection('admin_accounts').confirmVerification(token);
}
export async function resetAdminPassword(token: string, password: string, confirm: string): Promise<void> {
  await adminAuth.client.collection('admin_accounts').confirmPasswordReset(token, password, confirm);
  adminAuth.logout();
}
