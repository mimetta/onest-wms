import { getRequestConfig } from "next-intl/server";
import { getLocale } from "./locale";

export default getRequestConfig(async () => {
  const locale = await getLocale();

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    // Every timestamp in this system is stored as timestamptz; the warehouse
    // thinks in Bangkok time, so that is what gets rendered — never the
    // server's zone or the browser's.
    timeZone: "Asia/Bangkok",
  };
});
