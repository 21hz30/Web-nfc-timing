(function configureTimingApi() {
  "use strict";

  const publishableKey = "sb_publishable_rEY1bSLnKyW4p84tVi4VJQ_Zkic_clr";
  const pageParams = new URLSearchParams(window.location.search);
  const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const isReadOnlyCloudPreview = window.location.protocol === "file:"
    || (isLocalHost && pageParams.get("livePreview") === "1");
  const hostedApiOrigin = isReadOnlyCloudPreview
    ? "https://timing.hybridtraining.cn"
    : "";

  window.timingApiReadOnly = isReadOnlyCloudPreview;
  window.timingEnvironment = isReadOnlyCloudPreview
    ? "production-readonly"
    : isLocalHost || window.location.protocol === "file:"
      ? "development"
      : "production";

  window.timingApiFetch = function timingApiFetch(input, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("apikey", publishableKey);
    const requestInput = typeof input === "string" && input.startsWith("/")
      ? `${hostedApiOrigin}${input}`
      : input;

    if (isReadOnlyCloudPreview && String(init.method || "GET").toUpperCase() !== "GET") {
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
