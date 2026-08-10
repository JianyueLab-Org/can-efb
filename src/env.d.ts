/// <reference types="astro/client" />

import type { SessionUser } from "@/server/canApi";

declare global {
  namespace App {
    interface Locals {
      /** 中间件从 can-api 解出来的成员；没登录是 null。 */
      user: SessionUser | null;
    }
  }
}

interface ImportMetaEnv {
  /** can-api 的 origin；SSR 和反代用。 */
  readonly PUBLIC_CAN_API_ORIGIN?: string;
  /** can-web 的 origin；只用来指登录页。 */
  readonly PUBLIC_CAN_WEB_ORIGIN?: string;
  /** 本站自己的 origin；写操作的 Origin 比对基准。 */
  readonly PUBLIC_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
