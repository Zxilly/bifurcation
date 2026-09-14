"use client";

import { useSyncExternalStore } from "react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

const subscribe = () => () => {};
const serverSnapshot = () => false;

export function usePasskeySupport() {
  return useSyncExternalStore(subscribe, browserSupportsWebAuthn, serverSnapshot);
}
