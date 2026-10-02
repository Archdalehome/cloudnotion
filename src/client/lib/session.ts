/**
 * 登录后的「会话落地」检查。
 *
 * 登录接口返回 200 不等于浏览器真的把会话存下来了：无痕模式、被拦截的 Cookie、部分 App
 * 内嵌浏览器都会把 `Set-Cookie` 丢掉，「登录成功」的下一个请求就变成未登录 —— 手机上表现
 * 就是闪一下又回到登录页。所以登录成功后先自己问一次 `/api/session`：
 *
 *   1. 能看到自己 → 直接进工作区；
 *   2. 服务端明确说没登录 → 用同一个账号密码带 `tokenInBody` 再登一次，把令牌存到本地，
 *      之后所有请求都会自动带上 `Authorization` 头；
 *   3. 还是不行 → 留在登录页说明原因（而不是先闪进工作区再被踢回来）。
 *
 * 网络层面的失败（断网 / 5xx）也如实返回失败：宁可在登录页看到明确提示，也不要进到
 * 工作区才发现自己其实没登录。
 */
import { ApiError, api, setSessionToken, type SessionPayload } from '../api';

/** Cookie 没落地时再登一次用的凭据。 */
export interface SessionRetry {
  email: string;
  password: string;
}

export interface SessionLanding {
  /** 会话已经确认可用（可以进工作区） */
  ok: boolean;
  /** 落地失败时给用户看的原因 */
  message?: string;
  /** 是否用到了本地令牌兜底（说明这个浏览器把 Cookie 丢掉了） */
  usedToken?: boolean;
}

const COOKIE_BLOCKED =
  '登录成功，但浏览器没有保存登录状态：请在浏览器设置里允许本站使用 Cookie（无痕模式、被拦截的 Cookie 都会导致刚登录就被退回登录页）';
const TOKEN_REJECTED =
  '登录成功，但服务器没能确认这次会话：请重试一次，或换用系统浏览器（Safari / Chrome）打开';
const NETWORK_UNSTABLE = '登录成功，但没能连上服务器确认登录状态：网络似乎不稳定，请重试一次';

/** 问一次会话状态：`payload.user` 有值就是已登录，`null` 是服务端明确回答的「没登录」。 */
async function probe(): Promise<{ answered: boolean; payload: SessionPayload | null }> {
  try {
    return { answered: true, payload: await api.session() };
  } catch (cause) {
    // 401 也是「明确回答没登录」，只有断网 / 超时 / 5xx 才算没答上
    if (cause instanceof ApiError && cause.status === 401) return { answered: true, payload: null };
    return { answered: false, payload: null };
  }
}

/**
 * 确认这次登录真的落地了。返回 `ok: false` 时调用方应留在登录页并显示 `message`。
 *
 * `retry` 用同一份凭据再登一次（第一次登录的验证码 / 邀请已经开始消费，不能再走原接口，
 * 所以兜底统一走密码登录）。
 */
export async function confirmSessionLanded(retry: SessionRetry): Promise<SessionLanding> {
  const first = await probe();
  if (!first.answered) return { ok: false, message: NETWORK_UNSTABLE };
  if (first.payload?.user) return { ok: true };

  // 服务端明确说没登录 → Cookie 没落地，用响应体里的令牌兜底
  let token: string | null = null;
  try {
    const fallback = await api.login({ email: retry.email, password: retry.password, tokenInBody: true });
    token = fallback.session?.token ?? null;
  } catch {
    token = null;
  }
  setSessionToken(token);

  const second = await probe();
  if (!second.answered) return { ok: false, message: NETWORK_UNSTABLE, usedToken: token !== null };
  if (second.payload?.user) return { ok: true, usedToken: token !== null };
  return { ok: false, message: token ? TOKEN_REJECTED : COOKIE_BLOCKED, usedToken: token !== null };
}
