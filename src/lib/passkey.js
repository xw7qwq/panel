import {
  WebAuthnAbortService,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  sendSignal,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { ApiError, sendJson } from './api.js';

// 浏览器端的通行密钥流程：向 Worker 要 options，交给浏览器或密码管理器签名，再把结果送回去验证。

export function passkeySupported() {
  return typeof window !== 'undefined' && browserSupportsWebAuthn();
}

export function autofillSupported() {
  return passkeySupported() ? browserSupportsWebAuthnAutofill() : Promise.resolve(false);
}

// 登录分两步：先要 options（服务端同时发 challenge Cookie），再交给浏览器签名并验证。
export async function passkeyLoginOptions() {
  return (await sendJson('/api/v1/auth/passkey/options')).data;
}

// 登录成功返回要跳去的路径。autofill 为 true 时挂在输入框的自动填充上，用户从下拉里选了通行密钥才会继续。
export async function signInWithPasskey(optionsJSON, { next, autofill = false }) {
  const response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
  const { data } = await sendJson('/api/v1/auth/passkey/verify', { body: { response, next } });
  return data.next;
}

export async function addPasskey() {
  const { data: optionsJSON } = await sendJson('/api/v1/me/passkeys/options');
  const response = await startRegistration({ optionsJSON });
  return (await sendJson('/api/v1/me/passkeys', { body: { response } })).data;
}

export async function removePasskey(id, rpID) {
  await sendJson(`/api/v1/me/passkeys?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  // 尽量让密码管理器也把它藏起来，不支持就算了。
  sendSignal({ signalName: 'unknownCredential', rpID, credentialID: id }).catch(() => {});
}

// 停掉正在等待的自动填充请求。
export function cancelPasskey() {
  WebAuthnAbortService.cancelCeremony();
}

// 把出错原因翻成一句中文。被新的请求打断返回空字符串，不用提示。
export function passkeyError(error) {
  if (error instanceof ApiError) return error.message;
  if (error?.name === 'AbortError' || error?.code === 'ERROR_CEREMONY_ABORTED') return '';
  if (error?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return '这个设备或密码管理器里已经有面板的通行密钥了。';
  if (error?.name === 'NotAllowedError') return '没有完成验证：取消了，或者等太久超时了。';
  if (error?.name === 'SecurityError') return '这个网址不能使用通行密钥，请从面板的正式地址打开。';
  return `通行密钥出错了：${error?.message || '未知错误'}`;
}
