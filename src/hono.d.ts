import type { SpaceRow } from "./types";

declare module "hono" {
  interface ContextVariableMap {
    space: SpaceRow;
    capability: string;
    requestId: string;
  }
}

export {};
