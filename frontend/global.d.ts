import type messages from "./messages/zh.json";

type Messages = typeof messages;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface IntlMessages extends Messages {}
}
