(function configureTimingApi() {
  "use strict";

  const publishableKey = "sb_publishable_rEY1bSLnKyW4p84tVi4VJQ_Zkic_clr";
  const pageParams = new URLSearchParams(window.location.search);
  const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const isFileProtocol = window.location.protocol === "file:";
  const isLocalJudgeFile = isFileProtocol
    && /(?:^|\/)judge\.html$/i.test(window.location.pathname)
    && pageParams.get("livePreview") !== "1";
  const localApiOrigin = "http://localhost:8787";
  const isReadOnlyCloudPreview = (isFileProtocol && !isLocalJudgeFile)
    || (isLocalHost && pageParams.get("livePreview") === "1");
  const hostedApiOrigin = isReadOnlyCloudPreview
    ? "https://timing.hybridtraining.cn"
    : "";
  const apiOrigin = isLocalJudgeFile ? localApiOrigin : hostedApiOrigin;

  window.timingApiReadOnly = isReadOnlyCloudPreview;
  window.timingEnvironment = isLocalJudgeFile
    ? "development"
    : isReadOnlyCloudPreview
    ? "production-readonly"
    : isLocalHost || isFileProtocol
      ? "development"
      : "production";

  window.timingApiFetch = function timingApiFetch(input, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("apikey", publishableKey);
    const requestInput = typeof input === "string" && input.startsWith("/")
      ? `${apiOrigin}${input}`
      : input;
    const method = String(init.method || "GET").toUpperCase();
    const pathname = typeof input === "string"
      ? new URL(input, window.location.origin).pathname
      : "";
    const isReadOnlyAuthentication = method === "POST" && pathname === "/api/judge-auth";

    if (isReadOnlyCloudPreview && method !== "GET" && !isReadOnlyAuthentication) {
      return Promise.resolve(new Response(JSON.stringify({
        ok: false,
        error: "Local live preview is read-only"
      }), {
        status: 405,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      }));
    }
    return fetch(requestInput, { ...init, headers });
  };
})();
