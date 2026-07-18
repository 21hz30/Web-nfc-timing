(function configureTimingApi() {
  "use strict";

  const publishableKey = "sb_publishable_rEY1bSLnKyW4p84tVi4VJQ_Zkic_clr";
  const hostedApiOrigin = window.location.protocol === "file:"
    ? "https://timing.hybridtraining.cn"
    : "";

  window.timingApiFetch = function timingApiFetch(input, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("apikey", publishableKey);
    const requestInput = typeof input === "string" && input.startsWith("/")
      ? `${hostedApiOrigin}${input}`
      : input;
    return fetch(requestInput, { ...init, headers });
  };
})();
