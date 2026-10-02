/**
 * 邮件发送（Resend API）。
 *
 * 只需要一个 `RESEND_API_KEY`：`POST https://api.resend.com/emails`
 *   - secret 写入：`npx wrangler secret put RESEND_API_KEY`（本地开发放 `.dev.vars`）
 *   - 发件人：`RESEND_FROM_EMAIL`，默认 `Qafield <onboarding@resend.dev>`
 *     （用自备域名时改成自己的，例如 `Qafield <noreply@your-domain.com>`）
 *
 * 两种「不发真邮件」的情形都不会抛错，而是返回 `{ ok: false, reason: 'not_configured' }`，
 * 由调用方把确认码直接回显在响应里，这样本地开发和自动化测试都能跑通完整注册流程：
 *   1. 没有配置 `RESEND_API_KEY`（还没配 secret）；
 *   2. 收件人域在 `AUTH_ECHO_CODE_DOMAINS` 里（默认 example.com / test / invalid 这类**保留域**，
 *      永远收不到邮件，所以回显不会削弱真实邮箱的验证强度）。
 */
import { badGateway } from './http';
import type { Env } from './types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Qafield <onboarding@resend.dev>';

export type EmailResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'api_error'; detail: string };

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function appName(env: Env): string {
  return env.APP_NAME || 'Qafield';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 收件人是否属于「直接回显确认码」的域名（保留测试域）。 */
export function shouldEchoCode(env: Env, email: string): boolean {
  if (!env.RESEND_API_KEY) return true;
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return false;
  const allow = (env.AUTH_ECHO_CODE_DOMAINS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(domain);
}

export async function sendEmail(env: Env, message: EmailMessage): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, reason: 'not_configured', detail: '未配置 RESEND_API_KEY' };
  }

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || DEFAULT_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'api_error',
      detail: error instanceof Error ? error.message : '网络异常',
    };
  }

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: string; name?: string; error?: string };
      detail = parsed.message || parsed.error || parsed.name || detail;
    } catch {
      // 保留原始文本
    }
    console.error('Resend rejected the email:', response.status, detail);
    return { ok: false, reason: 'api_error', detail: `${response.status} ${detail}` };
  }
  return { ok: true };
}

/** 发不出邮件时的统一错误（调用方会先判断 `shouldEchoCode`）。 */
export function emailFailure(result: Extract<EmailResult, { ok: false }>): never {
  throw badGateway(`确认邮件发送失败：${result.detail}（请检查 RESEND_API_KEY 与 RESEND_FROM_EMAIL）`);
}

/* --------------------------------------------------------------- 邮件模板 */

const MAIL_PAGE = (app: string, body: string) => `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#29292a;">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e6e3;border-radius:14px;padding:24px;">
      <h1 style="margin:0 0 12px;font-size:18px;">${escapeHtml(app)}</h1>
      ${body}
    </div>
  </body>
</html>`;

/** 注册确认码邮件。 */
export function verificationCodeEmail(
  env: Env,
  input: { code: string; name: string; minutes: number },
): EmailMessage {
  const app = appName(env);
  const who = escapeHtml(input.name || '你好');
  const subject = `${app} 注册确认码：${input.code}`;
  const text = [
    `${input.name || '你好'}，`,
    '',
    `你的 ${app} 注册确认码是：${input.code}`,
    `${input.minutes} 分钟内有效，请在注册页面填入以完成注册。`,
    '',
    '如果不是你本人操作，忽略这封邮件即可。',
  ].join('\n');

  const html = MAIL_PAGE(
    app,
    `<p style="margin:0 0 16px;color:#6b6b68;font-size:13px;">完成注册的确认码</p>
      <p style="margin:0 0 8px;font-size:14px;">${who}，你好：</p>
      <p style="margin:0 0 12px;font-size:14px;">请把下面的确认码填回注册页面：</p>
      <p style="margin:0 0 16px;font-size:30px;letter-spacing:8px;font-weight:700;padding:12px 16px;background:#f2f2ef;border-radius:10px;text-align:center;">${input.code}</p>
      <p style="margin:0 0 8px;font-size:13px;color:#6b6b68;">确认码 ${input.minutes} 分钟内有效，超时后可以重新发送。</p>
      <p style="margin:0;font-size:13px;color:#6b6b68;">如果不是你本人操作，忽略这封邮件即可。</p>`,
  );

  return { to: '', subject, html, text };
}

/** 管理员重置密码后，把新密码通知给用户（尽力而为，失败不影响重置本身）。 */
export function passwordResetEmail(env: Env, input: { name: string; password: string }): EmailMessage {
  const app = appName(env);
  const who = escapeHtml(input.name || '你好');
  const subject = `${app} 密码已被管理员重置`;
  const text = [
    `${input.name || '你好'}，`,
    '',
    `你的 ${app} 登录密码已被管理员重置为：${input.password}`,
    '请尽快登录并在右上角「改密码」里换成你自己的密码。',
  ].join('\n');

  const html = MAIL_PAGE(
    app,
    `<p style="margin:0 0 12px;font-size:14px;">${who}，你好：</p>
      <p style="margin:0 0 12px;font-size:14px;">你的登录密码已被管理员重置，新的临时密码是：</p>
      <p style="margin:0 0 16px;font-size:22px;letter-spacing:3px;font-weight:700;padding:12px 16px;background:#f2f2ef;border-radius:10px;text-align:center;">${escapeHtml(input.password)}</p>
      <p style="margin:0;font-size:13px;color:#6b6b68;">登录后请尽快在「改密码」里换成你自己的密码。</p>`,
  );

  return { to: '', subject, html, text };
}
