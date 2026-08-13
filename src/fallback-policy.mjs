import {
  canonicalMethodName,
  isMultipartUploadRequest,
} from "./request-parsing.mjs";

// Служебные методы local/cloud Bot API, которые не отправляют пользовательский контент.
const localAdminMethods = new Set([
  "getMe",
  "getUpdates",
  "getWebhookInfo",
  "deleteWebhook",
]);

// Методы, которые можно повторить через cloud без тяжёлого файлового тела.
const safeCloudFallbackMethods = new Set([
  ...localAdminMethods,
  "getFile",
  "sendMessage",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "deleteMessage",
  "answerCallbackQuery",
  "sendChatAction",
  "setMyCommands",
  "deleteMyCommands",
  "setMyDescription",
  "setMyShortDescription",
  "setMyName",
  "setChatMenuButton",
]);

// Методы владения token/webhook всегда остаются на local upstream.
const localOnlyMethods = new Set([
  "close",
  "logOut",
  "logout",
  "setWebhook",
]);

export class FallbackPolicy {
  #cloudFallbackEnabled;
  #cloudGetUpdatesFallbackEnabled;
  #fileRouter;

  constructor({
    cloudFallbackEnabled,
    cloudGetUpdatesFallbackEnabled,
    fileRouter,
  }) {
    if (
      !fileRouter
      || typeof fileRouter.cloudFileFallbackDecision !== "function"
    ) {
      throw new TypeError("fileRouter.cloudFileFallbackDecision is required");
    }
    this.#cloudFallbackEnabled = cloudFallbackEnabled;
    this.#cloudGetUpdatesFallbackEnabled = cloudGetUpdatesFallbackEnabled;
    this.#fileRouter = fileRouter;
  }

  isSafeMethodForStatusFallback(method) {
    return safeCloudFallbackMethods.has(canonicalMethodName(method));
  }

  shouldRetryCloudAfterLocalStatus(method, statusCode) {
    const canonicalMethod = canonicalMethodName(method);
    if (
      (statusCode === 401 || statusCode === 404)
      && canonicalMethod !== "getUpdates"
    ) {
      return true;
    }
    if (canonicalMethod === "getFile" && statusCode === 400) return true;
    return false;
  }

  cloudFallbackPolicy(method, token, pathname = "", req = null) {
    const canonicalMethod = canonicalMethodName(method);
    if (!this.#cloudFallbackEnabled) {
      return { allowed: false, reason: "fallback-disabled" };
    }
    if (
      canonicalMethod === "getUpdates"
      && !this.#cloudGetUpdatesFallbackEnabled
    ) {
      return {
        allowed: false,
        reason: "cloud-getupdates-fallback-disabled",
      };
    }
    if (localOnlyMethods.has(canonicalMethod)) {
      return { allowed: false, reason: "local-only-method" };
    }
    if (req && isMultipartUploadRequest(req)) {
      return { allowed: false, reason: "multipart-upload-local-only" };
    }

    if (canonicalMethod !== "file") {
      if (safeCloudFallbackMethods.has(canonicalMethod)) {
        return { allowed: true, reason: "safe-method" };
      }
      return { allowed: true, reason: "default-non-file-method" };
    }

    return this.#fileRouter.cloudFileFallbackDecision(token, pathname);
  }

  canUseCloudFallback(method, token, pathname = "", req = null) {
    return this.cloudFallbackPolicy(
      method,
      token,
      pathname,
      req,
    ).allowed;
  }
}

export function createFallbackPolicy(options) {
  return new FallbackPolicy(options);
}
