import { siteLabel } from "@jianyuelab-org/can-ui/sites";

/** 页面标题：`<页面> · <站名>`。站名取 can-ui 的 `siteLabel`。首页只有站名。 */
export function pageTitle(page: string | undefined, locale: string): string {
  const site = siteLabel(locale, "efb").name;
  return page ? `${page} · ${site}` : site;
}
