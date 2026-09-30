/**
 * 会话。**这个站不验证会话，只转发凭据。**
 *
 * token 的格式、签名密钥和有效期都是 can-api 的。中间件把
 * `/api/v1/auth/session` 的答案放进 `Astro.locals.user`，页面从那里读。
 *
 * **加一条重定向并不等于把那个页面保护起来了。** 真正的判断在 can-api 那一头。
 */
import type { FrameUser } from "@jianyuelab-org/can-ui/frame";
import type { SessionUser } from "@/server/canApi";

export type { SessionUser };

/** 把 can-api 的成员对象收成外壳要的形状。`rating` 只给菜单和 ⌘K 过滤用。 */
export function toFrameUser(user: SessionUser | null): FrameUser | null {
  if (!user) return null;
  return {
    name: user.name || user.username,
    id: user.username,
    rating: user.rating,
  };
}
