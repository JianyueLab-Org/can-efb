/**
 * 会话。**这个站不验证会话，只转发凭据。**
 *
 * 之前这里是一个恒返回 null 的接缝；现在真的接上了 can-api，但接法刻意保持在
 * 「转发」这一侧：token 的格式、签名密钥和有效期都是 can-api 的，这个站从头到
 * 尾没有能力也没有必要自己解开它。中间件把 `/api/v1/auth/session` 的答案放进
 * `Astro.locals.user`，页面从那里读。
 *
 * 所以：**加一条 PROTECTED_PREFIXES 并不等于把那个页面保护起来了**。真正的判
 * 断在 can-api 那一头，中间件的重定向只是省掉一次「进去了才发现是空的」。
 */
import type { SessionUser } from "@/server/canApi";

export type { SessionUser };

/** 轨里账户区要的那点东西。 */
export interface EfbUser {
  /** 显示名；没有就退回用户名。 */
  name: string;
  /** ASN ID。 */
  id: string;
}

/** 把 can-api 的成员对象收成外壳要的形状。 */
export function toEfbUser(user: SessionUser | null): EfbUser | null {
  if (!user) return null;
  return { name: user.name || user.username, id: user.username };
}
