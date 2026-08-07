export const PRIVATE_PATH_PATTERN = /^\/p\/[A-Za-z0-9_-]{43}$/;

export function shouldReplaceMissingSpace(status, requestedPath, rememberedPath) {
  return status === 401 && PRIVATE_PATH_PATTERN.test(requestedPath) && requestedPath === rememberedPath;
}
